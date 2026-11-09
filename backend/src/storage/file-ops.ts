import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface DirEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: Date;
}

export function listDir(dir: string): DirEntry[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const full = path.join(dir, entry.name);
    const stats = fs.statSync(full);
    return {
      name: entry.name,
      relativePath: entry.name,
      isDirectory: entry.isDirectory(),
      size: entry.isDirectory() ? 0 : stats.size,
      modifiedAt: stats.mtime,
    };
  });
}

export function copyDir(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Content-addressed digest over relative paths and file bytes; stable across
 * platforms and copy order.
 */
export function dirDigest(dir: string): string {
  const hash = crypto.createHash('sha256');
  const files = walkFiles(dir).sort();
  for (const file of files) {
    hash.update(path.relative(dir, file).replace(/\\/g, '/'));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

export function dirSizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return walkFiles(dir).reduce((total, file) => total + fs.statSync(file).size, 0);
}

/** Reduces a display name to a portable file-name stem. */
export function sanitizeFileName(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || 'file';
}
