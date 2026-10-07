import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../utils/testIds.js';
import {
    requestRestaurantOtp,
    verifyRestaurantOtpAndLogin,
    requestDeliveryOtp,
    verifyDeliveryOtpAndLogin,
} from './auth.service.js';
import { assertRestaurantSignupOpen, assertDeliverySignupOpen } from './onboardingGate.js';
import {
    FEATURE_KEYS,
    ensureDefaultFeatureSettings,
    updateFeatureSetting,
} from '../../modules/food/admin/services/featureSettings.service.js';
import { createDeliveryPartnerByAdmin } from '../../modules/food/admin/controllers/adminDeliveryPartnerCreate.controller.js';

/**
 * The admin's switches for restaurant / rider self sign-up.
 * Off: an unknown number is "Account not found" (and costs no SMS); existing
 * accounts, approved or pending, are untouched.
 */
const created = { restaurants: [], partners: [], phones: [] };
let tag;

const setSwitch = (key, on) => updateFeatureSetting(key, { isEnabled: on });
const otpFor = async (phone) => (await prisma.foodOtp.findUnique({ where: { phone } }))?.otp;
const fresh = (prefix) => {
    const p = uniquePhone(prefix).replace(/\D/g, '').slice(-10);
    created.phones.push(p);
    return p;
};

test.before(async () => {
    tag = uniqueTag('Onb');
    await ensureDefaultFeatureSettings();
});

