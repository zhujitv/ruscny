import { describe, expect, it } from 'vitest';
import {
  friendCallActiveHeartbeatTimeoutMs,
  friendCallHeartbeatFreshWhere,
} from '../src/services/friend-call-liveness.js';

describe('friend call liveness queries', () => {
  it('keeps a newly accepted strict call fresh while both heartbeats are NULL', () => {
    const now = new Date('2026-07-21T07:35:45.000Z');
    const cutoff = new Date(
      now.getTime() - friendCallActiveHeartbeatTimeoutMs,
    );

    expect(friendCallHeartbeatFreshWhere(now)).toEqual({
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
    });
  });
});
