import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, pool } from '../src/db/client';
import { messages } from '../src/db/schema';
import { createApp } from '../src/http/app';
import {
  fallbackTaskDraft,
  sliceTopicWindow,
  TOPIC_CHAR_BUDGET,
  TOPIC_GAP_MS,
  TOPIC_MIN_MESSAGES,
} from '../src/modules/chat/task-draft.service';

const app = createApp();
let token = '';
let agentId = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'chatdraft@example.com',
    username: 'draftuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Ada', runtime: 'claude-code' });
  agentId = agent.body.agent.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

function msg(role: 'user' | 'assistant', content: string, minutesAgo: number) {
  return { role, content, createdAt: at(minutesAgo) };
}

async function newConversation(): Promise<string> {
  const res = await request(app)
    .post('/api/conversations')
    .set(auth())
    .send({ agentId, title: `draft-${Date.now()}-${Math.random()}` });
  return res.body.conversation.id;
}

async function seedMessages(
  conversationId: string,
  rows: Array<{ role: string; content: string; createdAt: Date }>
) {
  await db.insert(messages).values(rows.map((r) => ({ ...r, conversationId })));
}

describe('sliceTopicWindow', () => {
  it('includes a short conversation entirely, oldest first', () => {
    const history = [msg('user', 'first', 10), msg('assistant', 'second', 9), msg('user', 'third', 8)];
    const window = sliceTopicWindow(history);
    expect(window.map((m) => m.content)).toEqual(['first', 'second', 'third']);
  });

  it('stops at a silence gap once the segment is thick enough', () => {
    const gapMinutes = TOPIC_GAP_MS / 60_000 + 60;
    const history = [
      msg('user', 'old topic', gapMinutes + 30),
      msg('assistant', 'old reply', gapMinutes + 29),
      // gap
      ...Array.from({ length: TOPIC_MIN_MESSAGES + 2 }, (_, i) =>
        msg(i % 2 ? 'assistant' : 'user', `recent ${i}`, 20 - i)
      ),
    ];
    const window = sliceTopicWindow(history);
    expect(window.every((m) => m.content.startsWith('recent'))).toBe(true);
    expect(window).toHaveLength(TOPIC_MIN_MESSAGES + 2);
  });

  it('walks across the gap when the current segment is thin', () => {
    const gapMinutes = TOPIC_GAP_MS / 60_000 + 60;
    const history = [
      msg('user', 'context 1', gapMinutes + 32),
      msg('assistant', 'context 2', gapMinutes + 31),
      msg('user', 'context 3', gapMinutes + 30),
      // gap, then a terse follow-up
      msg('user', 'file that as a task', 1),
    ];
    const window = sliceTopicWindow(history);
    expect(window).toHaveLength(4);
    expect(window[0]!.content).toBe('context 1');
  });

  it('respects the char budget', () => {
    const big = 'x'.repeat(TOPIC_CHAR_BUDGET / 2);
    const history = [msg('user', big, 4), msg('assistant', big, 3), msg('user', big, 2)];
    const window = sliceTopicWindow(history);
    expect(window.length).toBeLessThan(3);
    expect(window[window.length - 1]!.createdAt).toEqual(history[2]!.createdAt);
  });
});

describe('fallbackTaskDraft', () => {
  it('titles from the last user message and quotes the transcript', () => {
    const window = [
      msg('user', 'please fix the login bug\nmore detail', 5),
      msg('assistant', 'sure', 4),
    ];
    const draft = fallbackTaskDraft('Ada', window);
    expect(draft.title).toBe('please fix the login bug');
    expect(draft.brief).toContain('ADA: sure');
  });
});

