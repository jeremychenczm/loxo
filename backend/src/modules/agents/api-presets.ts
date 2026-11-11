import fs from 'node:fs';
import path from 'node:path';
import { db } from '../../db/client';
import { agents, type Agent } from '../../db/schema';
import { notFound } from '../../http/errors';
import { copyDir, removeDir } from '../../storage/file-ops';
import { storage } from '../../storage/layout';
import type { ApiProtocol } from '../runner/api-turn';
import { eq } from 'drizzle-orm';

/**
 * Catalog of deployable API-hosted agents: a system prompt plus a model,
 * executed over the user's own OpenAI/Anthropic provider. Operators override
 * the built-in presets with API_AGENT_CATALOG (JSON array).
 */
export interface ApiAgentPreset {
  id: string;
  name: string;
  description: string;
  protocol: ApiProtocol;
  model: string;
  systemPrompt: string;
  tags: string[];
  category: string;
  creator: string;
  rating: number;
  deployCount: number;
  featured: boolean;
}

const FALLBACK_PRESETS: ApiAgentPreset[] = [
  {
    id: 'api-writing-companion',
    name: 'Writing Companion',
    description:
      'Drafts, edits, and restructures prose: blog posts, release notes, and product copy.',
    protocol: 'anthropic',
    model: 'claude-sonnet-5',
    systemPrompt:
      'You are a precise writing assistant. Help the user draft, edit, and restructure text. Prefer clear, concrete wording; keep the original voice; explain significant edits briefly.',
    tags: ['writing', 'editing'],
    category: 'Content',
    creator: 'SwarmDev',
    rating: 4.8,
    deployCount: 0,
    featured: true,
  },
  {
    id: 'api-research-analyst',
    name: 'Research Analyst',
    description:
      'Summarizes sources, compares options, and extracts key claims with their caveats.',
    protocol: 'openai',
    model: 'gpt-4o-mini',
    systemPrompt:
      'You are a careful research analyst. Summarize provided material faithfully, separate facts from speculation, cite which part of the input each claim comes from, and call out gaps.',
    tags: ['research', 'analysis'],
    category: 'Research',
    creator: 'SwarmDev',
    rating: 4.7,
    deployCount: 0,
    featured: true,
  },
  {
    id: 'api-code-reviewer',
    name: 'Code Review Helper',
    description:
      'Reviews diffs and snippets for correctness tasks and suggests focused improvements.',
    protocol: 'anthropic',
    model: 'claude-sonnet-5',
    systemPrompt:
      'You are a pragmatic code reviewer. Point out correctness bugs first, then meaningful simplifications. Be specific about the failing scenario; skip style nitpicks unless asked.',
    tags: ['code', 'review'],
    category: 'Engineering',
    creator: 'SwarmDev',
    rating: 4.6,
    deployCount: 0,
    featured: false,
  },
];

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

function normalizePreset(raw: unknown, index: number): ApiAgentPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  const protocol = asString(record.protocol);
  const model = asString(record.model);
  const systemPrompt = asString(record.systemPrompt ?? record.system_prompt);
  if ((protocol !== 'openai' && protocol !== 'anthropic') || !model || !systemPrompt) return null;

  const name = asString(record.name, `API Agent ${index + 1}`);
  return {
    id: asString(record.id, `api-${name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')),
    name,
    description: asString(record.description, 'Hosted API agent.'),
    protocol,
    model,
    systemPrompt,
    tags: Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === 'string') : [],
    category: asString(record.category, 'General'),
    creator: asString(record.creator, 'SwarmDev'),
    rating: asNumber(record.rating, 4.5),
    deployCount: asNumber(record.deployCount, 0),
    featured: Boolean(record.featured),
  };
}

function loadCatalog(): ApiAgentPreset[] {
  const raw = process.env.API_AGENT_CATALOG;
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const presets = parsed
          .map(normalizePreset)
          .filter((preset): preset is ApiAgentPreset => preset !== null);
        if (presets.length > 0) return presets;
      }
    } catch (error) {
      console.error('Failed to parse API_AGENT_CATALOG:', error);
    }
  }
  return FALLBACK_PRESETS;
}

export interface CatalogQuery {
  search?: string;
  category?: string;
  limit?: number;
}

export function listApiAgentPresets(query: CatalogQuery = {}): ApiAgentPreset[] {
  const search = query.search?.trim().toLowerCase();
  const category = query.category?.trim().toLowerCase();
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

  return loadCatalog()
    .filter((preset) => {
      const matchesSearch =
        !search ||
        [preset.name, preset.description, preset.category, ...preset.tags].some((value) =>
          value.toLowerCase().includes(search)
        );
      const matchesCategory = !category || preset.category.toLowerCase() === category;
      return matchesSearch && matchesCategory;
    })
    .sort(
      (a, b) =>
        Number(b.featured) - Number(a.featured) ||
        b.deployCount - a.deployCount ||
        b.rating - a.rating
    )
    .slice(0, limit);
}

export function getApiAgentPreset(presetId: string): ApiAgentPreset | null {
  return loadCatalog().find((preset) => preset.id === presetId) ?? null;
}

/**
 * Deploys a catalog preset as a user agent instance. The workspace only
 * documents the deployment; the behavior lives in the manifest (protocol,
 * default model, system prompt) and runs over the user's provider.
 */
export async function deployApiAgent(userId: string, presetId: string): Promise<Agent> {
  const preset = getApiAgentPreset(presetId);
  if (!preset) throw notFound('API agent preset not found');

  const [agent] = await db
    .insert(agents)
    .values({
      userId,
      name: preset.name,
      description: preset.description,
      runtime: 'api',
      execution: 'api',
      model: preset.model,
      tags: ['api', ...preset.tags],
      manifest: {
        name: preset.name,
        description: preset.description,
        api: {
          protocol: preset.protocol,
          model: preset.model,
          systemPrompt: preset.systemPrompt,
          catalogId: preset.id,
        },
      },
    })
    .returning();

  const paths = storage.agentPaths(userId, agent!.id);
  try {
    fs.writeFileSync(
      path.join(paths.workspace, 'README.md'),
      [
        `# ${preset.name}`,
        '',
        preset.description,
        '',
        `- Protocol: ${preset.protocol}`,
        `- Default model: ${preset.model}`,
        '- Runs over your configured provider credentials; no CLI runtime needed.',
        '',
      ].join('\n')
    );
    copyDir(paths.workspace, paths.baseline);
  } catch (error) {
    removeDir(paths.root);
    await db.delete(agents).where(eq(agents.id, agent!.id));
    throw error;
  }

  return agent!;
}
