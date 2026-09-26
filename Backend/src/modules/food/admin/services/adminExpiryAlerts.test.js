import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { runWithAdminScope } from '../../../../core/roles/adminScope.context.js';
import { getEndingSoon } from './adminExpiryAlerts.service.js';

/**
 * The admin bell's "ending soon" list. The example from the request: a banner
 * running 1-10 Oct is flagged from 7 Oct with the default 3 days.
 */
const HERE = testPatch(9);
const created = { banners: [], offerBanners: [], coupons: [], zones: [], restaurants: [] };
let tag;
let settingsRow;
let originalDays;
let zoneA;
let zoneB;
let restaurantInB;

const ist = (s) => new Date(`${s}+05:30`);
const NOW = ist('2026-10-07T10:00:00');
const SUPER = { adminType: 'super_admin' };

const promo = async (data) => {
    const row = await prisma.homePromotionBanner.create({
        data: { imageUrl: 'https://img/x.png', publicId: 'x', isActive: true, ...data, title: `${tag} ${data.title}` },
    });
    created.banners.push(row.id);
    return row;
};
const coupon = async ({ code, ...data }) => {
    const row = await prisma.foodOffer.create({
        data: { couponCode: `${tag}${code}`.toUpperCase().slice(0, 60), discountValue: 10, status: 'active', ...data },
    });
    created.coupons.push(row.id);
    return row;
};
const mine = (items) => items.filter((i) => String(i.title).includes(tag) || String(i.title).startsWith(tag.toUpperCase()));

test.before(async () => {
    tag = uniqueTag('Exp');
    settingsRow = (await prisma.foodBusinessSettings.findFirst()) ?? (await prisma.foodBusinessSettings.create({ data: {} }));
    originalDays = settingsRow.expiryAlertDays;
    await prisma.foodBusinessSettings.update({ where: { id: settingsRow.id }, data: { expiryAlertDays: 3 } });

    zoneA = await prisma.foodZone.create({ data: { name: `${tag} A`, coordinates: HERE.ring, isActive: true } });
    zoneB = await prisma.foodZone.create({ data: { name: `${tag} B`, coordinates: testPatch(10).ring, isActive: true } });
    created.zones.push(zoneA.id, zoneB.id);
    restaurantInB = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved', zoneId: zoneB.id },
    });
    created.restaurants.push(restaurantInB.id);
});

