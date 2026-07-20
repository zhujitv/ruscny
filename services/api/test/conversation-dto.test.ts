import { describe, expect, it } from 'vitest';

import { conversationDto } from '../src/services/conversations.js';

describe('conversation DTO privacy boundaries', () => {
  it('uses the anonymized participant instead of stale contact details after peer deletion', () => {
    const dto = conversationDto({
      id: 'direct-a-b',
      kind: 'DIRECT',
      directPairKey: 'user-a:user-b',
      ownerId: 'user-a',
      contactId: 'contact-b',
      title: null,
      hostLanguage: 'zh',
      guestLanguage: 'ru',
      status: 'ACTIVE',
      roomTokenHash: 'hidden-token',
      roomCodeHash: 'hidden-code',
      guestHistoryPolicy: 'PERMANENT',
      guestAccessExpiresAt: null,
      expiresAt: new Date('9999-12-31T23:59:59.999Z'),
      startedAt: new Date('2026-07-20T10:00:00Z'),
      endedAt: null,
      maxSequence: 0,
      createdAt: new Date('2026-07-20T10:00:00Z'),
      updatedAt: new Date('2026-07-20T10:00:00Z'),
      contact: {
        id: 'contact-b',
        displayName: 'Old private name',
        company: 'Old private company',
      },
      participants: [
        {
          id: 'participant-a',
          role: 'HOST',
          userId: 'user-a',
          guestIdentityId: null,
          displayName: 'User A',
          company: 'Company A',
          preferredLanguage: 'zh',
          presence: 'OFFLINE',
          joinedAt: new Date('2026-07-20T10:00:00Z'),
          leftAt: null,
          lastSeenAt: null,
          removedAt: null,
        },
        {
          id: 'participant-b',
          role: 'GUEST',
          userId: null,
          guestIdentityId: null,
          displayName: 'Deleted user user-b',
          company: null,
          preferredLanguage: 'ru',
          presence: 'LEFT',
          joinedAt: new Date('2026-07-20T10:00:00Z'),
          leftAt: new Date('2026-07-20T11:00:00Z'),
          lastSeenAt: new Date('2026-07-20T11:00:00Z'),
          removedAt: null,
        },
      ],
      _count: { messages: 3, participants: 2 },
    } as never, undefined, 'user-a');

    expect(dto.contactName).toBe('Deleted user user-b');
    expect(dto.company).toBeNull();
    expect(dto.directPeer).toMatchObject({
      id: 'user-b',
      displayName: 'Deleted user user-b',
      company: null,
      presence: 'LEFT',
    });
  });
});
