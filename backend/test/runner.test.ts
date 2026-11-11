import { describe, expect, it } from 'vitest';
import { execProcess } from '@swarmdev/shared';
import {
  ADAPTERS,
  RUNTIME_CODE_CAPABILITIES,
  extractPlainReply,
  lowerPermission,
  parseClaudeStreamLine,
  redactDiagnostic,
  type ClaudeStreamState,
  type TurnRequest,
} from '../src/modules/runner/runner';

describe('claude-code control-plane args', () => {
  const base: TurnRequest = {
    runtime: 'claude-code',
    workspace: 'w',
    stateDir: 's',
    prompt: 'p',
  };

  it('mounts the platform MCP server strictly and pre-approves its tools', () => {
    const args = ADAPTERS['claude-code'].buildArgs({
      ...base,
      mcp: { url: 'http://127.0.0.1:4000/mcp', token: 'srt_x_y' },
    });
    expect(args).toContain('--strict-mcp-config');

    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    expect(config.mcpServers.swarmdev.url).toBe('http://127.0.0.1:4000/mcp');
    expect(config.mcpServers.swarmdev.headers.Authorization).toBe('Bearer srt_x_y');

    // Non-interactive runs auto-deny tools that are not allowlisted; without
    // this the control plane mounts but every call is rejected.
    const allowed = args[args.indexOf('--allowedTools') + 1]!;
    for (const tool of [
      'get_task',
      'comment_on_task',
      'update_task_status',
      'ask_blocker',
      'submit_result',
    ]) {
      expect(allowed).toContain(`mcp__swarmdev__${tool}`);
    }
  });

  it('adds no MCP args without a control plane', () => {
    const args = ADAPTERS['claude-code'].buildArgs(base);
    expect(args).not.toContain('--mcp-config');
    expect(args[args.indexOf('--allowedTools') + 1] ?? '').not.toContain('mcp__swarmdev__');
  });
});

describe('claude-code permission mapping', () => {
  const base: TurnRequest = {
    runtime: 'claude-code',
    workspace: 'w',
    stateDir: 's',
    prompt: 'p',
  };
  const modeOf = (args: string[]) => args[args.indexOf('--permission-mode') + 1];

  it('keeps the legacy acceptEdits posture when no permission is set', () => {
    const args = ADAPTERS['claude-code'].buildArgs(base);
    expect(modeOf(args)).toBe('acceptEdits');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('maps read_only to plan mode with editing tools disallowed', () => {
    const args = ADAPTERS['claude-code'].buildArgs({ ...base, permission: 'read_only' });
    expect(modeOf(args)).toBe('plan');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,NotebookEdit');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('allowlists read-only Git evidence commands below full access', () => {
    for (const permission of ['read_only', 'edit'] as const) {
      const args = ADAPTERS['claude-code'].buildArgs({ ...base, permission });
      const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
      expect(allowed).toContain('Bash(git status:*)');
      expect(allowed).toContain('Bash(git diff:*)');
      expect(allowed).not.toContain('Bash(git push');
    }
  });

  it('maps full to the explicit permission bypass and drops the allowlist', () => {
    const args = ADAPTERS['claude-code'].buildArgs({ ...base, permission: 'full' });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--allowedTools');
  });

  it('keeps MCP tools allowlisted alongside the Git commands for a read-only reviewer', () => {
    const args = ADAPTERS['claude-code'].buildArgs({
      ...base,
      permission: 'read_only',
      mcp: { url: 'http://127.0.0.1:4000/mcp', token: 't' },
    });
    const occurrences = args.filter((a) => a === '--allowedTools');
    expect(occurrences).toHaveLength(1);
    const allowed = args[args.indexOf('--allowedTools') + 1]!;
    expect(allowed).toContain('Bash(git diff:*)');
    expect(allowed).toContain('mcp__swarmdev__get_task');
  });

  it('never delegates worktree management to the runtime', () => {
    for (const permission of ['read_only', 'edit', 'full'] as const) {
      expect(ADAPTERS['claude-code'].buildArgs({ ...base, permission })).not.toContain('--worktree');
    }
  });
});

describe('codex permission mapping', () => {
  const base: TurnRequest = { runtime: 'codex', workspace: 'w', stateDir: 's', prompt: 'p' };
  const sandboxOf = (args: string[]) => args[args.indexOf('--sandbox') + 1];

  it('adds no sandbox flag when no permission is set', () => {
    expect(ADAPTERS.codex.buildArgs(base)).not.toContain('--sandbox');
  });

  it('maps each level to the matching sandbox', () => {
    expect(sandboxOf(ADAPTERS.codex.buildArgs({ ...base, permission: 'read_only' }))).toBe(
      'read-only'
    );
    expect(sandboxOf(ADAPTERS.codex.buildArgs({ ...base, permission: 'edit' }))).toBe(
      'workspace-write'
    );
    expect(sandboxOf(ADAPTERS.codex.buildArgs({ ...base, permission: 'full' }))).toBe(
      'danger-full-access'
    );
  });

  it('keeps the stdin prompt marker as the final argument', () => {
    const args = ADAPTERS.codex.buildArgs({ ...base, permission: 'edit' });
    expect(args[args.length - 1]).toBe('-');
  });
});

describe('permission resolution and capability matrix', () => {
  it('lowerPermission picks the more restrictive level', () => {
    expect(lowerPermission('full', 'read_only')).toBe('read_only');
    expect(lowerPermission('read_only', 'full')).toBe('read_only');
    expect(lowerPermission('edit', 'full')).toBe('edit');
    expect(lowerPermission('edit', 'edit')).toBe('edit');
  });

  it('only verified runtimes advertise code workspace support', () => {
    expect(RUNTIME_CODE_CAPABILITIES['claude-code'].codeWorkspace).toBe('supported');
    expect(RUNTIME_CODE_CAPABILITIES.codex.codeWorkspace).toBe('supported');
    expect(RUNTIME_CODE_CAPABILITIES.codex.permissionEnforcement).toBe('enforced');
    expect(RUNTIME_CODE_CAPABILITIES.opencode.codeWorkspace).toBe('experimental');
    expect(RUNTIME_CODE_CAPABILITIES.hermes.codeWorkspace).toBe('disabled');
    expect(RUNTIME_CODE_CAPABILITIES.openclaw.codeWorkspace).toBe('disabled');
    expect(RUNTIME_CODE_CAPABILITIES.opencode.permissionEnforcement).toBe('unverified');
  });
});

describe('parseClaudeStreamLine', () => {
  it('extracts assistant text chunks and the result session ref', () => {
    const state: ClaudeStreamState = { chunks: [] };

    const chunk = parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use' }] },
      }),
      state
    );
    expect(chunk).toBe('Hello');

    parseClaudeStreamLine(
      JSON.stringify({ type: 'result', session_id: 'sess-1', result: 'Hello final' }),
      state
    );
    expect(state.sessionRef).toBe('sess-1');
    expect(state.resultText).toBe('Hello final');
  });

  it('flags error results and tolerates junk lines', () => {
    const state: ClaudeStreamState = { chunks: [] };
    expect(parseClaudeStreamLine('not json', state)).toBeNull();
    parseClaudeStreamLine(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }), state);
    expect(state.isError).toBe(true);
  });

  it('streams token-level deltas from partial message events', () => {
    const state: ClaudeStreamState = { chunks: [] };
    const delta = (text: string) =>
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      });

    expect(parseClaudeStreamLine(delta('Hel'), state)).toBe('Hel');
    expect(parseClaudeStreamLine(delta('lo'), state)).toBe('lo');
    expect(state.chunks.join('')).toBe('Hello');

    // Thinking deltas and other stream events are not user-visible text.
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } },
        }),
        state
      )
    ).toBeNull();
  });

  it('suppresses the duplicate assistant event after token deltas', () => {
    const state: ClaudeStreamState = { chunks: [] };
    parseClaudeStreamLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      }),
      state
    );
    const repeated = parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      }),
      state
    );
    expect(repeated).toBeNull();
    expect(state.chunks.join('')).toBe('Hello');
  });
});

