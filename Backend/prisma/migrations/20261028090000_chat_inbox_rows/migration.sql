-- The inbox now pages conversation rows instead of grouping every message, so
-- every thread needs a row. Threads from before rows existed get one, made
-- from their first message; the sender opened it.
INSERT INTO "food_chat_conversations"
  ("conversationId", "orderId", "title", "status", "peerToken", "openedByToken", "participants", "createdAt", "updatedAt")
SELECT DISTINCT ON (m."conversationId")
       m."conversationId", m."orderId", '', 'open'::"ChatThreadStatus", m."recipientToken", m."senderToken",
       ARRAY(SELECT t FROM unnest(m."participants") AS t ORDER BY t), m."createdAt", NOW()
FROM "food_chat_messages" m
WHERE NOT EXISTS (
  SELECT 1 FROM "food_chat_conversations" c WHERE c."conversationId" = m."conversationId"
)
ORDER BY m."conversationId", m."createdAt" ASC
ON CONFLICT ("conversationId") DO NOTHING;

-- A row lists the thread only for its participants. An order thread can gain
-- one after the row was made (a new rider on the order), so every party that
-- ever wrote or was written to in it is added.
UPDATE "food_chat_conversations" c
SET "participants" = ARRAY(
  SELECT DISTINCT t FROM (
    SELECT unnest(c."participants") AS t
    UNION
    SELECT unnest(m."participants") FROM "food_chat_messages" m WHERE m."conversationId" = c."conversationId"
  ) x ORDER BY t
)
WHERE EXISTS (
  SELECT 1 FROM "food_chat_messages" m
  WHERE m."conversationId" = c."conversationId"
    AND NOT (m."participants" <@ c."participants")
);

CREATE INDEX "food_chat_conversations_createdAt_idx" ON "food_chat_conversations"("createdAt" DESC);
