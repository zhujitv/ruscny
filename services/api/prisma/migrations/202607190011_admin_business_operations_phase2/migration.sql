CREATE TYPE "DataDeletionStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL_FAILURE');

CREATE TABLE "SystemGlossaryTerm" (
  "id" TEXT NOT NULL,
  "sourceLanguage" "Language" NOT NULL,
  "targetLanguage" "Language" NOT NULL,
  "sourceTerm" TEXT NOT NULL,
  "targetTerm" TEXT NOT NULL,
  "category" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SystemGlossaryTerm_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SystemSetting" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedById" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "DataDeletionRequest" (
  "id" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "status" "DataDeletionStatus" NOT NULL DEFAULT 'PENDING',
  "steps" JSONB NOT NULL DEFAULT '{}',
  "lastError" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DataDeletionRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SystemGlossaryTerm_sourceLanguage_targetLanguage_sourceTerm_key" ON "SystemGlossaryTerm"("sourceLanguage", "targetLanguage", "sourceTerm");
CREATE INDEX "SystemGlossaryTerm_enabled_sourceLanguage_targetLanguage_idx" ON "SystemGlossaryTerm"("enabled", "sourceLanguage", "targetLanguage");
CREATE UNIQUE INDEX "DataDeletionRequest_subjectType_subjectId_key" ON "DataDeletionRequest"("subjectType", "subjectId");
CREATE INDEX "DataDeletionRequest_status_requestedAt_idx" ON "DataDeletionRequest"("status", "requestedAt");

INSERT INTO "DataDeletionRequest" ("id", "subjectType", "subjectId", "status", "steps", "requestedAt", "completedAt", "updatedAt")
SELECT CONCAT('legacy-user-', "id"), 'USER', "id", 'COMPLETED', '{"database":"COMPLETED","identity":"ANONYMIZED","legacy":true}'::jsonb,
       COALESCE("deletedAt", "updatedAt"), COALESCE("deletedAt", "updatedAt"), COALESCE("deletedAt", "updatedAt")
FROM "User"
WHERE "status" = 'DELETED'
ON CONFLICT ("subjectType", "subjectId") DO NOTHING;
