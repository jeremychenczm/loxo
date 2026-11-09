import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /** Monotonic per-user issue number source; incremented inside the create-issue transaction. */
  issueCounter: integer('issue_counter').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;

/**
 * Model provider credentials, scoped per user. `apiKeyEncrypted` holds an
 * AES-256-GCM envelope, never plaintext.
 */
export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  vendor: text('vendor').notNull(), // anthropic | openai | openclaw | hermes
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  baseUrl: text('base_url'),
  models: jsonb('models').$type<string[]>().notNull().default([]),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Provider = typeof providers.$inferSelect;

export const agentGroups = pgTable('agent_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#38bdf8'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AgentGroup = typeof agentGroups.$inferSelect;

/** Optional packaging metadata read from agent.json at import time. */
export interface AgentManifest {
  name?: string;
  version?: string;
  description?: string;
  capabilities?: string[];
  /** API-hosted agents: protocol and defaults recorded at deploy time. */
  api?: {
    protocol?: 'openai' | 'anthropic';
    model?: string;
    systemPrompt?: string;
    catalogId?: string;
  };
  /** Team-template provenance; drives duplicate detection at adopt time. */
  template?: {
    id?: string;
    roleCode?: string;
  };
}

export type AgentPermissionLevel = 'read_only' | 'edit' | 'full';

/**
 * Workspace/baseline/state paths are derived from (userId, agentId) via the
 * storage layout and intentionally not stored.
 */
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  runtime: text('runtime').notNull(), // claude-code | codex | opencode | hermes | openclaw | api
  manifest: jsonb('manifest').$type<AgentManifest>().notNull().default({}),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  groupId: uuid('group_id').references(() => agentGroups.id, { onDelete: 'set null' }),
  providerId: uuid('provider_id').references(() => providers.id, { onDelete: 'set null' }),
  model: text('model'),
  avatarFile: text('avatar_file'),
  status: text('status').notNull().default('idle'), // idle | busy | error | offline
  /** Where turns execute: on this server or via provider API. */
  execution: text('execution').notNull().default('server'), // server | api
  /**
   * Ceiling for code-execution runs. A run may resolve lower (review runs are
   * forced to read_only) but never higher; raising to full requires explicit
   * user confirmation and imported agents always reset to edit.
   */
  permissionLevel: text('permission_level').$type<AgentPermissionLevel>().notNull().default('edit'),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Agent = typeof agents.$inferSelect;

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default('New conversation'),
  /** CLI-side session id (e.g. claude-code --resume); cleared on provider/model change. */
  runnerSessionRef: text('runner_session_ref'),
  lastMessagePreview: text('last_message_preview').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Conversation = typeof conversations.$inferSelect;

export interface MessageMeta {
  runtime?: string;
  durationMs?: number;
  error?: boolean;
  source?: string;
  /** Set on the system message posted when a chat topic is filed as an issue. */
  issueId?: string;
}

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // user | assistant | system
  content: text('content').notNull(),
  meta: jsonb('meta').$type<MessageMeta>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Message = typeof messages.$inferSelect;

/**
 * Team row is an index; the canvas graph and workflow DSL live in a JSON
 * manifest file under the user's storage (deliberate design: complex graph
 * structures stay out of the relational schema).
 */
/**
 * Project workspace: a durable directory agents collaborate in, bound to
 * agents via a join table. `updatedAt` is the recency key maintained by
 * touchProject.
 */
export type ProjectKind = 'normal' | 'default';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** 'default' marks the per-user fallback project; created lazily, cannot be deleted. */
    kind: text('kind').$type<ProjectKind>().notNull().default('normal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one default project per user; makes lazy creation race-safe.
    uniqueIndex('projects_user_default')
      .on(t.userId)
      .where(sql`${t.kind} = 'default'`),
  ]
);

export type Project = typeof projects.$inferSelect;

export const projectAgents = pgTable(
  'project_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_agents_project_agent').on(t.projectId, t.agentId)]
);

export type ProjectAgent = typeof projectAgents.$inferSelect;

export type IssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

/**
 * Unit of work. Status transitions are enforced by a static transition table
 * in the issues service, never by direct writes. Assignee and reviewer are
 * each a single principal: agent or user, checked at the database level.
 * issueNumber is unique per user and drawn from users.issueCounter.
 */
