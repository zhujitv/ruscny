CREATE TYPE "FriendCallStatus" AS ENUM (
  'RINGING', 'ACTIVE', 'DECLINED', 'CANCELLED', 'ENDED', 'MISSED'
);

CREATE TABLE "ServiceConfiguration" (
  "key" TEXT NOT NULL,
  "value" TEXT,
  "encryptedValue" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedById" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ServiceConfiguration_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "ServiceConfiguration_value_check"
    CHECK (("value" IS NULL) <> ("encryptedValue" IS NULL))
);

CREATE TABLE "FriendCall" (
  "id" TEXT NOT NULL,
  "callerId" TEXT NOT NULL,
  "calleeId" TEXT NOT NULL,
  "callerDeviceId" TEXT NOT NULL,
  "calleeDeviceId" TEXT,
  "channelId" TEXT NOT NULL,
  "status" "FriendCallStatus" NOT NULL DEFAULT 'RINGING',
  "acceptedAt" TIMESTAMP(3),
  "lastHeartbeatAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "endedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FriendCall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FriendCall_channelId_key" ON "FriendCall"("channelId");
CREATE INDEX "FriendCall_callerId_status_updatedAt_idx" ON "FriendCall"("callerId", "status", "updatedAt");
CREATE INDEX "FriendCall_calleeId_status_updatedAt_idx" ON "FriendCall"("calleeId", "status", "updatedAt");
CREATE INDEX "FriendCall_status_lastHeartbeatAt_idx" ON "FriendCall"("status", "lastHeartbeatAt");
ALTER TABLE "FriendCall" ADD CONSTRAINT "FriendCall_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FriendCall" ADD CONSTRAINT "FriendCall_calleeId_fkey" FOREIGN KEY ("calleeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FriendCall" ADD CONSTRAINT "FriendCall_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
