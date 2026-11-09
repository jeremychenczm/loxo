import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { badRequest, notFound } from '../../http/errors';
import { cleanRelativePath, PathEscapeError, resolveInside } from '../../storage/path-safety';
import { storage } from '../../storage/layout';
import { sanitizeFileName } from '../../storage/file-ops';
import { getProject } from './projects.service';

const MAX_TREE_DEPTH = 5;
const MAX_TREE_ENTRIES = 600;
const PREVIEW_MAX_BYTES = 512 * 1024;

const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.openclaw',
  '.swarmdev',
  'build',
  'dist',
  'node_modules',
]);

/** Hidden only at the workspace root; visible if an agent nests them deeper. */
const ROOT_HIDDEN_FILES = new Set([
  '.swarmdev-project.json',
  'AGENTS.md',
  'BOOTSTRAP.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
]);

const PROTECTED_PREFIXES = ['.git/', '.swarmdev/', '.openclaw/', '.next/', 'build/', 'dist/', 'node_modules/'];

export interface FileNode {
  name: string;
  path: string; // forward-slash relative path
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
  children?: FileNode[];
}

export interface FileTree {
  projectId: string;
  root: FileNode;
  truncated: boolean;
  totalEntries: number;
}

async function resolveWorkspacePath(
  userId: string,
  projectId: string,
  relPath: string
): Promise<{ workspace: string; absolute: string; relative: string }> {
  await getProject(userId, projectId); // ownership
  const workspace = storage.projectWorkspace(userId, projectId);
  const relative = relPath === '' ? '' : (cleanRelativePath(relPath) ?? null);
  if (relative === null) throw badRequest('invalid_path', 'Path is not allowed');
  try {
    return { workspace, absolute: resolveInside(workspace, relative), relative };
  } catch (error) {
    if (error instanceof PathEscapeError) throw badRequest('invalid_path', 'Path is not allowed');
    throw error;
  }
}

/** Every mutation and archive walk hides the same system entries as the tree. */
function isHidden(relPath: string, isDirectory: boolean, name: string): boolean {
  if (isDirectory && IGNORED_DIR_NAMES.has(name)) return true;
  const isRootEntry = !relPath.includes('/');
  return !isDirectory && isRootEntry && ROOT_HIDDEN_FILES.has(name);
}

function assertMutable(relPath: string): void {
  if (!relPath) throw badRequest('invalid_path', 'Select a file first');
  if (PROTECTED_PREFIXES.some((prefix) => relPath.startsWith(prefix))) {
    throw badRequest('protected_path', 'System directories cannot be modified');
  }
  const basename = relPath.split('/').pop() ?? '';
  if (ROOT_HIDDEN_FILES.has(basename)) {
    throw badRequest('protected_path', 'System files cannot be modified');
  }
}

function sortEntries(entries: fs.Dirent[]): fs.Dirent[] {
  return entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });
}

