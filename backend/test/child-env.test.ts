import { describe, expect, it } from 'vitest';
import { childEnv } from '../src/lib/child-env';

const source = {
  PATH: '/usr/bin',
  HOME: '/home/dev',
  Path: 'C:\\Windows',
  SystemRoot: 'C:\\Windows',
  https_proxy: 'http://proxy:8080',
  DATABASE_URL: 'postgres://secret',
  SECRETS_KEY: 'key',
  JWT_SECRET: 'jwt',
  STORAGE_ROOT: '/data',
  ANTHROPIC_API_KEY: 'sk-ant',
  CODEX_HOME: '/codex',
  GIT_AUTHOR_NAME: 'Dev',
  GIT_DIR: '/elsewhere/.git',
  NODE_OPTIONS: '--require ./inject.js',
};

describe('childEnv', () => {
  it('never passes the backend secrets to any child', () => {
    for (const kind of ['agent', 'git'] as const) {
      const env = childEnv(kind, {}, source);
      for (const secret of ['DATABASE_URL', 'SECRETS_KEY', 'JWT_SECRET', 'STORAGE_ROOT', 'NODE_OPTIONS']) {
        expect(env).not.toHaveProperty(secret);
      }
    }
  });

  it('keeps system and proxy variables, matching names case-insensitively', () => {
    const env = childEnv('agent', {}, source);
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/dev', Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' });
    expect(env.https_proxy).toBe('http://proxy:8080');
  });

  it('scopes vendor variables to agents and Git variables to git', () => {
    const agent = childEnv('agent', {}, source);
    expect(agent).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant', CODEX_HOME: '/codex' });
    expect(agent).not.toHaveProperty('GIT_AUTHOR_NAME');

    const git = childEnv('git', {}, source);
    expect(git.GIT_AUTHOR_NAME).toBe('Dev');
    expect(git).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('drops repository overrides so git follows its cwd', () => {
    expect(childEnv('git', {}, source)).not.toHaveProperty('GIT_DIR');
  });

  it('applies explicit values last', () => {
    const env = childEnv('git', { GIT_TERMINAL_PROMPT: '0', PATH: '/custom' }, source);
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', PATH: '/custom' });
  });
});
