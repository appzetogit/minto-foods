import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../utils/testIds.js';
import { getInboxNotifications } from './notification.service.js';
import { dropOtherZoneCustomers } from '../../modules/food/admin/services/notificationBroadcast.service.js';

// Two far-apart zones; a restaurant in "Indore" and customers on either side.
const ring = (lat, lng) => [
    { latitude: lat, longitude: lng }, { latitude: lat, longitude: lng + 0.1 },
    { latitude: lat + 0.1, longitude: lng + 0.1 }, { latitude: lat + 0.1, longitude: lng },
];
const INDORE = [22.70, 75.80];
const BHIWANDI = [19.25, 73.03];
const ids = { zones: [], restaurants: [], users: [] };

test.after(async () => {
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: ids.users } } });
    await prisma.userAddress.deleteMany({ where: { userId: { in: ids.users } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: ids.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: ids.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: ids.zones } } });
    await prisma.$disconnect();
});

const setup = async () => {
    const zone = await prisma.foodZone.create({ data: { name: uniqueTag('Indore'), country: 'India', coordinates: ring(...INDORE) } });
    ids.zones.push(zone.id);
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: uniqueTag('R'), ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved', zoneId: zone.id },
    });
    ids.restaurants.push(r.id);
    const user = async (at) => {
        const u = await prisma.foodUser.create({ data: { phone: uniquePhone('8') } });
        ids.users.push(u.id);
        if (at) await prisma.userAddress.create({ data: { userId: u.id, street: 's', city: 'c', state: 'st', latitude: at[0] + 0.05, longitude: at[1] + 0.05 } });
        return u;
    };
    return { link: `/restaurant-detail/${r.id}`, user };
};

test('the inbox hides a restaurant offer from another zone, by where the customer is', async () => {
    const { link, user } = await setup();
    const u = await user(null);
    await prisma.foodNotification.createMany({ data: [
        { ownerType: 'USER', ownerId: u.id, title: 'offer', message: 'm', link },
        { ownerType: 'USER', ownerId: u.id, title: 'general', message: 'm', link: '' },
    ] });
    const inbox = (at) => getInboxNotifications({ ownerType: 'USER', ownerId: u.id, lat: at?.[0] && at[0] + 0.05, lng: at?.[1] && at[1] + 0.05 });

    const away = await inbox(BHIWANDI);
    assert.deepEqual(away.items.map((n) => n.title), ['general']);
    assert.equal(away.unreadCount, 1);
    assert.equal((await inbox(INDORE)).items.length, 2);
    assert.equal((await inbox(null)).items.length, 2, 'no location: nothing hidden');
});

test('a restaurant broadcast skips customers whose addresses are all in other zones', async () => {
    const { link, user } = await setup();
    const [here, there, unknown] = [await user(INDORE), await user(BHIWANDI), await user(null)];
    const t = (u) => ({ ownerType: 'USER', ownerId: u.id });
    const targets = [t(here), t(there), t(unknown), { ownerType: 'RESTAURANT', ownerId: 'x' }];

    const kept = await dropOtherZoneCustomers(targets, link);
    assert.deepEqual(kept.map((k) => k.ownerId), [here.id, unknown.id, 'x']);
    assert.equal((await dropOtherZoneCustomers(targets, '/offers')).length, 4, 'not a restaurant link: everyone');
});