export async function buildFileTree(
  userId: string,
  projectId: string,
  subPath = ''
): Promise<FileTree> {
  const { absolute, workspace } = await resolveWorkspacePath(userId, projectId, subPath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw badRequest('invalid_path', 'Folder not found');
  }

  let totalEntries = 0;
  let truncated = false;

  const walk = (dir: string, depth: number): FileNode[] => {
    if (depth > MAX_TREE_DEPTH) {
      truncated = true;
      return [];
    }
    const children: FileNode[] = [];
    for (const entry of sortEntries(fs.readdirSync(dir, { withFileTypes: true }))) {
      if (totalEntries >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(workspace, full).replace(/\\/g, '/');
      if (isHidden(rel, entry.isDirectory(), entry.name)) continue;
      if (!entry.isDirectory() && !entry.isFile()) continue;

      let stats: fs.Stats;
      try {
        stats = fs.statSync(full);
      } catch {
        continue;
      }
      totalEntries += 1;
      const node: FileNode = {
        name: entry.name,
        path: rel,
        isDirectory: entry.isDirectory(),
        size: entry.isDirectory() ? 0 : stats.size,
        modifiedAt: stats.mtime.toISOString(),
      };
      if (entry.isDirectory()) {
        node.children = walk(full, depth + 1);
      }
      children.push(node);
    }
    return children;
  };

  const rootStats = fs.statSync(absolute);
  const root: FileNode = {
    name: subPath ? path.basename(absolute) : 'workspace',
    path: subPath ? subPath : '',
    isDirectory: true,
    size: 0,
    modifiedAt: rootStats.mtime.toISOString(),
    children: walk(absolute, 1),
  };
  return { projectId, root, truncated, totalEntries };
}

export interface FilePreview {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export async function previewFile(
  userId: string,
  projectId: string,
  relPath: string
): Promise<FilePreview> {
  const { absolute, relative } = await resolveWorkspacePath(userId, projectId, relPath);
  if (!relative) throw badRequest('invalid_path', 'Select a file first');
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw notFound('File not found');
  }

  const stats = fs.statSync(absolute);
  const fd = fs.openSync(absolute, 'r');
  let window: Buffer;
  try {
    window = Buffer.alloc(Math.min(PREVIEW_MAX_BYTES, stats.size));
    fs.readSync(fd, window, 0, window.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  const binary = window.includes(0);
  const content = binary ? '' : window.toString('utf8').replace(/^﻿/, '');
  return {
    name: path.basename(absolute),
    path: relative,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    content,
    truncated: stats.size > PREVIEW_MAX_BYTES,
    binary,
  };
}

/** Unified path validation for downloads (deviation #12). */
export async function resolveDownload(
  userId: string,
  projectId: string,
  relPath: string
): Promise<{ absolute: string; name: string }> {
  const { absolute, relative } = await resolveWorkspacePath(userId, projectId, relPath);
  if (!relative) throw badRequest('invalid_path', 'Select a file first');
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw notFound('File not found');
  }
  return { absolute, name: path.basename(absolute) };
}

export interface ProjectArchive {
  fileName: string;
  fileCount: number;
  buffer: Buffer;
}

export async function archiveProject(userId: string, projectId: string): Promise<ProjectArchive> {
  const project = await getProject(userId, projectId);
  const workspace = storage.projectWorkspace(userId, projectId);
  const zip = new AdmZip();
  let fileCount = 0;

  const walk = (dir: string): void => {
    for (const entry of sortEntries(fs.readdirSync(dir, { withFileTypes: true }))) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(workspace, full).replace(/\\/g, '/');
      if (isHidden(rel, entry.isDirectory(), entry.name)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        zip.addLocalFile(full, path.dirname(rel) === '.' ? '' : path.dirname(rel));
        fileCount += 1;
      }
    }
  };
  walk(workspace);

  return {
    fileName: `${sanitizeFileName(project.name)}-${projectId.slice(0, 8)}.zip`,
    fileCount,
    buffer: zip.toBuffer(),
  };
}

export async function renameFile(
  userId: string,
  projectId: string,
  relPath: string,
  newName: string
): Promise<FileNode> {
  const { absolute, relative } = await resolveWorkspacePath(userId, projectId, relPath);
  assertMutable(relative);

  const trimmed = newName.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed)) {
    throw badRequest('invalid_name', 'File name is not allowed');
  }
  if (!fs.existsSync(absolute)) throw notFound('File not found');
  if (!fs.statSync(absolute).isFile()) {
    throw badRequest('invalid_path', 'Only files can be renamed');
  }

  const parentRel = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
  const targetRel = parentRel ? `${parentRel}/${trimmed}` : trimmed;
  assertMutable(targetRel);
  const target = path.join(path.dirname(absolute), trimmed);
  if (fs.existsSync(target)) throw badRequest('name_taken', 'A file with that name already exists');

  fs.renameSync(absolute, target);
  const stats = fs.statSync(target);
  return {
    name: trimmed,
    path: targetRel,
    isDirectory: false,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

export async function deleteFile(userId: string, projectId: string, relPath: string): Promise<void> {
  const { absolute, relative } = await resolveWorkspacePath(userId, projectId, relPath);
  assertMutable(relative);
  if (!fs.existsSync(absolute)) throw notFound('File not found');
  if (!fs.statSync(absolute).isFile()) {
    throw badRequest('invalid_path', 'Only files can be deleted');
  }
  fs.unlinkSync(absolute);
}
