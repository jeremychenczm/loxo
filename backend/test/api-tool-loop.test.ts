import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { badRequest } from '../src/http/errors';
import {
  runApiToolLoop,
  setApiToolLoopExecutorForTests,
  type ApiToolDefinition,
  type ApiToolLoopRequest,
} from '../src/modules/runner/api-tool-loop';
import { drainRunsForTests } from '../src/modules/runs/wake';

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sequencedFetch(payloads: unknown[]) {
  let call = 0;
  return vi.fn(async () => {
    const payload = payloads[Math.min(call, payloads.length - 1)];
    call += 1;
    return jsonResponse(payload);
  });
}

function recordingTool(name: string, reply = 'ok'): {
  tool: ApiToolDefinition;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    tool: {
      name,
      description: `${name} test tool`,
      parameters: { type: 'object', properties: {} },
      execute: async (args) => {
        calls.push(args);
        return reply;
      },
    },
  };
}

function baseRequest(tools: ApiToolDefinition[], protocol: 'openai' | 'anthropic'): ApiToolLoopRequest {
  return {
    protocol,
    apiKey: 'sk-test',
    model: protocol === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-5',
    system: 'You are a worker.',
    prompt: 'Handle the task.',
    tools,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openai tool loop', () => {
  it('executes tool calls and feeds results back', async () => {
    const { tool, calls } = recordingTool('comment_on_task', 'Comment posted');
    const fetchMock = sequencedFetch([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'c1', function: { name: 'comment_on_task', arguments: '{"body":"note"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { role: 'assistant', content: 'all done' } }] },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runApiToolLoop(baseRequest([tool], 'openai'));
    expect(result.text).toBe('all done');
    expect(calls).toEqual([{ body: 'note' }]);

    const second = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    const toolMessage = second.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ tool_call_id: 'c1', content: 'Comment posted' });
    expect(second.tools[0].function.name).toBe('comment_on_task');
  });

  it('surfaces domain rejections as tool results and keeps going', async () => {
    const failing: ApiToolDefinition = {
      name: 'update_task_status',
      description: 'move',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw badRequest('invalid_transition', 'Cannot move a task from todo to done');
      },
    };
    const fetchMock = sequencedFetch([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                { id: 'c1', function: { name: 'update_task_status', arguments: '{"status":"done"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { role: 'assistant', content: 'understood' } }] },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runApiToolLoop(baseRequest([failing], 'openai'));
    expect(result.text).toBe('understood');

    const second = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    const toolMessage = second.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMessage.content).toContain('invalid_transition');
  });

  it('stops a runaway loop at the round limit', async () => {
    const { tool } = recordingTool('get_task', '{}');
    vi.stubGlobal(
      'fetch',
      sequencedFetch([
        {
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [{ id: 'c1', function: { name: 'get_task', arguments: '{}' } }],
              },
            },
          ],
        },
      ])
    );

    await expect(runApiToolLoop(baseRequest([tool], 'openai'))).rejects.toMatchObject({
      kind: 'bad_output',
    });
  });
});

describe('anthropic tool loop', () => {
  it('handles tool_use blocks and returns the final text', async () => {
    const { tool, calls } = recordingTool('get_task', '{"status":"todo"}');
    const fetchMock = sequencedFetch([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 't1', name: 'get_task', input: {} },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'report ready' }] },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runApiToolLoop(baseRequest([tool], 'anthropic'));
    expect(result.text).toBe('report ready');
    expect(calls).toEqual([{}]);

    const second = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(second.messages[1].role).toBe('assistant');
    const toolResult = second.messages[2].content[0];
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
      content: '{"status":"todo"}',
    });
    expect(second.tools[0].input_schema).toBeDefined();
  });

  it('marks failed tools with is_error', async () => {
    const failing: ApiToolDefinition = {
      name: 'submit_result',
      description: 'finish',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw badRequest('invalid_input', 'Result summary is required');
      },
    };
    const fetchMock = sequencedFetch([
      {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'submit_result', input: {} }],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'retrying differently' }] },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await runApiToolLoop(baseRequest([failing], 'anthropic'));
    const second = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(second.messages[2].content[0]).toMatchObject({ is_error: true });
  });
});

describe('api-lane task run', () => {
  const app = createApp();
  let token = '';
  let agentId = '';

  beforeAll(async () => {
    await pool.query('TRUNCATE TABLE users CASCADE');
    const reg = await request(app).post('/auth/register').send({
      email: 'toolloop@example.com',
      username: 'toolloopuser',
      password: 'a-strong-password',
    });
    token = reg.body.token;

    const provider = await request(app)
      .post('/api/providers')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'OpenAI', vendor: 'openai', apiKey: 'sk-test-openai-key' });

    const agent = await request(app)
      .post('/api/agents')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'API worker', runtime: 'api' });
    agentId = agent.body.agent.id;

    await request(app)
      .patch(`/api/agents/${agentId}/config`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ providerId: provider.body.provider.id });
  });

  afterAll(() => {
    setApiToolLoopExecutorForTests(null);
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('gives api-runtime task runs the control-plane tools in-process', async () => {
    setApiToolLoopExecutorForTests(async (req) => {
      const submit = req.tools.find((t) => t.name === 'submit_result')!;
      await submit.execute({ summary: 'Done via tool loop' });
      // Everything was said through tools; no final text.
      return { text: '', durationMs: 5 };
    });

    const created = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'API lane run' });
    const taskId = created.body.task.id as string;
    await request(app).post(`/api/tasks/${taskId}/move`).set(auth()).send({ status: 'todo' });
    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set(auth())
      .send({ assignee: { agentId } });
    await drainRunsForTests();

    const detail = await request(app).get(`/api/tasks/${taskId}`).set(auth());
    expect(detail.body.task.status).toBe('in_review');

    const comments = await request(app).get(`/api/tasks/${taskId}/comments`).set(auth());
    const agentComments = comments.body.comments.filter(
      (c: { authorType: string }) => c.authorType === 'agent'
    );
    expect(agentComments).toHaveLength(1);
    expect(agentComments[0].body).toBe('Done via tool loop');

    const runs = await request(app).get(`/api/runs?taskId=${taskId}`).set(auth());
    expect(runs.body.runs[0].status).toBe('succeeded');
  });
});
