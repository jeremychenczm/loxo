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
  /** Monotonic per-user task number source; incremented inside the create-task transaction. */
  taskCounter: integer('task_counter').notNull().default(0),
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

/** Saved roster of agents; a task copies its members from a crew when it is created. */
export const crews = pgTable('crews', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Crew = typeof crews.$inferSelect;

export const crewMembers = pgTable(
  'crew_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    crewId: uuid('crew_id')
      .notNull()
      .references(() => crews.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Roster order; deleting a member agent can leave gaps. */
    position: integer('position').notNull(),
  },
  (t) => [
    uniqueIndex('crew_members_crew_agent').on(t.crewId, t.agentId),
    uniqueIndex('crew_members_crew_position').on(t.crewId, t.position),
  ]
);

export type CrewMember = typeof crewMembers.$inferSelect;

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
  /** Set on the system message posted when a chat topic is filed as a task. */
  taskId?: string;
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

/** A command the platform runs in a workspace to verify it; runs through the system shell. */
export interface RepositoryCheck {
  name: string;
  command: string;
  timeoutSeconds: number;
}

/**
 * A git repository on the host, registered by the root of its primary
 * checkout. Loxo adds worktrees and branches beside it and writes to the
 * primary checkout only during an explicit merge. The activeMerge* columns
 * form a compare-and-set lock: at most one workspace may mutate the primary
 * checkout, and the persisted operation id and pre-merge HEAD let crash
 * recovery prove whether an interrupted merge never started, aborted, or
 * completed — staleness is never inferred from age alone.
 */
export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Primary checkout root as reported by git. */
    rootPath: text('root_path').notNull(),
    /** Must resolve to a local branch under refs/heads/; the only valid merge target. */
    defaultBranch: text('default_branch').notNull().default('main'),
    setupCommand: text('setup_command'),
    checks: jsonb('checks').$type<RepositoryCheck[]>().notNull().default([]),
    /** Stable repo identity (root, common dir, initial commit, remote); a change invalidates workspace reuse. */
    fingerprint: text('fingerprint').notNull(),
    activeMergeWorkspaceId: uuid('active_merge_workspace_id').references(
      (): AnyPgColumn => workspaces.id,
      { onDelete: 'set null' }
    ),
    activeMergeOperationId: text('active_merge_operation_id'),
    activeMergePreHead: text('active_merge_pre_head'),
    activeMergeStartedAt: timestamp('active_merge_started_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('repositories_user_root').on(t.userId, t.rootPath)]
);

export type Repository = typeof repositories.$inferSelect;

export type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

/**
 * Unit of work. Status transitions are enforced by a static transition table
 * in the tasks service, never by direct writes. The lead is always one of
 * the task's active members. number is unique per user and drawn from
 * users.taskCounter.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null for tasks that need no code, such as discussions. */
    repositoryId: uuid('repository_id').references((): AnyPgColumn => repositories.id, {
      onDelete: 'set null',
    }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** The requirement as the user wrote it. */
    brief: text('brief').notNull().default(''),
    status: text('status').$type<TaskStatus>().notNull().default('backlog'),
    leadAgentId: uuid('lead_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** Source for turns.seq; incremented in the same transaction that inserts a turn. */
    turnCounter: integer('turn_counter').notNull().default(0),
    /** Position within a kanban column; fractional values allow reorder without renumbering. */
    boardOrder: doublePrecision('board_order').notNull().default(0),
    /**
     * Execution lock: the run currently working this task. Wake admission
     * acquires it with a conditional UPDATE, so the same task is never
     * executed by two runs at once regardless of trigger source.
     */
    activeRunId: uuid('active_run_id').references((): AnyPgColumn => runs.id, {
      onDelete: 'set null',
    }),
    /** Chat conversation this task was filed from. A conversation can spawn many tasks. */
    sourceConversationId: uuid('source_conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('tasks_user_number').on(t.userId, t.number),
    index('tasks_user_status').on(t.userId, t.status),
    index('tasks_repository_status').on(t.repositoryId, t.status),
    index('tasks_lead_agent').on(t.leadAgentId, t.status),
    index('tasks_source_conversation').on(t.sourceConversationId),
  ]
);

export type Task = typeof tasks.$inferSelect;

export type TaskMemberState = 'active' | 'paused' | 'removed';

/**
 * Agents taking part in a task. Removed members keep their row so their
 * turns and runtime session stay attributable.
 */
export const taskMembers = pgTable(
  'task_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Speaking order among members. */
    position: integer('position').notNull(),
    state: text('state').$type<TaskMemberState>().notNull().default('active'),
    pausedReason: text('paused_reason'),
    /** Runtime-native session reused across this member's turns. */
    runtimeSessionId: text('runtime_session_id'),
    /** Bumped when the runtime session is replaced, so context delivery starts over. */
    sessionEpoch: integer('session_epoch').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('task_members_task_agent').on(t.taskId, t.agentId),
    index('task_members_agent').on(t.agentId),
  ]
);

export type TaskMember = typeof taskMembers.$inferSelect;


export type RunTrigger = 'assignment' | 'manual' | 'comment' | 'chat' | 'review';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * One admitted wake-up of an agent. Every trigger source funnels through the
 * wake admission service, which creates exactly one row per admitted wake-up.
 * Queued rows double as the wait queue for a task's execution lock and are
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
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
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
    index('runs_task_status').on(t.taskId, t.status),
    index('runs_agent_status').on(t.agentId, t.status),
    index('runs_user_created').on(t.userId, t.createdAt),
  ]
);

