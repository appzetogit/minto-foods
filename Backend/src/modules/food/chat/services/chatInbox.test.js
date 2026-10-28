import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import { listConversations, markRead, sendMessage } from './chat.service.js';

/**
 * The inbox is paged on the conversation rows. It used to group every message
 * the reader was ever part of -- for the admin desk, every support message --
 * and return every thread.
 */

const ADMIN = { role: 'ADMIN', id: 'admin-test' };
const users = [];
const threads = [];

test.before(async () => {
    // Three customers write to support, oldest first, a moment apart.
    for (let i = 0; i < 3; i += 1) {
        const user = await prisma.foodUser.create({ data: { phone: uniquePhone('7') } });
        users.push(user);
        const message = await sendMessage({ role: 'USER', id: user.id }, { peerRole: 'ADMIN', text: `help ${i}` });
        threads.push(message.conversationId);
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
});

test.after(async () => {
    await prisma.foodChatMessage.deleteMany({ where: { conversationId: { in: threads } } });
    await prisma.foodChatConversation.deleteMany({ where: { conversationId: { in: threads } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    await prisma.$disconnect();
});

const idsOf = (page) => page.conversations.map((c) => c.conversationId);

test('a page is the newest threads, and before= continues where it stopped', async () => {
    // Read so only paging decides what is listed, not the unread rule.
    for (const id of threads) await markRead(ADMIN, id);

    const first = await listConversations(ADMIN, { limit: 2 });
    assert.deepEqual(idsOf(first).slice(0, 2), [threads[2], threads[1]]);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextBefore);

    const second = await listConversations(ADMIN, { limit: 2, before: first.nextBefore });
    assert.equal(idsOf(second)[0], threads[0]);
    assert.ok(!idsOf(second).includes(threads[1]), 'no thread twice');

    const row = first.conversations[0];
    assert.equal(row.lastMessage, 'help 2');
    assert.equal(row.peerToken, `USER:${users[2].id}`);
});

test('threads with unread messages are on the first page wherever they fall', async () => {
    await sendMessage({ role: 'USER', id: users[0].id }, { peerRole: 'ADMIN', text: 'still there?' });

    const first = await listConversations(ADMIN, { limit: 1 });
    const oldest = first.conversations.find((c) => c.conversationId === threads[0]);
    assert.ok(oldest, 'the oldest thread is listed because it is unread');
    assert.equal(oldest.unread, 1);
    assert.equal(oldest.lastMessage, 'still there?');

    await markRead(ADMIN, threads[0]);
    const after = await listConversations(ADMIN, { limit: 1 });
    assert.ok(!idsOf(after).includes(threads[0]));
});

test('a customer sees only their own threads', async () => {
    const mine = await listConversations({ role: 'USER', id: users[1].id });
    assert.deepEqual(idsOf(mine), [threads[1]]);
    assert.equal(mine.hasMore, false);
});
