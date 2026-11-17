import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { windowsToWslPath, wslToWindowsPath } from '../src/storage/host-path';
import { createStorageLayout } from '../src/storage/layout';
import { cleanRelativePath, PathEscapeError, resolveInside } from '../src/storage/path-safety';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmdev-storage-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('cleanRelativePath', () => {
  it('accepts plain nested paths', () => {
    expect(cleanRelativePath('a/b/c.txt')).toBe('a/b/c.txt');
    expect(cleanRelativePath('a\\b\\c.txt')).toBe('a/b/c.txt');
  });

  it.each(['../etc/passwd', 'a/../../b', 'a/./b', '..', '/abs/path', 'C:/windows', 'C:\\windows', ''])(
    'rejects %s',
    (input) => {
      expect(cleanRelativePath(input)).toBeNull();
    }
  );
});

describe('resolveInside', () => {
  it('resolves paths within the root', () => {
    const resolved = resolveInside(tmpRoot, 'sub/file.txt');
    expect(resolved.startsWith(path.resolve(tmpRoot))).toBe(true);
  });

  it('allows the root itself via empty path', () => {
    expect(resolveInside(tmpRoot, '')).toBe(path.resolve(tmpRoot));
  });

  it('throws on traversal attempts', () => {
    expect(() => resolveInside(tmpRoot, '../outside')).toThrow(PathEscapeError);
  });
});

describe('host path conversion', () => {
  it('converts windows drive paths to wsl mounts and back', () => {
    expect(windowsToWslPath('C:\\data\\ws')).toBe('/mnt/c/data/ws');
    expect(wslToWindowsPath('/mnt/c/data/ws')).toBe('C:\\data\\ws');
  });
});

describe('storage layout', () => {
  it('creates agent directories with state beside the workspace', () => {
    const layout = createStorageLayout(path.join(tmpRoot, 'storage'));
    const paths = layout.agentPaths('user1', 'agent1');
    for (const dir of [paths.workspace, paths.state]) {
      expect(fs.existsSync(dir)).toBe(true);
    }
    expect(path.dirname(paths.state)).toBe(paths.root);
    expect(paths.state.startsWith(paths.workspace)).toBe(false);
  });
});
