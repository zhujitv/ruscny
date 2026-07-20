CREATE TYPE "ConversationKind" AS ENUM ('MEETING', 'DIRECT');

ALTER TABLE "Conversation"
  ADD COLUMN "kind" "ConversationKind" NOT NULL DEFAULT 'MEETING',
  ADD COLUMN "directPairKey" TEXT;

CREATE UNIQUE INDEX "Conversation_directPairKey_key"
  ON "Conversation"("directPairKey");

CREATE INDEX "Conversation_kind_updatedAt_idx"
  ON "Conversation"("kind", "updatedAt");

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_direct_pair_shape"
  CHECK (
    ("kind" = 'MEETING' AND "directPairKey" IS NULL)
    OR
    ("kind" = 'DIRECT' AND "directPairKey" IS NOT NULL)
  );
