import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { createDeliveryPartnerByAdmin } from '../controllers/adminDeliveryPartnerCreate.controller.js';
import {
    deleteDeliveryPartnerPermanently,
    getDeliveryPartners,
    setDeliveryPartnerBlocked,
    updateDeliveryPartnerProfile,
} from './adminDeliveryPartner.service.js';

/**
 * Admin › Delivery partners: add (approved or pending, with a zone), edit,
 * block / unblock and delete.
 */
const HERE = testPatch(21);
const created = { zones: [], partners: [], orders: [], restaurants: [], users: [] };
let tag;
let zone;

const phone10 = () => uniquePhone('7').replace(/\D/g, '').slice(-10);

const callCreate = async (body) => {
    let status;
    let json;
    let error;
    const res = { status: (s) => ((status = s), res), json: (j) => ((json = j), res) };
    await createDeliveryPartnerByAdmin({ body, files: [], user: { userId: null } }, res, (e) => { error = e; });
    if (error) throw error;
    if (json?.data?.id) created.partners.push(json.data.id);
    return { status, json };
};

test.before(async () => {
    tag = uniqueTag('ARd');
    zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);
});

test.after(async () => {
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('add a rider approved with a zone, or pending when the box is unticked', async () => {
    const approved = await callCreate({
        name: `${tag} Approved`, phone: phone10(), city: 'Indore', zoneId: zone.id, vehicleType: 'bike',
    });
    assert.equal(approved.status, 201);
    let row = await prisma.foodDeliveryPartner.findUnique({ where: { id: approved.json.data.id } });
    assert.equal(row.status, 'approved');
    assert.equal(row.zoneId, zone.id);

    const pending = await callCreate({ name: `${tag} Pending`, phone: phone10(), city: 'Indore', approveNow: 'false' });
    row = await prisma.foodDeliveryPartner.findUnique({ where: { id: pending.json.data.id } });
    assert.equal(row.status, 'pending');
    assert.match(pending.json.message, /pending/);

    await assert.rejects(
        () => callCreate({ name: `${tag} Dup`, phone: approved.json.data.phone, city: 'Indore' }),
        /already exists/,
    );
    await assert.rejects(() => callCreate({ name: `${tag} Bad`, phone: '12345', city: 'Indore' }), /10-digit/);
});

test('edit zone, vehicle and bank details; bad values are refused', async () => {
    const { json } = await callCreate({ name: `${tag} Edit`, phone: phone10(), city: 'Indore' });
    const id = json.data.id;

    await updateDeliveryPartnerProfile(id, {
        zoneId: zone.id, vehicleType: 'scooter', vehicleNumber: 'mp09 ab 1234',
        bankAccountNumber: '123456789012', bankIfscCode: 'sbin0001234', upiId: 'rider@okaxis',
    });
    const row = await prisma.foodDeliveryPartner.findUnique({ where: { id } });
    assert.equal(row.zoneId, zone.id);
    assert.equal(row.vehicleType, 'scooter');
    assert.equal(row.vehicleNumber, 'MP09AB1234');
    assert.equal(row.bankIfscCode, 'SBIN0001234');

    await assert.rejects(() => updateDeliveryPartnerProfile(id, { bankIfscCode: 'nope' }), /IFSC/);
    await assert.rejects(() => updateDeliveryPartnerProfile(id, { vehicleType: 'truck' }), /bike, scooter/);

    const list = await getDeliveryPartners({ zoneId: zone.id, limit: 50 });
    const mine = list.deliveryPartners.find((p) => p.id === id);
    assert.equal(mine.zoneName, `${tag} Zone`);
});

test('block signs the rider out and keeps them listed; unblock lets them back', async () => {
    const { json } = await callCreate({ name: `${tag} Block`, phone: phone10(), city: 'Indore' });
    const id = json.data.id;
    const before = await prisma.foodDeliveryPartner.findUnique({ where: { id } });

    await setDeliveryPartnerBlocked(id, true);
    let row = await prisma.foodDeliveryPartner.findUnique({ where: { id } });
    assert.equal(row.status, 'deactivated');
    assert.equal(row.tokenVersion, before.tokenVersion + 1, 'signed out');
    const blocked = await getDeliveryPartners({ status: 'blocked', search: `${tag} Block` });
    assert.ok(blocked.deliveryPartners.some((p) => p.id === id && p.isBlocked));

    await setDeliveryPartnerBlocked(id, false);
    row = await prisma.foodDeliveryPartner.findUnique({ where: { id } });
    assert.equal(row.status, 'approved');
    await assert.rejects(() => setDeliveryPartnerBlocked(id, false), /not blocked/);
});

test('delete removes a rider with no orders; one with orders can only be blocked', async () => {
    const fresh = await callCreate({ name: `${tag} Fresh`, phone: phone10(), city: 'Indore' });
    await deleteDeliveryPartnerPermanently(fresh.json.data.id);
    assert.equal(await prisma.foodDeliveryPartner.findUnique({ where: { id: fresh.json.data.id } }), null);

    const busy = await callCreate({ name: `${tag} Busy`, phone: phone10(), city: 'Indore' });
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);
    const user = await prisma.foodUser.create({ data: { name: `${tag} U`, phone: uniquePhone('5') } });
    created.users.push(user.id);
    const order = await prisma.foodOrder.create({
        data: {
            userId: user.id, restaurantId: restaurant.id, orderStatus: 'delivered',
            dispatchStatus: 'accepted', dispatchDeliveryPartnerId: busy.json.data.id,
            addrStreet: '1 St', addrCity: 'Indore', addrState: 'MP', subtotal: 100, total: 100, paymentMethod: 'cash',
        },
    });
    created.orders.push(order.id);
    await assert.rejects(() => deleteDeliveryPartnerPermanently(busy.json.data.id), /can only be blocked/);
});