test.after(async () => {
    await prisma.foodBusinessSettings.update({ where: { id: settingsRow.id }, data: { expiryAlertDays: originalDays } });
    await prisma.homePromotionBanner.deleteMany({ where: { id: { in: created.banners } } });
    await prisma.foodOfferBanner.deleteMany({ where: { id: { in: created.offerBanners } } });
    await prisma.foodOffer.deleteMany({ where: { id: { in: created.coupons } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('a banner ending 10 Oct is flagged on 7 Oct, one ending 11 Oct is not yet', async () => {
    await promo({ title: 'ten', startDate: ist('2026-10-01T00:00:00'), endDate: ist('2026-10-10T23:59:59') });
    await promo({ title: 'eleven', endDate: ist('2026-10-11T23:59:59') });

    const { days, items } = await getEndingSoon(SUPER, NOW);
    const titles = mine(items).map((i) => i.title);
    assert.equal(days, 3);
    assert.ok(titles.includes(`${tag} ten`));
    assert.ok(!titles.includes(`${tag} eleven`));

    const ten = items.find((i) => i.title === `${tag} ten`);
    assert.equal(ten.daysLeft, 3);
    assert.equal(ten.endingLabel, 'ends in 3 days');
    assert.equal(ten.kind, 'promotion_banner');
    assert.equal(ten.path, '/admin/food/promotional-banner');
    assert.equal(ten.zoneName, 'All zones');
});

test('ended, switched-off and open-ended banners are not flagged', async () => {
    await promo({ title: 'ended', endDate: ist('2026-10-06T23:59:59') });
    await promo({ title: 'off', isActive: false, endDate: ist('2026-10-08T23:59:59') });
    await promo({ title: 'forever', endDate: null });

    const titles = mine((await getEndingSoon(SUPER, NOW)).items).map((i) => i.title);
    for (const t of ['ended', 'off', 'forever']) assert.ok(!titles.includes(`${tag} ${t}`), t);
});

test('ends today and tomorrow read naturally', async () => {
    await promo({ title: 'today', endDate: ist('2026-10-07T23:59:59') });
    await promo({ title: 'tomorrow', endDate: ist('2026-10-08T23:59:59') });
    const items = (await getEndingSoon(SUPER, NOW)).items;
    assert.equal(items.find((i) => i.title === `${tag} today`).endingLabel, 'ends today');
    assert.equal(items.find((i) => i.title === `${tag} tomorrow`).endingLabel, 'ends tomorrow');
});

test('the lead time follows the setting', async () => {
    await promo({ title: 'five', endDate: ist('2026-10-12T23:59:59') });
    let titles = mine((await getEndingSoon(SUPER, NOW)).items).map((i) => i.title);
    assert.ok(!titles.includes(`${tag} five`));

    await prisma.foodBusinessSettings.update({ where: { id: settingsRow.id }, data: { expiryAlertDays: 5 } });
    titles = mine((await getEndingSoon(SUPER, NOW)).items).map((i) => i.title);
    assert.ok(titles.includes(`${tag} five`));
    await prisma.foodBusinessSettings.update({ where: { id: settingsRow.id }, data: { expiryAlertDays: 3 } });
});

test('offer banners and admin coupons are included; restaurant coupons are not', async () => {
    const ob = await prisma.foodOfferBanner.create({
        data: { imageUrl: 'https://img/o.png', title: `${tag} offer`, isActive: true, endDate: ist('2026-10-09T23:59:59') },
    });
    created.offerBanners.push(ob.id);
    await coupon({ code: 'ADM', endDate: ist('2026-10-09T23:59:59') });
    await coupon({ code: 'RST', createdByRole: 'RESTAURANT', endDate: ist('2026-10-09T23:59:59') });
    await coupon({ code: 'PAUSED', status: 'paused', endDate: ist('2026-10-09T23:59:59') });

    const items = (await getEndingSoon(SUPER, NOW)).items;
    assert.ok(items.some((i) => i.kind === 'offer_banner' && i.title === `${tag} offer`));
    const codes = items.filter((i) => i.kind === 'coupon').map((i) => i.title);
    assert.ok(codes.includes(`${tag}ADM`.toUpperCase()));
    assert.ok(!codes.includes(`${tag}RST`.toUpperCase()));
    assert.ok(!codes.includes(`${tag}PAUSED`.toUpperCase()));
});

test('a sub-admin sees their zones and everyone-banners only', async () => {
    await promo({ title: 'zoneA', zoneId: zoneA.id, endDate: ist('2026-10-09T23:59:59') });
    await promo({ title: 'zoneB', zoneId: zoneB.id, endDate: ist('2026-10-09T23:59:59') });
    await coupon({ code: 'INB', restaurantScope: 'selected', restaurantIds: [restaurantInB.id], endDate: ist('2026-10-09T23:59:59') });
    await coupon({ code: 'ALLR', endDate: ist('2026-10-09T23:59:59') });

    const subAdmin = { adminType: 'sub_admin', permissions: { banner_management: ['view'], promotions_management: ['view'] } };
    const scope = { adminId: 'x', cityIds: [], cityNames: [], zoneIds: [zoneA.id] };
    const items = await runWithAdminScope(scope, () => getEndingSoon(subAdmin, NOW));
    const titles = items.items.map((i) => i.title);

    assert.ok(titles.includes(`${tag} zoneA`));
    assert.ok(!titles.includes(`${tag} zoneB`));
    assert.ok(titles.includes(`${tag} ten`), 'an all-zones banner is everyone\'s');
    assert.ok(!titles.includes(`${tag}INB`.toUpperCase()), 'a coupon for a restaurant in another zone');
    assert.ok(titles.includes(`${tag}ALLR`.toUpperCase()), 'a coupon for all restaurants');
    assert.equal(items.items.find((i) => i.title === `${tag} zoneA`).zoneName, `${tag} A`);
});

test('a sub-admin without banner or coupon access gets nothing of that kind', async () => {
    const couponsOnly = { adminType: 'sub_admin', permissions: { promotions_management: ['view'] } };
    const { items } = await getEndingSoon(couponsOnly, NOW);
    assert.ok(items.length > 0);
    assert.ok(items.every((i) => i.kind === 'coupon'));
});
