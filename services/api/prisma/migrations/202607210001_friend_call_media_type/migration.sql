CREATE TYPE "FriendCallMediaType" AS ENUM ('AUDIO', 'VIDEO');

ALTER TABLE "FriendCall"
ADD COLUMN "mediaType" "FriendCallMediaType" NOT NULL DEFAULT 'AUDIO',
ADD COLUMN "livenessVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "callerHeartbeatAt" TIMESTAMP(3),
ADD COLUMN "calleeHeartbeatAt" TIMESTAMP(3);

-- Existing ACTIVE calls, and calls accepted by an older API replica during a
-- rolling deployment, retain livenessVersion=1 and the shared lastHeartbeatAt
-- compatibility mode. The new API explicitly creates livenessVersion=2 calls;
-- only those calls require independent caller/callee heartbeats.
CREATE INDEX "FriendCall_status_callerHeartbeatAt_idx"
ON "FriendCall"("status", "callerHeartbeatAt");

CREATE INDEX "FriendCall_status_calleeHeartbeatAt_idx"
ON "FriendCall"("status", "calleeHeartbeatAt");
