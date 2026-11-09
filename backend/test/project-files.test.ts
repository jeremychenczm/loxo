import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { archiveProject } from '../src/modules/projects/project-files.service';
import { storage } from '../src/storage/layout';

const app = createApp();
let token = '';
let userId = '';
let projectId = '';
let workspace = '';

function seed(rel: string, content: string | Buffer): void {
  const full = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'pfiles@example.com',
    username: 'pfiles',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  const project = await request(app)
    .post('/api/projects')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Files project' });
  projectId = project.body.project.id;
  workspace = storage.projectWorkspace(userId, projectId);

  seed('docs/readme.md', 'hello docs');
  seed('docs/SOUL.md', 'nested scaffold stays visible');
  seed('src/main.ts', 'export {}');
  seed('node_modules/pkg/x.js', 'ignored');
  seed('SOUL.md', 'root scaffold hidden');
  seed('blob.bin', Buffer.from([0x89, 0x00, 0x50]));
  seed('bom.md', '﻿hi there');
  seed('big.txt', 'x'.repeat(600 * 1024));
  seed('l1/l2/l3/l4/l5/l6/too-deep.txt', 'below the depth cap');
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('file tree', () => {
  it('hides system entries, sorts dirs first, and caps depth', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/files`).set(auth());
    expect(res.status).toBe(200);
    const root = res.body.tree.root;
    const names = root.children.map((n: { name: string }) => n.name);

    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('SOUL.md');
    expect(names).not.toContain('.swarmdev-project.json');

    // Directories come before files.
    const dirFlags = root.children.map((n: { isDirectory: boolean }) => n.isDirectory);
    expect(dirFlags.slice(0, dirFlags.filter(Boolean).length).every(Boolean)).toBe(true);

    // Nested scaffold files stay visible.
    const docs = root.children.find((n: { name: string }) => n.name === 'docs');
    expect(docs.children.map((n: { name: string }) => n.name)).toContain('SOUL.md');

    // Depth 6 file is not present and the tree reports truncation.
    expect(res.body.tree.truncated).toBe(true);
    expect(JSON.stringify(root)).not.toContain('too-deep');
  });

  it('serves a subtree when path is given and rejects traversal', async () => {
    const sub = await request(app)
      .get(`/api/projects/${projectId}/files?path=docs`)
      .set(auth());
    expect(sub.status).toBe(200);
    expect(sub.body.tree.root.name).toBe('docs');

    const escape = await request(app)
      .get(`/api/projects/${projectId}/files?path=..%2F..`)
      .set(auth());
    expect(escape.status).toBe(400);
  });
});

describe('file preview and download', () => {
  it('previews text with BOM stripped', async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}/files/content?path=bom.md`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.file.content).toBe('hi there');
    expect(res.body.file.binary).toBe(false);
    expect(res.body.file.truncated).toBe(false);
  });

  it('flags binary and oversized files', async () => {
    const bin = await request(app)
      .get(`/api/projects/${projectId}/files/content?path=blob.bin`)
      .set(auth());
    expect(bin.body.file.binary).toBe(true);
    expect(bin.body.file.content).toBe('');

    const big = await request(app)
      .get(`/api/projects/${projectId}/files/content?path=big.txt`)
      .set(auth());
    expect(big.body.file.truncated).toBe(true);
    expect(big.body.file.size).toBe(600 * 1024);
  });

  it('downloads a file and blocks unsafe paths', async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}/files/download?path=docs%2Freadme.md`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body.toString()).toBe('hello docs');

    for (const bad of ['..%2Fsecret.txt', 'C%3A%5CWindows%5Cwin.ini', '%2Fetc%2Fpasswd']) {
      const blocked = await request(app)
        .get(`/api/projects/${projectId}/files/download?path=${bad}`)
        .set(auth());
      expect(blocked.status).toBe(400);
    }
  });
});

describe('zip archive', () => {
  it('packages visible files only', async () => {
    const archive = await archiveProject(userId, projectId);
    expect(archive.fileName).toBe(`Files-project-${projectId.slice(0, 8)}.zip`);

    const entries = new AdmZip(archive.buffer).getEntries().map((e) => e.entryName);
    expect(entries).toContain('docs/readme.md');
    expect(entries).toContain('docs/SOUL.md');
    expect(entries.some((e) => e.includes('node_modules'))).toBe(false);
    expect(entries).not.toContain('SOUL.md');

    const res = await request(app)
      .get(`/api/projects/${projectId}/files/archive`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(Number(res.headers['x-file-count'])).toBe(archive.fileCount);
  });
});

describe('rename and delete', () => {
  it('renames a file and rejects conflicts and bad names', async () => {
    seed('scratch.md', 'temp');
    const ok = await request(app)
      .patch(`/api/projects/${projectId}/files`)
      .set(auth())
      .send({ path: 'scratch.md', newName: 'scratch-renamed.md' });
    expect(ok.status).toBe(200);
    expect(ok.body.file.path).toBe('scratch-renamed.md');
    expect(fs.existsSync(path.join(workspace, 'scratch-renamed.md'))).toBe(true);

    const conflict = await request(app)
      .patch(`/api/projects/${projectId}/files`)
      .set(auth())
      .send({ path: 'scratch-renamed.md', newName: 'bom.md' });
    expect(conflict.status).toBe(400);
    expect(conflict.body.code).toBe('name_taken');

    const badName = await request(app)
      .patch(`/api/projects/${projectId}/files`)
      .set(auth())
      .send({ path: 'scratch-renamed.md', newName: 'a/b.md' });
    expect(badName.status).toBe(400);
  });

  it('refuses to touch protected paths and directories', async () => {
    const scaffold = await request(app)
      .patch(`/api/projects/${projectId}/files`)
      .set(auth())
      .send({ path: 'SOUL.md', newName: 'renamed.md' });
    expect(scaffold.status).toBe(400);
    expect(scaffold.body.code).toBe('protected_path');

    const meta = await request(app)
      .delete(`/api/projects/${projectId}/files`)
      .set(auth())
      .send({ path: '.swarmdev-project.json' });
    expect(meta.status).toBe(400);

    const ignored = await request(app)
      .delete(`/api/projects/${projectId}/files`)
      .set(auth())
      .send({ path: 'node_modules/pkg/x.js' });
    expect(ignored.status).toBe(400);

    const dir = await request(app)
      .delete(`/api/projects/${projectId}/files`)
      .set(auth())
      .send({ path: 'docs' });
    expect(dir.status).toBe(400);
  });

  it('deletes a file', async () => {
    seed('kill-me.md', 'bye');
    const res = await request(app)
      .delete(`/api/projects/${projectId}/files`)
      .set(auth())
      .send({ path: 'kill-me.md' });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(workspace, 'kill-me.md'))).toBe(false);
  });
});
