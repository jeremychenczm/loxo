import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, pool } from '../src/db/client';
import { checkRuns } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { ApiHost } from '../src/modules/hosts/api-host';
import type { HostEvent } from '../src/modules/hosts/host.types';
import { repoReadTools } from '../src/modules/hosts/repo-read-tools';
import { runApiToolLoop, type ApiToolLoopRequest } from '../src/modules/runner/api-tool-loop';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

const app = createApp();
let sandbox = '';
let repo = '';
let base = '';
let taskId = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'apihost@example.com', username: 'apihostuser', password: 'a-strong-password' });
  const task = await request(app)
    .post('/api/tasks')
    .set({ Authorization: `Bearer ${reg.body.token}` })
    .send({ title: 'Review via API' });
  taskId = task.body.task.id;

  sandbox = makeSandbox('api-host');
  repo = await initFixtureRepo(path.join(sandbox, 'repo'), {
    'README.md': '# fixture\n',
    'src/app.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
    '.gitignore': 'secret.env\n',
  });
  base = await git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 1;\nexport const b = 20;\nexport const c = 3;\n');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'new file\n');
  fs.writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=x\n');
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => removeSandbox(sandbox));

function tool(name: string) {
  const found = repoReadTools({ root: repo, baseCommit: base, taskId }).find((t) => t.name === name);
  if (!found) throw new Error(name);
  return found;
}

describe('repository read tools', () => {
  it('reads files with line numbers and ranges', async () => {
    expect(await tool('read_file').execute({ path: 'src/app.ts', startLine: 2, endLine: 2 })).toBe(
      'src/app.ts (lines 2-2 of 4)\n2| export const b = 20;'
    );
    expect(await tool('read_file').execute({ path: 'blob.bin' })).toMatch(/binary file/);
  });

  it.each([['../outside.txt'], ['/etc/passwd'], ['C:\\Windows\\win.ini'], ['src/../../x']])(
    'refuses %s',
    async (p) => {
      await expect(tool('read_file').execute({ path: p })).rejects.toMatchObject({ code: 'invalid_path' });
    }
  );

  it('reports directories and missing files as tool errors', async () => {
    await expect(tool('read_file').execute({ path: 'src' })).rejects.toMatchObject({ code: 'is_directory' });
    await expect(tool('read_file').execute({ path: 'nope.ts' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists files honoring .gitignore and a directory filter', async () => {
    const all = await tool('list_files').execute({});
    expect(all.split('\n')).toEqual(
      expect.arrayContaining(['.gitignore', 'README.md', 'blob.bin', 'notes.md', 'src/app.ts'])
    );
    expect(all).not.toContain('secret.env');
    expect(await tool('list_files').execute({ path: 'src' })).toBe('src/app.ts');
  });

  it('diffs against the task base including untracked files', async () => {
    const diff = await tool('get_diff').execute({});
    expect(diff).toContain(`Changes against ${base.slice(0, 12)}`);
    expect(diff).toContain('-export const b = 2;');
    expect(diff).toContain('+export const b = 20;');
    expect(diff).toMatch(/Untracked files:[\s\S]*notes\.md/);
  });

  it('shows the latest result per check', async () => {
    expect(await tool('get_checks').execute({})).toBe('No checks have run yet');
    await db.insert(checkRuns).values([
      { taskId, fingerprint: 'f1', name: 'test', command: 'npm test', status: 'failed', exitCode: 1, durationMs: 4200 },
      { taskId, fingerprint: 'f1', name: 'lint', command: 'npm run lint', status: 'passed', exitCode: 0 },
    ]);
    const checks = await tool('get_checks').execute({});
    expect(checks).toContain('test: failed (exit 1) in 4.2s — npm test');
    expect(checks).toContain('lint: passed (exit 0) — npm run lint');
    const unscoped = repoReadTools({ root: repo }).find((t) => t.name === 'get_checks')!;
    expect(await unscoped.execute({})).toBe('No checks are available for this turn');
  });
});

describe('API host', () => {
  it('runs turns with repository tools, events, history, and usage', async () => {
    const requests: ApiToolLoopRequest[] = [];
    const host = new ApiHost({
      protocol: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-sonnet-5',
      system: 'You review code.',
      repo: { baseCommit: base, taskId },
      execute: async (req) => {
        requests.push(req);
        const diff = req.tools.find((t) => t.name === 'get_diff')!;
        req.onToolCall?.({ phase: 'start', id: 'u1', name: 'get_diff', args: {} });
        const result = await diff.execute({});
        req.onToolCall?.({ phase: 'end', id: 'u1', name: 'get_diff', result, isError: false });
        return { text: `Reviewed ${requests.length}`, durationMs: 3, usage: { inputTokens: 500, outputTokens: 40 } };
      },
    });
    const session = await host.openSession({
      cwd: repo,
      mcpServers: [],
      arbiter: async () => ({ outcome: 'deny', reason: 'unused' }),
    });
    const events: HostEvent[] = [];
    const first = await session.prompt({ prompt: 'Review the change', onEvent: (e) => events.push(e) });
    expect(first).toMatchObject({
      stopReason: 'end_turn',
      text: 'Reviewed 1',
      usage: { inputTokens: 500, outputTokens: 40, costUsd: null },
    });
    expect(events.map((e) => e.kind)).toEqual(['tool_call', 'tool_update', 'message_delta']);
    expect(events[0]).toMatchObject({ toolKind: 'read', title: 'get_diff' });
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(['read_file', 'list_files', 'get_diff', 'get_checks']);

    await session.prompt({ prompt: 'Anything else?' });
    expect(requests[1]!.history).toEqual([
      { role: 'user', content: 'Review the change' },
      { role: 'assistant', content: 'Reviewed 1' },
    ]);
  });
});

describe('provider tool loop accounting', () => {
  function stubFetch(payloads: unknown[]) {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        const payload = payloads[Math.min(call, payloads.length - 1)];
        call += 1;
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      })
    );
    return bodies;
  }

  const listTool = repoReadTools({ root: '.' })[1]!;

  it('sums OpenAI usage across rounds and replays history', async () => {
    const bodies = stubFetch([
      {
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'noop', arguments: '{}' } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      },
      { choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 150, completion_tokens: 20 } },
    ]);
    const result = await runApiToolLoop({
      protocol: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      prompt: 'now',
      history: [
        { role: 'user', content: 'before' },
        { role: 'assistant', content: 'ok' },
      ],
      tools: [{ ...listTool, name: 'noop', execute: async () => 'fine' }],
    });
    expect(result).toMatchObject({ text: 'done', usage: { inputTokens: 250, outputTokens: 30 } });
    expect((bodies[0]!.messages as Array<{ role: string; content: string }>).map((m) => [m.role, m.content])).toEqual([
      ['user', 'before'],
      ['assistant', 'ok'],
      ['user', 'now'],
    ]);
  });

  it('sums Anthropic usage and leaves it undefined when unreported', async () => {
    stubFetch([
      { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 70, output_tokens: 5 } },
    ]);
    const reported = await runApiToolLoop({ protocol: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', tools: [] });
    expect(reported.usage).toEqual({ inputTokens: 70, outputTokens: 5 });

    stubFetch([{ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }]);
    const silent = await runApiToolLoop({ protocol: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', tools: [] });
    expect(silent.usage).toBeUndefined();
  });
});