export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueNumber: integer('issue_number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').$type<IssueStatus>().notNull().default('backlog'),
    assigneeAgentId: uuid('assignee_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewerAgentId: uuid('reviewer_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    reviewerUserId: uuid('reviewer_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Position within a kanban column; fractional values allow reorder without renumbering. */
    boardOrder: doublePrecision('board_order').notNull().default(0),
    /**
     * Execution lock: the run currently working this issue. Wake admission
     * acquires it with a conditional UPDATE, so the same issue is never
     * executed by two runs at once regardless of trigger source.
     */
    activeRunId: uuid('active_run_id').references((): AnyPgColumn => runs.id, {
      onDelete: 'set null',
    }),
    /** Chat conversation this issue was filed from. A conversation can spawn many issues. */
    sourceConversationId: uuid('source_conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('issues_user_number').on(t.userId, t.issueNumber),
    index('issues_user_status').on(t.userId, t.status),
    index('issues_project_status').on(t.projectId, t.status),
    index('issues_assignee_agent').on(t.assigneeAgentId, t.status),
    index('issues_source_conversation').on(t.sourceConversationId),
    check(
      'issues_assignee_single_principal',
      sql`NOT (${t.assigneeAgentId} IS NOT NULL AND ${t.assigneeUserId} IS NOT NULL)`
    ),
    check(
      'issues_reviewer_single_principal',
      sql`NOT (${t.reviewerAgentId} IS NOT NULL AND ${t.reviewerUserId} IS NOT NULL)`
    ),
  ]
);

export type Issue = typeof issues.$inferSelect;

/** system rows are platform-generated (workspace lifecycle, capture evidence); both author links stay null. */
export type IssueCommentAuthorType = 'human' | 'agent' | 'system';

/**
 * Issue activity timeline. Author columns mirror the dual-principal pattern;
 * rows are pruned with their issue, author links survive as null for display.
 */
export const issueComments = pgTable(
  'issue_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorType: text('author_type').$type<IssueCommentAuthorType>().notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorAgentId: uuid('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('issue_comments_issue_created').on(t.issueId, t.createdAt)]
);

export type IssueComment = typeof issueComments.$inferSelect;

export type RunTrigger = 'assignment' | 'manual' | 'comment' | 'chat' | 'workflow' | 'review';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * One admitted wake-up of an agent. Every trigger source funnels through the
 * wake admission service, which creates exactly one row per admitted wake-up.
 * Queued rows double as the wait queue for an issue's execution lock and are
 * promoted oldest-first when the lock releases.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** Display snapshot; run history survives agent deletion. */
    agentName: text('agent_name').notNull(),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    trigger: text('trigger').$type<RunTrigger>().notNull(),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    /** Why the agent was woken; rendered into the turn prompt. */
    reason: text('reason').notNull().default(''),
    output: text('output').notNull().default(''),
    error: text('error'),
    sessionRef: text('session_ref'),
    model: text('model'),
    /** Usage accounting; populated by lanes that report it. */
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: doublePrecision('cost_usd'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('runs_issue_status').on(t.issueId, t.status),
    index('runs_agent_status').on(t.agentId, t.status),
    index('runs_user_created').on(t.userId, t.createdAt),
  ]
);

export type Run = typeof runs.$inferSelect;

export type ReviewDecision = 'approved' | 'changes_requested';

/**
 * Structured verdict on an issue in review. Every decision carries a body;
 * the body is also posted to the issue timeline so the assignee's next run
 * reads the feedback naturally. Reviewer mirrors the dual-principal pattern.
 */
export const issueReviews = pgTable(
  'issue_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    reviewerType: text('reviewer_type').$type<'human' | 'agent'>().notNull(),
    reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
    reviewerAgentId: uuid('reviewer_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    /** Review run that produced this verdict, when an agent reviewed. */
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    /**
     * Code reviews: the change snapshot this verdict applies to. An approval
     * authorizes finalization only while the workspace content still matches
     * the snapshot's fingerprint; any later change makes it stale.
     */
    changeSnapshotId: uuid('change_snapshot_id').references(
      (): AnyPgColumn => runChangeSnapshots.id,
      { onDelete: 'set null' }
    ),
    decision: text('decision').$type<ReviewDecision>().notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('issue_reviews_issue_created').on(t.issueId, t.createdAt),
    check(
      'issue_reviews_single_principal',
      sql`NOT (${t.reviewerAgentId} IS NOT NULL AND ${t.reviewerUserId} IS NOT NULL)`
    ),
  ]
);

export type IssueReview = typeof issueReviews.$inferSelect;

export type RepositoryLocation = 'server';

export type CleanupPolicy = 'manual' | 'after_merge';

/**
 * Git repository bound to a project for code execution. The activeMerge*
 * columns form a compare-and-set lock: at most one workspace may mutate the
 * primary checkout, and the persisted operation id and pre-merge HEAD let
 * crash recovery prove whether an interrupted merge never started, aborted,
 * or completed — staleness is never inferred from age alone.
 */
