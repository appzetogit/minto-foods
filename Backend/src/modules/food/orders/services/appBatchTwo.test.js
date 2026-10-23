import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { calculateOrder, createOrder, getOrderById } from './order.service.js';
import { sanitizeOrderForDeliveryPartner } from './order.helpers.js';
import { toOrder } from '../order.mapper.js';
import { saveRiderPosition } from '../../delivery/services/riderPosition.service.js';
import { getApprovedRestaurantByIdOrSlug, listApprovedRestaurants } from '../../restaurant/services/restaurant.service.js';
import { findApprovedRestaurant } from '../../restaurant/services/restaurantLookup.helper.js';
import { addAddress, listAddresses, updateAddress } from '../../user/services/userAddress.service.js';
import { getPublicFeeSettings, upsertFeeSettings } from '../../admin/services/adminPlatformSettings.service.js';
import { getPublicHomePromotionBanners } from '../../landing/services/homePromotionBanner.service.js';
import { createBroadcastNotification } from '../../admin/services/notificationBroadcast.service.js';
import { getInboxNotifications } from '../../../../core/notifications/notification.service.js';
import { listConversations, sendMessage } from '../../chat/services/chat.service.js';

/**
 * The second batch the apps rely on: old slugs after a rename, the address
 * "Save as" name, admin order limits, zone-wise banners, broadcast images,
 * rider positions and the ETA, chat polling, the receiver's name for riders,
 * and open restaurants listed first.
 *
 * Patch 20, split in two zones: zone A is the south half, zone B the north.
 */
const AREA = testPatch(20);
const ringFor = (latFrom, latTo) => [
    { latitude: latFrom, longitude: AREA.lng - 0.5 },
    { latitude: latFrom, longitude: AREA.lng + 0.5 },
    { latitude: latTo, longitude: AREA.lng + 0.5 },
    { latitude: latTo, longitude: AREA.lng - 0.5 },
];
const SOUTH = { lat: AREA.lat - 0.25, lng: AREA.lng };
const NORTH = { lat: AREA.lat + 0.25, lng: AREA.lng };

const created = { zones: [], restaurants: [], users: [], foods: [], partners: [], banners: [], admins: [], broadcasts: [], fees: [] };
let zoneA;
let zoneB;
let openKitchen;
let offKitchen;
let foodId;
let user;
let rider;
let globalFeeBefore = null;
let globalFeeCreated = null;

const makeRestaurant = async (data) => {
    const r = await prisma.foodRestaurant.create({
        data: {
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            isAcceptingOrders: true,
            outsideHoursOverride: true,
            ...data,
        },
    });
    created.restaurants.push(r.id);
    return r;
};

test.before(async () => {
    const tag = uniqueTag('B2');
    zoneA = await prisma.foodZone.create({ data: { name: `${tag} A`, coordinates: ringFor(AREA.lat - 0.5, AREA.lat), isActive: true } });
    zoneB = await prisma.foodZone.create({ data: { name: `${tag} B`, coordinates: ringFor(AREA.lat, AREA.lat + 0.5), isActive: true } });
    created.zones.push(zoneA.id, zoneB.id);

    // Bands reaching 30 km in zone A, so the list can price what it shows.
    const fees = await prisma.foodFeeSettings.create({ data: { zoneId: zoneA.id, isActive: true } });
    created.fees.push(fees.id);
    await prisma.deliveryFeeBand.create({ data: { feeSettingsId: fees.id, minDistanceKm: 0, maxDistanceKm: 30, fee: 20, feePerKm: 5 } });

    // The switched-off one is nearer, the open one a little further.
    offKitchen = await makeRestaurant({ restaurantName: `${tag} Off Kitchen`, zoneId: zoneA.id, latitude: SOUTH.lat, longitude: SOUTH.lng + 0.01, isAcceptingOrders: false });
    openKitchen = await makeRestaurant({ restaurantName: `${tag} Open Kitchen`, zoneId: zoneA.id, latitude: SOUTH.lat, longitude: SOUTH.lng + 0.03 });

    const food = await prisma.foodItem.create({
        data: { restaurantId: openKitchen.id, name: `${tag} Thali`, price: 200, approvalStatus: 'approved', isAvailable: true, preparationTime: '20 min' },
    });
    created.foods.push(food.id);
    foodId = food.id;
    user = await prisma.foodUser.create({ data: { name: `${tag} Arman`, phone: uniquePhone('7') } });
    created.users.push(user.id);
    rider = await prisma.foodDeliveryPartner.create({ data: { name: `${tag} Rider`, phone: uniquePhone('6'), status: 'approved' } });
    created.partners.push(rider.id);

    globalFeeBefore = await prisma.foodFeeSettings.findFirst({
        where: { zoneId: null, isActive: true },
        orderBy: { createdAt: 'desc' },
    });
    if (!globalFeeBefore) {
        globalFeeCreated = await prisma.foodFeeSettings.create({ data: { zoneId: null, isActive: true } });
    }
});

