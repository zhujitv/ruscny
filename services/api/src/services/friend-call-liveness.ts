import { Prisma } from '@prisma/client';

export const friendCallActiveHeartbeatTimeoutMs = 90_000;

export interface FriendCallHeartbeatState {
  livenessVersion: number;
  acceptedAt: Date | null;
  lastHeartbeatAt: Date | null;
  callerHeartbeatAt: Date | null;
  calleeHeartbeatAt: Date | null;
}

export function friendCallHeartbeatExpired(
  call: FriendCallHeartbeatState,
  now: Date,
): boolean {
  const cutoff = now.getTime() - friendCallActiveHeartbeatTimeoutMs;
  if (call.livenessVersion < 2) {
    return !call.lastHeartbeatAt || call.lastHeartbeatAt.getTime() <= cutoff;
  }
  if (!call.acceptedAt) return true;
  const acceptedBeforeCutoff = call.acceptedAt.getTime() <= cutoff;
  const callerExpired = call.callerHeartbeatAt
    ? call.callerHeartbeatAt.getTime() <= cutoff
    : acceptedBeforeCutoff;
  const calleeExpired = call.calleeHeartbeatAt
    ? call.calleeHeartbeatAt.getTime() <= cutoff
    : acceptedBeforeCutoff;
  return callerExpired || calleeExpired;
}

export function friendCallHeartbeatExpiredWhere(
  now: Date,
): Prisma.FriendCallWhereInput {
  const cutoff = new Date(now.getTime() - friendCallActiveHeartbeatTimeoutMs);
  return {
    OR: [
      {
        livenessVersion: { lt: 2 },
        OR: [
          { lastHeartbeatAt: null },
          { lastHeartbeatAt: { lte: cutoff } },
        ],
      },
      {
        livenessVersion: { gte: 2 },
        OR: [
          { acceptedAt: null },
          { callerHeartbeatAt: { lte: cutoff } },
          { calleeHeartbeatAt: { lte: cutoff } },
          {
            callerHeartbeatAt: null,
            acceptedAt: { lte: cutoff },
          },
          {
            calleeHeartbeatAt: null,
            acceptedAt: { lte: cutoff },
          },
        ],
      },
    ],
  };
}

/**
 * NULL-safe inverse of friendCallHeartbeatExpiredWhere.
 *
 * Do not express this as Prisma `NOT: friendCallHeartbeatExpiredWhere(now)`.
 * PostgreSQL comparisons against a NULL heartbeat evaluate to UNKNOWN, so the
 * negated predicate also evaluates to UNKNOWN and excludes a newly accepted
 * strict-liveness call before either side can establish its first heartbeat.
 */
export function friendCallHeartbeatFreshWhere(
  now: Date,
): Prisma.FriendCallWhereInput {
  const cutoff = new Date(now.getTime() - friendCallActiveHeartbeatTimeoutMs);
  return {
    OR: [
      {
        livenessVersion: { lt: 2 },
        lastHeartbeatAt: { gt: cutoff },
      },
      {
        livenessVersion: { gte: 2 },
        acceptedAt: { not: null },
        AND: [
          {
            OR: [
              { callerHeartbeatAt: { gt: cutoff } },
              {
                callerHeartbeatAt: null,
                acceptedAt: { gt: cutoff },
              },
            ],
          },
          {
            OR: [
              { calleeHeartbeatAt: { gt: cutoff } },
              {
                calleeHeartbeatAt: null,
                acceptedAt: { gt: cutoff },
              },
            ],
          },
        ],
      },
    ],
  };
}