describe('POST /api/conversations/:id/draft-task', () => {
  it('400s when the conversation has no messages', async () => {
    const conversationId = await newConversation();
    const empty = await request(app)
      .post(`/api/conversations/${conversationId}/draft-task`)
      .set(auth());
    expect(empty.status).toBe(400);
  });

  it('falls back to a transcript draft without a provider', async () => {
    const conversationId = await newConversation();
    await seedMessages(conversationId, [
      msg('user', 'ship the pricing page this week', 10),
      msg('assistant', 'on it — anything else?', 9),
      msg('user', 'add a yearly toggle too', 8),
    ]);

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/draft-task`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.draft.source).toBe('fallback');
    expect(res.body.draft.title).toBe('add a yearly toggle too');
    expect(res.body.draft.brief).toContain('ship the pricing page');
    expect(res.body.draft.warnings[0]).toContain('No anthropic/openai provider');
  });

  it('drafts through the provider and sends only the current topic', async () => {
    await request(app).post('/api/providers').set(auth()).send({
      name: 'Anthropic',
      vendor: 'anthropic',
      apiKey: 'sk-ant-test-key-123456',
      models: ['claude-sonnet-5'],
      isDefault: true,
    });

    const conversationId = await newConversation();
    const gapMinutes = TOPIC_GAP_MS / 60_000 + 120;
    await seedMessages(conversationId, [
      ...Array.from({ length: TOPIC_MIN_MESSAGES + 1 }, (_, i) =>
        msg(i % 2 ? 'assistant' : 'user', `ancient topic ${i}`, gapMinutes + 30 - i)
      ),
      ...Array.from({ length: TOPIC_MIN_MESSAGES + 1 }, (_, i) =>
        msg(i % 2 ? 'assistant' : 'user', `dashboard work ${i}`, 30 - i)
      ),
    ]);

    let sentBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = String(init?.body ?? '');
        return new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: '{"title":"Build the dashboard","brief":"Cards and feed."}',
              },
            ],
          }),
          { status: 200 }
        );
      })
    );

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/draft-task`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.draft).toMatchObject({
      title: 'Build the dashboard',
      brief: 'Cards and feed.',
      source: 'anthropic',
      warnings: [],
    });
    expect(sentBody).toContain('dashboard work');
    expect(sentBody).not.toContain('ancient topic');
  });

  it('falls back when the model reply is malformed', async () => {
    const conversationId = await newConversation();
    await seedMessages(conversationId, [msg('user', 'summarize the retro notes', 2)]);

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ content: [{ type: 'text', text: 'no json here' }] }), {
            status: 200,
          })
      )
    );

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/draft-task`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.draft.source).toBe('fallback');
    expect(res.body.draft.title).toBe('summarize the retro notes');
    expect(res.body.draft.warnings[0]).toContain('failed');
  });

  it('reports the slice window it drafted from', async () => {
    const conversationId = await newConversation();
    await seedMessages(conversationId, [
      msg('user', 'plan the launch email', 6),
      msg('assistant', 'drafting an outline', 5),
      msg('user', 'add a discount code section', 4),
    ]);

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/draft-task`)
      .set(auth());
    expect(res.status).toBe(200);
    const stored = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set(auth());
    const ids = stored.body.messages.map((m: { id: string }) => m.id);
    expect(res.body.draft.window).toEqual({
      fromMessageId: ids[0],
      toMessageId: ids[ids.length - 1],
      count: 3,
    });
  });

  it('honors an explicit range and ignores the gap heuristic', async () => {
    const conversationId = await newConversation();
    await seedMessages(conversationId, [
      msg('user', 'topic A: refactor auth', 500),
      msg('assistant', 'topic A reply', 499),
      msg('user', 'topic B: write docs', 5),
      msg('assistant', 'topic B reply', 4),
    ]);
    const stored = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set(auth());
    const ids = stored.body.messages.map((m: { id: string }) => m.id);

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/draft-task`)
      .set(auth())
      .send({ fromMessageId: ids[0], toMessageId: ids[1] });
    expect(res.status).toBe(200);
    expect(res.body.draft.window).toEqual({
      fromMessageId: ids[0],
      toMessageId: ids[1],
      count: 2,
    });
    expect(res.body.draft.title).toBe('topic A: refactor auth');
    expect(res.body.draft.brief).not.toContain('topic B');
  });

  it('rejects a range pointing at unknown or reversed messages', async () => {
    const conversationId = await newConversation();
    await seedMessages(conversationId, [
      msg('user', 'one', 3),
      msg('assistant', 'two', 2),
    ]);
    const stored = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set(auth());
    const ids = stored.body.messages.map((m: { id: string }) => m.id);

    const unknown = await request(app)
      .post(`/api/conversations/${conversationId}/draft-task`)
      .set(auth())
      .send({ fromMessageId: '00000000-0000-0000-0000-000000000000' });
    expect(unknown.status).toBe(400);

    const reversed = await request(app)
      .post(`/api/conversations/${conversationId}/draft-task`)
      .set(auth())
      .send({ fromMessageId: ids[1], toMessageId: ids[0] });
    expect(reversed.status).toBe(400);
  });
});
