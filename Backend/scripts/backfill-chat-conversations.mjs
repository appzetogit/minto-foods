/**
 * Give every chat thread the conversation row it should always have had.
 *
 * The inbox is derived from the messages, so a thread with no row still showed
 * up and could be replied to; assigning or closing it then failed with
 * "Conversation not found". sendMessage now writes the row, and this repairs
 * the threads that started before it did.
 *
 * Each row is rebuilt from that thread's own first message, so who opened it
 * and who it is with match what actually happened. Safe to re-run: threads that
 * already have a row are skipped, never rewritten.
 *
 *   node scripts/backfill-chat-conversations.mjs           # report only
 *   node scripts/backfill-chat-conversations.mjs --apply   # write
 */
import { prisma } from '../src/config/prisma.js';

const APPLY = process.argv.includes('--apply');

const ids = await prisma.foodChatMessage.findMany({
    distinct: ['conversationId'],
    select: { conversationId: true },
});

let missing = 0;
let created = 0;

for (const { conversationId } of ids) {
    const exists = await prisma.foodChatConversation.findUnique({ where: { conversationId } });
    if (exists) continue;

    missing += 1;
    // The first message is the one that opened the thread.
    const first = await prisma.foodChatMessage.findFirst({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
    });
    if (!first) continue;

    const participants = [...new Set(first.participants || [first.senderToken, first.recipientToken])]
        .filter(Boolean)
        .sort();

    console.log(`${conversationId}`);
    console.log(`   opened by ${first.senderToken} with ${first.recipientToken} on ${first.createdAt.toISOString().slice(0, 10)}`);

    if (APPLY) {
        await prisma.foodChatConversation.create({
            data: {
                conversationId,
                orderId: first.orderId || null,
                title: '',
                peerToken: first.recipientToken,
                openedByToken: first.senderToken,
                participants,
                status: 'open',
                closedAt: null,
            },
        });
        created += 1;
        console.log('   created');
    }
}

console.log('');
console.log(`${ids.length} thread(s) in the messages, ${missing} without a row${APPLY ? `, ${created} created` : ''}`);
if (!APPLY && missing) console.log('Re-run with --apply to write.');

process.exit(0);