export type Run = typeof runs.$inferSelect;

export type TurnKind = 'agent' | 'human' | 'system';

export type TurnStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** Structured output a turn hands back; shape depends on the reporting tool. */
export type TurnReport = Record<string, unknown>;

/**
 * One contribution to a task, in dispatch order: an agent's work or
 * statement, a person's interjection, or a platform event. seq is drawn from
 * tasks.turnCounter, so the timeline order never depends on clock ties.
 */
export const turns = pgTable(
  'turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    /** Playbook phase the turn belongs to; null outside a playbook. */
    phase: text('phase'),
    kind: text('kind').$type<TurnKind>().notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    /** Worktree the turn runs in; null for turns that touch no code. */
    workspaceId: uuid('workspace_id').references((): AnyPgColumn => workspaces.id, {
      onDelete: 'set null',
    }),
    permission: text('permission').$type<AgentPermissionLevel>(),
    status: text('status').$type<TurnStatus>().notNull().default('pending'),
    report: jsonb('report').$type<TurnReport>(),
    content: text('content').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('turns_task_seq').on(t.taskId, t.seq),
    index('turns_run').on(t.runId),
    // A worktree has at most one writer at a time; readers are unrestricted.
    uniqueIndex('turns_workspace_single_writer')
      .on(t.workspaceId)
      .where(sql`${t.status} = 'running' AND ${t.permission} IN ('edit', 'full')`),
    check(
      'turns_author_matches_kind',
      sql`(${t.kind} = 'agent' OR ${t.agentId} IS NULL) AND (${t.kind} = 'human' OR ${t.authorUserId} IS NULL)`
    ),
  ]
);

export type Turn = typeof turns.$inferSelect;

export type ApprovalDecision = 'approved' | 'changes_requested';

/**
 * A person's decision on a task's work; agents never approve, their verdicts
 * are turns. Code approvals pin the workspace fingerprint they were made
 * against, so any later change makes them stale.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    decision: text('decision').$type<ApprovalDecision>().notNull(),
    body: text('body').notNull(),
    changeSnapshotId: uuid('change_snapshot_id').references(
      (): AnyPgColumn => changeSnapshots.id,
      { onDelete: 'set null' }
    ),
    /** Null for tasks without a repository. */
    fingerprint: text('fingerprint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('approvals_task_created').on(t.taskId, t.createdAt)]
);

export type Approval = typeof approvals.$inferSelect;

export type WorkspaceStatus =
  | 'preparing'
  | 'ready'
  | 'dirty'
  | 'conflicted'
  | 'merged'
  | 'retained'
  | 'abandoned'
  | 'missing'
  | 'error';

export const WORKSPACE_TERMINAL_STATUSES = [
  'merged',
  'retained',
  'abandoned',
] as const satisfies readonly WorkspaceStatus[];

/**
 * integration: the branch the platform merges into and delivers; member: one
 * agent's working branch; review: a read-only checkout for one reviewer.
 */
export type WorkspaceKind = 'integration' | 'member' | 'review';

/**
 * Task-scoped git worktree; a task can hold several. Status records only
 * observable filesystem and Git facts — review and approval state live on
 * the task and approvals. merged (landed on base), retained (branch kept,
 * task done) and abandoned (work discarded, task cancelled) are distinct
 * terminal outcomes. Partial unique indexes allow one active integration
 * workspace per task and one active workspace per (task, kind, agent).
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Survives repository removal so terminal rows keep their audit value. */
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').$type<WorkspaceKind>().notNull(),
    /** Owning member for member and review workspaces; null for integration. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** Generated by the workspace driver; never supplied by the client. */
    worktreePath: text('worktree_path').notNull(),
    branchName: text('branch_name').notNull(),
    baseRef: text('base_ref').notNull(),
    /** Immutable creation point; cumulative diffs and change fingerprints are relative to it. */
    baseCommit: text('base_commit').notNull(),
    headCommit: text('head_commit'),
    status: text('status').$type<WorkspaceStatus>().notNull().default('preparing'),
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
    uniqueIndex('workspaces_task_integration_active')
      .on(t.taskId)
      .where(
        sql`${t.kind} = 'integration' AND ${t.status} NOT IN ('merged', 'retained', 'abandoned')`
      ),
    uniqueIndex('workspaces_task_agent_active')
      .on(t.taskId, t.kind, t.agentId)
      .where(
        sql`${t.kind} <> 'integration' AND ${t.status} NOT IN ('merged', 'retained', 'abandoned')`
      ),
    index('workspaces_repository_status').on(t.repositoryId, t.status),
    index('workspaces_user_status').on(t.userId, t.status),
  ]
);

export type Workspace = typeof workspaces.$inferSelect;

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
export const changeSnapshots = pgTable(
  'change_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Nullable so snapshots outlive their workspace row, mirroring runs vs tasks. */
    workspaceId: uuid('workspace_id').references(
      () => workspaces.id,
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
    uniqueIndex('change_snapshots_run').on(t.runId),
    index('change_snapshots_workspace').on(t.workspaceId),
  ]
);

export type ChangeSnapshot = typeof changeSnapshots.$inferSelect;