test.after(async () => {
    // Back to the shipped default: sign-up open.
    await setSwitch(FEATURE_KEYS.RESTAURANT_SELF_ONBOARDING, true);
    await setSwitch(FEATURE_KEYS.DELIVERY_SELF_ONBOARDING, true);
    await prisma.foodRefreshToken.deleteMany({ where: { userId: { in: [...created.restaurants, ...created.partners] } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodOtp.deleteMany({ where: { phone: { in: created.phones } } });
    await prisma.$disconnect();
});

const makeRestaurant = async (status = 'approved') => {
    const phone = fresh('9');
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} ${status}`, ownerName: 'Owner', ownerPhone: phone, status, ...(status === 'approved' ? { approvedAt: new Date() } : {}) },
    });
    created.restaurants.push(r.id);
    return { ...r, phone };
};

const makePartner = async (status = 'approved') => {
    const phone = fresh('8');
    const p = await prisma.foodDeliveryPartner.create({ data: { name: `${tag} rider`, phone, status } });
    created.partners.push(p.id);
    return p;
};

// ---- restaurants ------------------------------------------------------------

test('switch on: an unknown restaurant number gets an OTP and the sign-up form', async () => {
    await setSwitch(FEATURE_KEYS.RESTAURANT_SELF_ONBOARDING, true);
    const phone = fresh('9');
    await requestRestaurantOtp(phone);
    const result = await verifyRestaurantOtpAndLogin(phone, await otpFor(phone));
    assert.equal(result.needsRegistration, true);
    await assertRestaurantSignupOpen();
});

test('switch off: an unknown restaurant number is "Account not found" and no OTP is sent', async () => {
    await setSwitch(FEATURE_KEYS.RESTAURANT_SELF_ONBOARDING, false);
    const phone = fresh('9');
    await assert.rejects(() => requestRestaurantOtp(phone), (err) => err.statusCode === 404 && /Account not found/.test(err.message));
    assert.equal(await otpFor(phone), undefined, 'no OTP row, no SMS');
    await assert.rejects(() => assertRestaurantSignupOpen(), (err) => err.statusCode === 403);
});

test('switch off: an OTP sent while it was on still cannot open the sign-up form', async () => {
    await setSwitch(FEATURE_KEYS.RESTAURANT_SELF_ONBOARDING, true);
    const phone = fresh('9');
    await requestRestaurantOtp(phone);
    const otp = await otpFor(phone);
    await setSwitch(FEATURE_KEYS.RESTAURANT_SELF_ONBOARDING, false);
    await assert.rejects(() => verifyRestaurantOtpAndLogin(phone, otp), /Account not found/);
});

test('switch off: existing restaurants log in as before, pending ones still see pending', async () => {
    await setSwitch(FEATURE_KEYS.RESTAURANT_SELF_ONBOARDING, false);
    const approved = await makeRestaurant('approved');
    await requestRestaurantOtp(approved.phone);
    const ok = await verifyRestaurantOtpAndLogin(approved.phone, await otpFor(approved.phone));
    assert.ok(ok.accessToken);

    const pending = await makeRestaurant('pending');
    await requestRestaurantOtp(pending.phone);
    const pendingOtp = await otpFor(pending.phone);
    await assert.rejects(() => verifyRestaurantOtpAndLogin(pending.phone, pendingOtp), /pending approval/);
});

// ---- riders -----------------------------------------------------------------

test('rider switch on: unknown number goes to registration', async () => {
    await setSwitch(FEATURE_KEYS.DELIVERY_SELF_ONBOARDING, true);
    const phone = fresh('8');
    await requestDeliveryOtp(phone);
    const result = await verifyDeliveryOtpAndLogin(phone, await otpFor(phone));
    assert.equal(result.needsRegistration, true);
});

test('rider switch off: unknown number refused; existing riders unaffected', async () => {
    await setSwitch(FEATURE_KEYS.DELIVERY_SELF_ONBOARDING, false);
    const unknown = fresh('8');
    await assert.rejects(() => requestDeliveryOtp(unknown), (err) => err.statusCode === 404 && /join as a delivery partner/.test(err.message));
    assert.equal(await otpFor(unknown), undefined);
    await assert.rejects(() => assertDeliverySignupOpen(), (err) => err.statusCode === 403);

    const approved = await makePartner('approved');
    await requestDeliveryOtp(approved.phone);
    const ok = await verifyDeliveryOtpAndLogin(approved.phone, await otpFor(approved.phone));
    assert.ok(ok.accessToken);

    const pending = await makePartner('pending');
    await requestDeliveryOtp(pending.phone);
    const waiting = await verifyDeliveryOtpAndLogin(pending.phone, await otpFor(pending.phone));
    assert.equal(waiting.pendingApproval, true);
});

// ---- admin adds a rider --------------------------------------------------------

const callCreate = async (body) => {
    let status;
    let json;
    let error;
    const res = { status: (s) => ((status = s), res), json: (j) => ((json = j), res) };
    await createDeliveryPartnerByAdmin({ body, files: [], user: { userId: null } }, res, (e) => { error = e; });
    if (error) throw error;
    return { status, json };
};

test('an admin-added rider is approved and can log in while sign-up is off', async () => {
    await setSwitch(FEATURE_KEYS.DELIVERY_SELF_ONBOARDING, false);
    const phone = fresh('7');
    const { status, json } = await callCreate({
        name: `${tag} Admin Rider`,
        phone: `+91 ${phone}`,
        city: 'Bhiwandi',
        vehicleType: 'bike',
        vehicleNumber: `MH04${phone.slice(-6)}`,
        panNumber: 'abcde1234f',
        bankIfscCode: 'sbin0001234',
        bankAccountNumber: '123456789012',
    });
    assert.equal(status, 201);
    created.partners.push(json.data.id);
    const row = await prisma.foodDeliveryPartner.findUnique({ where: { id: json.data.id } });
    assert.equal(row.status, 'approved');
    assert.equal(row.phone, phone);
    assert.equal(row.panNumber, 'ABCDE1234F');
    assert.equal(row.bankIfscCode, 'SBIN0001234');
    assert.ok(row.approvedAt);

    await requestDeliveryOtp(phone);
    const login = await verifyDeliveryOtpAndLogin(phone, await otpFor(phone));
    assert.ok(login.accessToken);

    await assert.rejects(() => callCreate({ name: 'Dup', phone, city: 'Bhiwandi' }), /already exists/);
});

test('admin add refuses bad input', async () => {
    await assert.rejects(() => callCreate({ name: 'X', phone: '12345', city: 'Bhiwandi' }), /10-digit/);
    await assert.rejects(() => callCreate({ name: 'X', phone: fresh('7') }), /City is required/);
    await assert.rejects(() => callCreate({ name: 'X', phone: fresh('7'), city: 'B', bankIfscCode: 'BAD' }), /IFSC/);
});
