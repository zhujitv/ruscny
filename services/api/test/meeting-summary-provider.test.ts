import { describe, expect, it, vi } from 'vitest';
import {
  AliyunMeetingSummaryProvider,
  assertGeneratedReferences,
  meetingSummaryProvider,
  type GeneratedMeetingSummary,
  type SummaryParticipant,
  type SummaryTranscriptMessage,
} from '../src/providers/meeting-summary.js';

const participants: SummaryParticipant[] = [
  {
    participantId: 'participant-zh',
    displayName: '王伟',
    company: '中方公司',
    preferredLanguage: 'zh',
  },
  {
    participantId: 'participant-ru',
    displayName: 'Иван',
    company: 'RU Company',
    preferredLanguage: 'ru',
  },
];

const messages: SummaryTranscriptMessage[] = [
  {
    sequence: 1,
    participantId: 'participant-zh',
    speakerDisplayName: '王伟',
    speakerCompany: '中方公司',
    sourceLanguage: 'zh',
    sourceText: '我们确认八月十日交货。',
    translatedText: 'Мы подтверждаем поставку 10 августа.',
    spokenAt: '2026-07-19T10:00:00.000Z',
  },
  {
    sequence: 2,
    participantId: 'participant-ru',
    speakerDisplayName: 'Иван',
    speakerCompany: 'RU Company',
    sourceLanguage: 'ru',
    sourceText: 'Я подготовлю спецификацию завтра.',
    translatedText: '我明天准备规格书。',
    spokenAt: '2026-07-19T10:01:00.000Z',
  },
];

