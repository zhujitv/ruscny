CREATE TYPE "SystemAdminRole" AS ENUM (
  'SUPER_ADMIN',
  'OPERATIONS',
  'SUPPORT',
  'QUALITY',
  'AUDITOR',
  'VIEWER'
);

ALTER TABLE "User" ADD COLUMN "adminRole" "SystemAdminRole";

UPDATE "User"
SET "adminRole" = 'SUPER_ADMIN'
WHERE "isSystemAdmin" = TRUE;

ALTER TABLE "User"
  ADD CONSTRAINT "User_adminRole_requires_system_admin"
  CHECK ("adminRole" IS NULL OR "isSystemAdmin" = TRUE);
