import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { notifyPrepDelays } from './prepDelay.service.js';

const created = { orders: [], users: [], restaurants: [] };
test.after(async () => {
  await prisma.foodOrderStatusHistory?.deleteMany?.({ where: { orderId: { in: created.orders } } }).catch(() => {});
  await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
  await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
  await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
  await prisma.$disconnect();
});

test('a late order is flagged once; an on-time one is not', async () => {
  const r = await prisma.foodRestaurant.create({ data: { restaurantName: `${uniqueTag('Late')} K`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' } });
  const u = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
  created.restaurants.push(r.id); created.users.push(u.id);
  const mk = async (minutesAgo) => {
    const o = await prisma.foodOrder.create({ data: {
      userId: u.id, restaurantId: r.id, orderId: uniqueTag('P'), orderStatus: 'preparing', paymentMethod: 'cash',
      addrStreet: 's', addrCity: 'c', addrState: 'st', subtotal: 100, total: 100, packingMinutes: 20,
      statusHistory: { create: [{ at: new Date(Date.now() - minutesAgo * 60000), byRole: 'RESTAURANT', from: 'created', to: 'confirmed' }] },
    } });
    created.orders.push(o.id);
    return o;
  };
  const late = await mk(30);
  const fresh = await mk(5);
  assert.ok((await notifyPrepDelays()) >= 1);
  assert.ok((await prisma.foodOrder.findUnique({ where: { id: late.id } })).prepDelayNotifiedAt);
  assert.equal((await prisma.foodOrder.findUnique({ where: { id: fresh.id } })).prepDelayNotifiedAt, null);
  const again = await notifyPrepDelays();
  assert.equal((await prisma.foodOrder.findUnique({ where: { id: late.id } })).prepDelayNotifiedAt.getTime(),
    (await prisma.foodOrder.findUnique({ where: { id: late.id } })).prepDelayNotifiedAt.getTime());
  void again;
});