export const projectRepositories = pgTable(
  'project_repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    location: text('location').$type<RepositoryLocation>().notNull(),
    /** Primary checkout root. Null for server repositories, which use the project workspace. */
    rootPath: text('root_path'),
    /** Must resolve to a local branch under refs/heads/; the only valid merge target. */
    defaultBaseRef: text('default_base_ref').notNull().default('main'),
    branchPrefix: text('branch_prefix').notNull().default('swarmdev'),
    cleanupPolicy: text('cleanup_policy').$type<CleanupPolicy>().notNull().default('manual'),
    /** Stable repo identity (root, common dir, initial commit, remote); a change invalidates workspace reuse. */
    repositoryFingerprint: text('repository_fingerprint'),
    activeMergeWorkspaceId: uuid('active_merge_workspace_id').references(
      (): AnyPgColumn => executionWorkspaces.id,
      { onDelete: 'set null' }
    ),
    activeMergeOperationId: text('active_merge_operation_id'),
    activeMergePreHead: text('active_merge_pre_head'),
    activeMergeStartedAt: timestamp('active_merge_started_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_repositories_project').on(t.projectId),
  ]
);

export type ProjectRepository = typeof projectRepositories.$inferSelect;

export type ExecutionWorkspaceStatus =
  | 'preparing'
  | 'ready'
  | 'dirty'
  | 'conflicted'
  | 'merged'
  | 'retained'
  | 'abandoned'
  | 'missing'
  | 'error';

export const EXECUTION_WORKSPACE_TERMINAL_STATUSES = [
  'merged',
  'retained',
  'abandoned',
] as const satisfies readonly ExecutionWorkspaceStatus[];

/**
 * Issue-scoped git worktree. Status records only observable filesystem and
 * Git facts — review and approval state live on the issue and issue_reviews.
 * merged (landed on base), retained (branch kept, issue done) and abandoned
 * (work discarded, issue cancelled) are distinct terminal outcomes; the
 * partial unique index enforces at most one active workspace per issue.
 */
export const executionWorkspaces = pgTable(
  'execution_workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** Survives repository unbinding so terminal rows keep their audit value. */
    repositoryId: uuid('repository_id').references(() => projectRepositories.id, {
      onDelete: 'set null',
    }),
    location: text('location').$type<RepositoryLocation>().notNull(),
    /** Generated by the workspace driver; never supplied by the client. */
    worktreePath: text('worktree_path').notNull(),
    branchName: text('branch_name').notNull(),
    baseRef: text('base_ref').notNull(),
    /** Immutable creation point; cumulative diffs and change fingerprints are relative to it. */
    baseCommit: text('base_commit').notNull(),
    headCommit: text('head_commit'),
    status: text('status').$type<ExecutionWorkspaceStatus>().notNull().default('preparing'),
    lastRunId: uuid('last_run_id').references(() => runs.id, { onDelete: 'set null' }),
    lastError: text('last_error'),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    retainedAt: timestamp('retained_at', { withTimezone: true }),
    abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('execution_workspaces_issue_active')
      .on(t.issueId)
      .where(sql`${t.status} NOT IN ('merged', 'retained', 'abandoned')`),
    index('execution_workspaces_repository_status').on(t.repositoryId, t.status),
    index('execution_workspaces_user_status').on(t.userId, t.status),
  ]
);

export type ExecutionWorkspace = typeof executionWorkspaces.$inferSelect;

/** Per-file view of a captured change set; paths are repo-relative. */
export interface ChangeSummary {
  files: { path: string; status: string; additions: number; deletions: number }[];
  untracked: string[];
  /** File lists capped at the summary limit; snapshot totals still reflect the full change set. */
  truncated?: boolean;
}

/**
 * Platform-collected git evidence for one run. The patch is cumulative
 * against the run's starting commit, so commits the agent created itself are
 * covered. changeFingerprint is content-only relative to the workspace base
 * commit (no HEAD, commit ids, or author metadata), so a checkpoint commit
 * of identical content leaves it — and any approval bound to it — unchanged.
 */
export const runChangeSnapshots = pgTable(
  'run_change_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Nullable so snapshots outlive their workspace row, mirroring runs vs issues. */
    executionWorkspaceId: uuid('execution_workspace_id').references(
      () => executionWorkspaces.id,
      { onDelete: 'set null' }
    ),
    beforeHead: text('before_head').notNull(),
    afterHead: text('after_head').notNull(),
    changedFiles: integer('changed_files').notNull().default(0),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    /** Pre-run state, kept so pre-existing dirt is distinguishable from run output. */
    beforeSummaryJson: jsonb('before_summary_json')
      .$type<ChangeSummary>()
      .notNull()
      .default({ files: [], untracked: [] }),
    afterSummaryJson: jsonb('after_summary_json')
      .$type<ChangeSummary>()
      .notNull()
      .default({ files: [], untracked: [] }),
    changeFingerprint: text('change_fingerprint').notNull(),
    patchStorageKey: text('patch_storage_key'),
    patchTruncated: boolean('patch_truncated').notNull().default(false),
    /** A read-only run mutated tracked files; blocks automated verdicts. */
    policyViolation: boolean('policy_violation').notNull().default(false),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('run_change_snapshots_run').on(t.runId),
    index('run_change_snapshots_workspace').on(t.executionWorkspaceId),
  ]
);

export type RunChangeSnapshot = typeof runChangeSnapshots.$inferSelect;
