import { prisma } from '../db.js';

export const systemSettingDefaults = {
  REGISTRATION_ENABLED: true,
  QUALITY_REVIEW_ENABLED: true,
} as const;

export type SystemSettingKey = keyof typeof systemSettingDefaults;

export async function systemSetting<K extends SystemSettingKey>(key: K): Promise<(typeof systemSettingDefaults)[K]> {
  const stored = await prisma.systemSetting.findUnique({ where: { key }, select: { value: true } });
  if (!stored) return systemSettingDefaults[key];
  return stored.value as (typeof systemSettingDefaults)[K];
}