describe('extractPlainReply', () => {
  it('passes through plain text', () => {
    expect(extractPlainReply('  hi there \n')).toBe('hi there');
  });

  it('unwraps common JSON reply shapes', () => {
    expect(extractPlainReply(JSON.stringify({ result: 'from json' }))).toBe('from json');
    expect(extractPlainReply(JSON.stringify({ text: 'alt key' }))).toBe('alt key');
  });

  it('falls back to raw output for unrecognized JSON', () => {
    const raw = JSON.stringify({ unrelated: 1 });
    expect(extractPlainReply(raw)).toBe(raw);
  });
});

describe('redactDiagnostic', () => {
  it('strips ANSI codes and API keys', () => {
    const dirty = '\x1b[31merror\x1b[0m key sk-abcdefghijklmnop123456 leaked';
    const clean = redactDiagnostic(dirty);
    expect(clean).not.toContain('sk-abcdefghijklmnop');
    expect(clean).not.toContain('\x1b');
    expect(clean).toContain('[redacted]');
  });
});

describe('execProcess', () => {
  const node = process.execPath;

  it('pipes stdin and captures stdout', async () => {
    const result = await execProcess({
      command: node,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd: process.cwd(),
      env: {},
      stdin: 'echo me',
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('echo me');
  });

  it('emits stdout line events including the unterminated tail', async () => {
    const lines: string[] = [];
    await execProcess({
      command: node,
      args: ['-e', "process.stdout.write('a\\nb\\nc')"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 10_000,
      onStdoutLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('kills the process on timeout', async () => {
    const result = await execProcess({
      command: node,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
  }, 15_000);

  it('kills the process on abort', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await execProcess({
      command: node,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
  }, 15_000);

  it('passes custom env through', async () => {
    const result = await execProcess({
      command: node,
      args: ['-e', 'process.stdout.write(process.env.SWARM_TEST_VAR || "missing")'],
      cwd: process.cwd(),
      env: { SWARM_TEST_VAR: 'present' },
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe('present');
  });
});