describe('meeting summary provider', () => {
  it('creates a deterministic source-linked draft in local mock mode', async () => {
    await expect(meetingSummaryProvider.generate({
      conversationTitle: '交付确认会',
      participants,
      messages,
    })).resolves.toMatchObject({
      draft: {
        summary: '会议“交付确认会”共记录 2 条发言。',
        summarySourceSequences: [1, 2],
        partyViews: [
          { participantId: 'participant-zh', sourceSequences: [1] },
          { participantId: 'participant-ru', sourceSequences: [2] },
        ],
      },
      audit: { provider: 'mock', model: 'deterministic' },
    });
  });

  it('accepts a fully source-linked structured AI result', () => {
    expect(() => assertGeneratedReferences(validGenerated(), participants, messages)).not.toThrow();
  });

  it('rejects hallucinated sequences, speaker attribution and assignees', () => {
    expect(() => assertGeneratedReferences({
      ...validGenerated(),
      confirmedItems: [{ text: '不存在的确认项', sourceSequences: [99] }],
    }, participants, messages)).toThrow('AI 会议纪要引用了不存在的发言');

    expect(() => assertGeneratedReferences({
      ...validGenerated(),
      partyViews: [{
        participantId: 'participant-zh',
        view: '错误归属',
        sourceSequences: [2],
      }],
    }, participants, messages)).toThrow('AI 会议纪要的观点与发言人不一致');

    expect(() => assertGeneratedReferences({
      ...validGenerated(),
      actionItems: [{
        text: '伪造负责人',
        assigneeParticipantId: 'participant-forged',
        sourceSequences: [2],
      }],
    }, participants, messages)).toThrow('AI 会议纪要引用了不存在的待办负责人');
  });

  it('calls the Aliyun JSON endpoint and retains request and token audit metadata', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'qwen-plus-test',
        enable_thinking: false,
        response_format: { type: 'json_object' },
      });
      expect(String((init?.headers as Record<string, string>).Authorization)).toBe('Bearer test-key');
      return new Response(JSON.stringify({
        id: 'completion-a',
        request_id: 'request-a',
        choices: [{ message: { content: JSON.stringify(validGenerated()) } }],
        usage: { input_tokens: 120, output_tokens: 48 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const provider = new AliyunMeetingSummaryProvider({
      ALIYUN_API_KEY: 'test-key',
      ALIYUN_COMPATIBLE_BASE_URL: 'https://dashscope.example.test/v1',
      ALIYUN_SUMMARY_MODEL: 'qwen-plus-test',
      SUMMARY_MAX_MESSAGES: 100,
      SUMMARY_MAX_INPUT_CHARACTERS: 100_000,
      SUMMARY_REQUEST_TIMEOUT_MS: 5_000,
    }, fetcher as typeof fetch);

    await expect(provider.generate({
      conversationTitle: '交付确认会', participants, messages,
    })).resolves.toMatchObject({
      draft: { summarySourceSequences: [1, 2] },
      audit: {
        provider: 'aliyun',
        model: 'qwen-plus-test',
        providerRequestId: 'request-a',
        inputTokens: 120,
        outputTokens: 48,
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps a grounded summary when an optional party view is attributed to the wrong speaker', async () => {
    const invalidPartyView = {
      ...validGenerated(),
      partyViews: [{
        participantId: 'participant-ru',
        view: '根据中方的发言推断俄方已经确认。',
        sourceSequences: [1],
      }],
    };
    const provider = providerReturning(invalidPartyView);

    await expect(provider.generate({
      conversationTitle: '交付确认会', participants, messages,
    })).resolves.toMatchObject({
      draft: {
        summarySourceSequences: [1, 2],
        partyViews: [],
        confirmedItems: [{ sourceSequences: [1] }],
      },
    });
  });

  it('accepts harmless provider variations without weakening source validation', async () => {
    const provider = providerReturning({
      ...validGenerated(),
      summarySourceSequences: ['1', 2, 2],
      partyViews: [{
        participantId: 'participant-zh',
        view: '确认八月十日交货。',
      }],
      confirmedItems: null,
      openQuestions: [{
        question: '规格书是否可以明天提供？',
        sourceSequences: [2],
      }],
      providerNote: 'extra model metadata',
    });

    await expect(provider.generate({
      conversationTitle: '交付确认会', participants, messages,
    })).resolves.toMatchObject({
      draft: {
        summarySourceSequences: [1, 2],
        partyViews: [{
          participantId: 'participant-zh',
          sourceSequences: [1],
        }],
        confirmedItems: [],
        openQuestions: [{
          text: '规格书是否可以明天提供？',
          sourceSequences: [2],
        }],
      },
    });
  });

  it('maps Aliyun rate limiting without exposing an upstream body', async () => {
    const provider = new AliyunMeetingSummaryProvider({
      ALIYUN_API_KEY: 'test-key',
      ALIYUN_COMPATIBLE_BASE_URL: 'https://dashscope.example.test/v1',
      ALIYUN_SUMMARY_MODEL: 'qwen-plus-test',
      SUMMARY_MAX_MESSAGES: 100,
      SUMMARY_MAX_INPUT_CHARACTERS: 100_000,
      SUMMARY_REQUEST_TIMEOUT_MS: 5_000,
    }, vi.fn(async () => new Response('upstream secret', { status: 429 })) as typeof fetch);

    await expect(provider.generate({
      conversationTitle: '交付确认会', participants, messages,
    })).rejects.toMatchObject({ code: 'SUMMARY_PROVIDER_RATE_LIMITED', statusCode: 429 });
  });
});

function validGenerated(): GeneratedMeetingSummary {
  return {
    summary: '双方确认交期，并安排规格书准备工作。',
    summarySourceSequences: [1, 2],
    partyViews: [
      {
        participantId: 'participant-zh',
        view: '确认八月十日交货。',
        sourceSequences: [1],
      },
      {
        participantId: 'participant-ru',
        view: '承诺准备规格书。',
        sourceSequences: [2],
      },
    ],
    confirmedItems: [{ text: '八月十日交货。', sourceSequences: [1] }],
    actionItems: [{
      text: '准备规格书。',
      assigneeParticipantId: 'participant-ru',
      sourceSequences: [2],
    }],
    openQuestions: [],
  };
}

function providerReturning(content: unknown): AliyunMeetingSummaryProvider {
  return new AliyunMeetingSummaryProvider({
    ALIYUN_API_KEY: 'test-key',
    ALIYUN_COMPATIBLE_BASE_URL: 'https://dashscope.example.test/v1',
    ALIYUN_SUMMARY_MODEL: 'qwen-plus-test',
    SUMMARY_MAX_MESSAGES: 100,
    SUMMARY_MAX_INPUT_CHARACTERS: 100_000,
    SUMMARY_REQUEST_TIMEOUT_MS: 5_000,
  }, vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch);
}
