// Protocol types shared between server and client

// ── Agent sessions (sessions.db) — server-internal ──────────────────────────

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

// ── Mail messages (mail.db) — server-internal ────────────────────────────────

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

// ── Merge queue (merge-queue.db) — server-internal ──────────────────────────

export type MergeStatus = 'pending' | 'merging' | 'merged' | 'conflict' | 'failed';
export type MergeTier = 'clean-merge' | 'auto-resolve' | 'ai-resolve' | 'reimagine';

/** Full DB-mapped merge queue entry (server-internal, not sent over wire) */
export interface DbMergeQueueEntry {
  id: number;
  branchName: string;
  beadId: string;
  agentName: string;
  filesModified: string[];
  enqueuedAt: string;
  status: MergeStatus;
  resolvedTier: MergeTier | null;
}

// ── Events (events.db) — server-internal ────────────────────────────────────

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

// ── Metrics (metrics.db) — server-internal ──────────────────────────────────

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

// ── Viz protocol types (WebSocket wire format, server → client) ───────────────

export type AgentCapability =
  | 'coordinator'
  | 'lead'
  | 'scout'
  | 'builder'
  | 'reviewer'
  | 'merger';

/** Visualization-layer agent (mapped from AgentSession, safe to send to browser) */
export interface Agent {
  name: string;
  capability: AgentCapability;
  state: AgentState;
  parentAgent: string | null;
  depth: number;
  beadId: string | null;
  /** Unix timestamp in milliseconds */
  lastActivity: number;
}

/** Visualization-layer message (mapped from MailMessage, safe to send to browser) */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  priority: string;
  subject: string;
  /** Unix timestamp in milliseconds */
  createdAt: number;
}

/** Visualization-layer merge queue entry */
export interface MergeQueueEntry {
  branchName: string;
  agentName: string;
  status: MergeStatus;
  filesModified: string[];
}

/** Per-agent cost entry for the cost leaderboard */
export interface AgentCostEntry {
  agentName: string;
  capability: string;
  modelUsed: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** Aggregated swarm metrics displayed in HUD */
export interface SwarmMetrics {
  totalAgents: number;
  activeAgents: number;
  totalMessages: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  costPerMinute: number;
  agentCosts: AgentCostEntry[];
}

/** Full state snapshot sent on initial connection */
export interface StateSnapshot {
  agents: Agent[];
  messages: AgentMessage[];
  mergeQueue: MergeQueueEntry[];
  metrics: SwarmMetrics;
}

/** A tool event emitted when an agent calls a tool */
export interface ToolEventData {
  agentName: string;
  toolName: string | null;
  eventType: string;
  createdAt: string;
}

/** Incremental update sent when a single entity changes */
export type StateUpdate =
  | { type: 'agent_update'; data: Agent }
  | { type: 'message_event'; data: AgentMessage }
  | { type: 'merge_update'; data: MergeQueueEntry }
  | { type: 'metrics_update'; data: SwarmMetrics }
  | { type: 'tool_event'; data: ToolEventData };

/** A discovered project with an active .overstory/ directory */
export interface DiscoveredProject {
  /** Human-readable project name (directory basename) */
  name: string;
  /** Absolute path to the project root */
  path: string;
  /** Absolute path to the .overstory/ directory */
  overstoryDir: string;
  /** Whether this project is the currently active data source */
  active: boolean;
  /** Number of active agents (0 if not currently connected) */
  activeAgents: number;
}

/** Dashboard mode sent to clients */
export type DashboardMode = 'live' | 'demo';

/** Dashboard state update sent on connect and when mode changes */
export interface DashboardState {
  mode: DashboardMode;
  /** The active project name when mode='live', null when mode='demo' */
  activeProject: string | null;
  /** All discovered projects */
  projects: DiscoveredProject[];
}

/** WebSocket protocol message (server → client) */
export type ServerMessage =
  | { type: 'snapshot'; data: StateSnapshot }
  | { type: 'update'; data: StateUpdate }
  | { type: 'dashboard_state'; data: DashboardState };
