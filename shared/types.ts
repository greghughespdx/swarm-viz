// Protocol types shared between server and client

// ── Agent sessions (sessions.db) ────────────────────────────────────────────

export type AgentState = 'booting' | 'working' | 'completed' | 'stalled' | 'zombie';

export interface AgentSession {
  id: string;
  agentName: string;
  capability: string;
  worktreePath: string;
  branchName: string;
  beadId: string;
  tmuxSession: string;
  state: AgentState;
  pid: number | null;
  parentAgent: string | null;
  depth: number;
  runId: string | null;
  startedAt: string;
  lastActivity: string;
  escalationLevel: number;
  stalledSince: string | null;
}

// ── Mail messages (mail.db) ─────────────────────────────────────────────────

export type MessageType =
  | 'status'
  | 'question'
  | 'result'
  | 'error'
  | 'worker_done'
  | 'merge_ready'
  | 'merged'
  | 'merge_failed'
  | 'escalation'
  | 'health_check'
  | 'dispatch'
  | 'assign';

export type MessagePriority = 'low' | 'normal' | 'high' | 'urgent';

export interface MailMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  subject: string;
  body: string;
  type: MessageType;
  priority: MessagePriority;
  threadId: string | null;
  read: boolean;
  createdAt: string;
}

// ── Merge queue (merge-queue.db) ────────────────────────────────────────────

export type MergeStatus = 'pending' | 'merging' | 'merged' | 'conflict' | 'failed';
export type MergeTier = 'clean-merge' | 'auto-resolve' | 'ai-resolve' | 'reimagine';

export interface MergeQueueEntry {
  id: number;
  branchName: string;
  beadId: string;
  agentName: string;
  filesModified: string[];
  enqueuedAt: string;
  status: MergeStatus;
  resolvedTier: MergeTier | null;
}

// ── Events (events.db) ──────────────────────────────────────────────────────

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface OvrstoryEvent {
  id: number;
  runId: string | null;
  agentName: string;
  sessionId: string | null;
  eventType: string;
  toolName: string | null;
  toolArgs: string | null;
  toolDurationMs: number | null;
  level: EventLevel;
  data: string | null;
  createdAt: string;
}

// ── Metrics (metrics.db) ────────────────────────────────────────────────────

export interface MetricsSession {
  agentName: string;
  beadId: string;
  capability: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  exitCode: number | null;
  mergeResult: string | null;
  parentAgent: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number | null;
  modelUsed: string | null;
}

export interface TokenSnapshot {
  id: number;
  agentName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number | null;
  modelUsed: string | null;
  createdAt: string;
}

// ── WebSocket protocol (server → client) ────────────────────────────────────

/** Full state snapshot sent on initial connection */
export interface SwarmSnapshot {
  timestamp: string;
  sessions: AgentSession[];
  recentMessages: MailMessage[];
  mergeQueue: MergeQueueEntry[];
  recentEvents: OvrstoryEvent[];
  metricsSessions: MetricsSession[];
}

/** Incremental update sent on state changes */
export interface SwarmDelta {
  timestamp: string;
  /** Sessions whose state or activity changed (includes new sessions) */
  sessionsChanged: AgentSession[];
  /** Messages received since last snapshot/delta */
  newMessages: MailMessage[];
  /** Merge queue entries whose status changed */
  mergeQueueChanged: MergeQueueEntry[];
  /** Events received since last snapshot/delta */
  newEvents: OvrstoryEvent[];
  /** Metrics sessions updated since last snapshot/delta */
  metricsUpdated: MetricsSession[];
}

export type ServerMessage =
  | { type: 'snapshot'; data: SwarmSnapshot }
  | { type: 'delta'; data: SwarmDelta };