test.after(async () => {
    if (globalFeeBefore) {
        await prisma.foodFeeSettings.update({
            where: { id: globalFeeBefore.id },
            data: {
                codMaxOrderValue: globalFeeBefore.codMaxOrderValue,
                maxItemQuantity: globalFeeBefore.maxItemQuantity,
                deliveryFeeGstRate: globalFeeBefore.deliveryFeeGstRate,
            },
        });
    }
    if (globalFeeCreated) await prisma.foodFeeSettings.delete({ where: { id: globalFeeCreated.id } });

    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.foodChatMessage.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodChatConversation.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: [...created.users, ...created.partners] } } });
    await prisma.notificationBroadcast.deleteMany({ where: { id: { in: created.broadcasts } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrderNotification.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.homePromotionBanner.deleteMany({ where: { id: { in: created.banners } } });
    await prisma.userAddress.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodFeeSettings.deleteMany({ where: { id: { in: created.fees } } });
    await prisma.foodFeeSettings.deleteMany({ where: { zoneId: { in: created.zones } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.foodAdmin.deleteMany({ where: { id: { in: created.admins } } });
    await prisma.$disconnect();
});

const address = (over = {}) => ({
    label: 'Home',
    name: 'Arman',
    phone: '9811122233',
    street: '1 Batch Road',
    city: 'Bhiwandi',
    state: 'MH',
    zipCode: '421302',
    location: { type: 'Point', coordinates: [SOUTH.lng, SOUTH.lat] },
    ...over,
});

const order = (over = {}) => ({
    restaurantId: openKitchen.id,
    items: [{ itemId: foodId, name: 'Thali', price: 200, quantity: 1 }],
    address: address(),
    pricing: { subtotal: 200, total: 200 },
    paymentMethod: 'cash',
    ...over,
});

// ---- 1, 12: open restaurants first, then nearest ------------------------------

test('the list puts open restaurants before switched-off ones, nearest first, with distanceKm', async () => {
    const { restaurants } = await listApprovedRestaurants({ lat: SOUTH.lat, lng: SOUTH.lng, limit: 1000 });
    const ids = restaurants.map((r) => r.id);
    assert.ok(ids.includes(openKitchen.id) && ids.includes(offKitchen.id));
    assert.ok(ids.indexOf(openKitchen.id) < ids.indexOf(offKitchen.id), 'open first, though further away');
    const row = restaurants.find((r) => r.id === openKitchen.id);
    assert.ok(Number.isFinite(row.distanceKm) && row.distanceKm > 0);
    assert.ok('nextOpenAt' in row);
});

// ---- 2: a slug from before a rename -------------------------------------------

test('a restaurant still opens by the slug it had before a rename', async () => {
    const r = await makeRestaurant({ restaurantName: `Sdad ${uniqueTag('R')}` });
    const before = (await prisma.foodRestaurant.findUnique({ where: { id: r.id }, select: { nameSlug: true } })).nameSlug;
    await prisma.foodRestaurant.update({ where: { id: r.id }, data: { restaurantName: `Saad ${uniqueTag('R')}` } });

    assert.equal((await getApprovedRestaurantByIdOrSlug(before))?.id, r.id, 'detail by old slug');
    assert.equal((await findApprovedRestaurant(before))?.id, r.id, 'menu/addons/timings by old slug');
    const after = (await prisma.foodRestaurant.findUnique({ where: { id: r.id }, select: { nameSlug: true } })).nameSlug;
    assert.equal((await getApprovedRestaurantByIdOrSlug(after))?.id, r.id, 'and by the new one');
});

// ---- 4: "Save as" -------------------------------------------------------------

test("an address saved as \"Mom's house\" comes back with that name", async () => {
    const { address: saved } = await addAddress(user.id, {
        label: 'Other', customLabel: "Mom's house", street: '9 Lane', city: 'Bhiwandi', state: 'MH',
        latitude: SOUTH.lat, longitude: SOUTH.lng,
    });
    assert.equal(saved.label, 'Other');
    assert.equal(saved.customLabel, "Mom's house");
    const { addresses } = await listAddresses(user.id);
    assert.equal(addresses.find((a) => a.id === saved.id).customLabel, "Mom's house");

    // Made Home: no name of its own any more.
    const { address: home } = await updateAddress(user.id, saved.id, { label: 'Home' });
    assert.equal(home.customLabel, null);
});

// ---- 5: COD limit and quantity limit ------------------------------------------

test('the order limits reach the app and are enforced', async () => {
    const globalId = (globalFeeBefore || globalFeeCreated).id;
    await prisma.foodFeeSettings.update({ where: { id: globalId }, data: { codMaxOrderValue: 150, maxItemQuantity: 10 } });

    const { feeSettings } = await getPublicFeeSettings();
    assert.equal(feeSettings.codMaxOrderValue, 150);
    assert.equal(feeSettings.maxItemQuantity, 10);

    // 11 of one dish is refused by the quote and by the order.
    const eleven = [{ itemId: foodId, name: 'Thali', price: 200, quantity: 11 }];
    await assert.rejects(() => calculateOrder(user.id, { restaurantId: openKitchen.id, items: eleven }), /at most 10 of one item/);
    await assert.rejects(() => createOrder(user.id, order({ items: eleven, pricing: { subtotal: 2200, total: 2200 } })), /at most 10 of one item/);

    // A ₹200+ cash order is over the ₹150 COD limit.
    await assert.rejects(() => createOrder(user.id, order()), /Cash on Delivery is available only for orders below ₹150/);

    // A zone row does not take the limits: they are for every zone.
    await upsertFeeSettings({ zoneId: zoneB.id, codMaxOrderValue: 5, maxItemQuantity: 2 });
    const zoneRow = await prisma.foodFeeSettings.findFirst({ where: { zoneId: zoneB.id } });
    assert.equal(zoneRow.codMaxOrderValue, null);
    assert.equal(zoneRow.maxItemQuantity, 50);

    await prisma.foodFeeSettings.update({ where: { id: globalId }, data: { codMaxOrderValue: 0, maxItemQuantity: 50 } });
});

// ---- 6: zone-wise banners and placement ----------------------------------------

test('a zone-B banner does not show in zone A, and tracking banners stay on the tracking page', async () => {
    const make = async (data) => {
        const b = await prisma.homePromotionBanner.create({ data: { imageUrl: 'https://example.com/b.png', publicId: 'b', isActive: true, ...data } });
        created.banners.push(b.id);
        return b;
    };
    const everywhere = await make({ title: 'all zones' });
    const inA = await make({ title: 'zone A', zoneId: zoneA.id });
    const inB = await make({ title: 'zone B', zoneId: zoneB.id });
    const tracking = await make({ title: 'ad', zoneId: zoneA.id, placement: 'tracking' });

    const atA = new Set((await getPublicHomePromotionBanners({ lat: SOUTH.lat, lng: SOUTH.lng })).map((b) => b.id));
    assert.ok(atA.has(everywhere.id) && atA.has(inA.id));
    assert.ok(!atA.has(inB.id), 'zone B banner not in zone A');
    assert.ok(!atA.has(tracking.id), 'tracking ads are not on home');

    const atB = new Set((await getPublicHomePromotionBanners({ lat: NORTH.lat, lng: NORTH.lng })).map((b) => b.id));
    assert.ok(atB.has(inB.id) && !atB.has(inA.id));

    const ads = await getPublicHomePromotionBanners({ lat: SOUTH.lat, lng: SOUTH.lng, placement: 'tracking' });
    assert.deepEqual(ads.map((b) => b.id).filter((id) => created.banners.includes(id)), [tracking.id]);
    assert.equal(ads.find((b) => b.id === tracking.id).zoneId, zoneA.id, 'each banner says its zone');
});

// ---- 7: broadcast with a picture -------------------------------------------------

test('a broadcast image reaches the inbox, and only our uploads are accepted', async () => {
    const admin = await prisma.foodAdmin.create({ data: { name: 'B2 Admin', email: `${uniqueTag('a')}@admin.test`, password: 'x' } });
    created.admins.push(admin.id);
    const imageUrl = 'https://minto-media.s3.ap-south-1.amazonaws.com/food/notifications/x.png';

    const { broadcast } = await createBroadcastNotification({
        adminId: admin.id,
        body: {
            title: 'Diwali offer', message: 'Big picture inside', targetType: 'CUSTOM',
            targetIds: [user.id], targets: [{ ownerType: 'USER', ownerId: user.id }], imageUrl,
        },
    });
    created.broadcasts.push(broadcast.id);
    assert.equal(broadcast.imageUrl, imageUrl);

    const inbox = await getInboxNotifications({ ownerType: 'USER', ownerId: user.id });
    const item = inbox.items.find((i) => i.broadcastId === broadcast.id);
    assert.equal(item.metadata.imageUrl, imageUrl);
    assert.equal(item.imageUrl, imageUrl);

    await assert.rejects(() => createBroadcastNotification({
        adminId: admin.id,
        body: { title: 't', message: 'm', targetType: 'CUSTOM', targetIds: [user.id], targets: [{ ownerType: 'USER', ownerId: user.id }], imageUrl: 'javascript:alert(1)' },
    }), /uploaded picture/);
});

// ---- 8, 10, 11: a live order ---------------------------------------------------------

let liveOrderId;

test('a new order gets an ETA, and the rider position lands on it by order number', async () => {
    await prisma.foodFeeSettings.update({ where: { id: (globalFeeBefore || globalFeeCreated).id }, data: { codMaxOrderValue: 0 } });
    const { order: placed } = await createOrder(user.id, order({
        orderForSomeoneElse: true,
        recipient: { name: 'Raziya', phone: '9876543210' },
        address: address({ name: 'Raziya', phone: '9876543210', location: { type: 'Point', coordinates: [SOUTH.lng + 0.02, SOUTH.lat] } }),
    }));
    liveOrderId = placed._id || placed.id;

    // Computed in the background on placement.
    let row;
    for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        row = await prisma.foodOrder.findUnique({ where: { id: liveOrderId } });
        if (row.etaMinutes != null) break;
    }
    assert.ok(row.etaMinutes > 0, 'ETA without anyone typing it');
    assert.ok(row.estimatedDeliveryAt instanceof Date);
    const fetched = await getOrderById(liveOrderId, { userId: user.id });
    assert.equal(fetched.etaMinutes, row.etaMinutes);

    // A rider takes it, and pings with the MFB number.
    await prisma.foodOrder.update({
        where: { id: liveOrderId },
        data: { dispatchDeliveryPartnerId: rider.id, dispatchAcceptedAt: new Date(), orderStatus: 'picked_up', etaComputedAt: null },
    });
    await saveRiderPosition({ orderId: row.order_id, riderId: rider.id, lat: SOUTH.lat, lng: SOUTH.lng + 0.01 });
    let after;
    for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        after = await prisma.foodOrder.findUnique({ where: { id: liveOrderId } });
        if (after.etaComputedAt) break;
    }
    assert.equal(after.riderLat, SOUTH.lat);
    assert.ok(after.riderLocationAt instanceof Date);
    assert.ok(after.etaMinutes > 0, 'recomputed after pickup');
});

test('the rider sees the receiver everywhere, after pickup too', async () => {
    const row = await prisma.foodOrder.findUnique({ where: { id: liveOrderId }, include: { items: true, user: { select: { id: true, name: true, phone: true } } } });
    const view = sanitizeOrderForDeliveryPartner(toOrder(row));
    assert.equal(view.customerName, 'Raziya');
    assert.equal(view.user?.name ?? view.userId?.name, 'Raziya');
    assert.equal(view.deliveryAddress?.name, 'Raziya');
    // The account holder is named once, on purpose, as orderedBy ("ordered by
    // Arman"); nowhere else does the rider see that name.
    assert.deepEqual(view.orderedBy, { name: user.name });
    const { orderedBy, ...rest } = view;
    assert.ok(!JSON.stringify(rest).includes(user.name), "the account holder's name is not shown as the contact");
});

test('chat polling by order returns the latest messages', async () => {
    await sendMessage({ role: 'USER', id: user.id }, { orderId: liveOrderId, text: 'Ring the bell please' });
    await sendMessage({ role: 'DELIVERY_PARTNER', id: rider.id }, { orderId: liveOrderId, text: 'On my way' });

    const { conversations } = await listConversations({ role: 'USER', id: user.id }, { orderId: liveOrderId });
    const thread = conversations.find((c) => c.orderId === liveOrderId);
    assert.ok(thread, 'the order thread is listed');
    assert.deepEqual(thread.messages.map((m) => m.text), ['Ring the bell please', 'On my way']);
});
