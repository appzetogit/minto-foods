import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import { sendOrderAlerts } from './orderAlerts.service.js';
import { getOrderById } from './order.service.js';

const ids = { orders: [], rider: null, user: null, restaurant: null };
test.after(async () => {
  await prisma.foodOrder.deleteMany({ where: { id: { in: ids.orders } } });
  if (ids.user) await prisma.foodUser.delete({ where: { id: ids.user } });
  if (ids.restaurant) await prisma.foodRestaurant.delete({ where: { id: ids.restaurant } });
  if (ids.rider) await prisma.foodDeliveryPartner.delete({ where: { id: ids.rider } });
  await prisma.$disconnect();
});

test('late handover alerts the rider once; a stuck order alerts and repeats; admin sees the timeline', async () => {
  ids.rider = (await prisma.foodDeliveryPartner.create({ data: { name: 'Handover Rider', phone: uniquePhone('8'), status: 'approved' } })).id;
  ids.restaurant = (await prisma.foodRestaurant.create({ data: { restaurantName: 'HO Kitchen', ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' } })).id;
  ids.user = (await prisma.foodUser.create({ data: { phone: uniquePhone('5') } })).id;
  const now = new Date();
  const base = {
    userId: ids.user, restaurantId: ids.restaurant, dispatchDeliveryPartnerId: ids.rider, paymentMethod: 'cash',
    addrStreet: '1', addrCity: 'Indore', addrState: 'MP', subtotal: 100, total: 100,
  };
  const ready = await prisma.foodOrder.create({ data: { ...base, orderId: `HO-${uniquePhone('1')}`, orderStatus: 'ready_for_pickup',
    statusHistory: { create: [{ to: 'confirmed', at: new Date(now - 20 * 60000) }, { to: 'ready_for_pickup', at: new Date(now - 2 * 60000) }] } } });
  const old = await prisma.foodOrder.create({ data: { ...base, orderId: `HO-${uniquePhone('2')}`, orderStatus: 'picked_up', createdAt: new Date(now - 2 * 864e5) } });
  ids.orders.push(ready.id, old.id);

  const first = await sendOrderAlerts(now);
  assert.ok(first.handover >= 1 && first.stuck >= 1);
  const again = await sendOrderAlerts(new Date(now.getTime() + 60000));
  assert.equal((await prisma.foodOrder.findUnique({ where: { id: ready.id } })).handoverLateNotifiedAt.getTime(), now.getTime(), 'handover told once');
  assert.equal(again.stuck, 0, 'stuck waits 30 min before repeating');
  const later = await sendOrderAlerts(new Date(now.getTime() + 31 * 60000));
  assert.ok(later.stuck >= 1, 'and then repeats');

  const admin = await getOrderById(ready.id, { admin: true });
  assert.ok(admin.handover?.late, 'admin sees the late handover');
  const step = admin.timeline.find((s) => s.key === 'ready_for_pickup');
  assert.match(step.delay.label, /handover running late/);
});
