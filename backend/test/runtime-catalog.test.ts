import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acpLaunchSpec,
  findExecutable,
  resolveAcpAdapter,
  runtimeProfile,
} from '../src/modules/hosts/runtime-catalog';

const saved = { ...process.env };

afterEach(() => {
  for (const key of ['LOXO_CLAUDE_ACP_COMMAND', 'LOXO_CODEX_ACP_COMMAND']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('runtime catalog', () => {
  it('finds executables on PATH', () => {
    const node = findExecutable('node');
    expect(node).not.toBeNull();
    expect(path.isAbsolute(node!)).toBe(true);
    expect(findExecutable('definitely-not-a-real-cli-xyz')).toBeNull();
  });

  it('honors an explicit adapter path and runs scripts with node', () => {
    process.env.LOXO_CLAUDE_ACP_COMMAND = path.resolve('/opt/acp/claude-agent-acp/dist/index.js');
    const resolved = resolveAcpAdapter('claude-code');
    expect(resolved).toMatchObject({
      available: true,
      source: 'override',
      launch: { command: process.execPath, args: [process.env.LOXO_CLAUDE_ACP_COMMAND] },
    });
    process.env.LOXO_CODEX_ACP_COMMAND = path.resolve('/opt/bin/codex-acp');
    expect(resolveAcpAdapter('codex')).toMatchObject({ launch: { command: process.env.LOXO_CODEX_ACP_COMMAND, args: [] } });
  });

  it('passes credentials, model, and permission to each adapter', () => {
    process.env.LOXO_CLAUDE_ACP_COMMAND = '/opt/claude-acp.js';
    process.env.LOXO_CODEX_ACP_COMMAND = '/opt/codex-acp.js';
    const claude = acpLaunchSpec('claude-code', {
      permission: 'edit',
      model: 'claude-sonnet-5',
      credentials: { vendor: 'anthropic', apiKey: 'sk-ant-test', baseUrl: 'https://gw.example/v1' } as never,
    });
    expect(claude?.env).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'https://gw.example/v1',
      ANTHROPIC_MODEL: 'claude-sonnet-5',
    });
    const codex = acpLaunchSpec('codex', { permission: 'read_only', model: 'gpt-5-codex' });
    expect(codex?.env).toMatchObject({
      INITIAL_AGENT_MODE: 'read-only',
      CODEX_CONFIG: JSON.stringify({ model: 'gpt-5-codex' }),
      NO_BROWSER: '1',
    });
    expect(codex?.env).not.toHaveProperty('CODEX_API_KEY');
    expect(acpLaunchSpec('codex', { permission: 'full' })?.env?.INITIAL_AGENT_MODE).toBe('agent-full-access');
  });

  it('describes each runtime by what is installed', () => {
    process.env.LOXO_CLAUDE_ACP_COMMAND = '/opt/claude-acp.js';
    expect(runtimeProfile('claude-code')).toMatchObject({ transport: 'acp', permissions: 'platform', liveEvents: true });
    delete process.env.LOXO_CODEX_ACP_COMMAND;
    expect(runtimeProfile('codex')).toMatchObject({ transport: null, liveEvents: false, note: expect.stringContaining('runtimes:install') });
    expect(runtimeProfile('api')).toMatchObject({ transport: 'api', permissions: 'read_only_tools' });
  });
});
