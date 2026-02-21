/**
 * Pure functions mapping raw SQLite rows to protocol types.
 * Separated for testability (no database dependency).
 */
import type {
  Agent,
  AgentCapability,
  AgentCostEntry,
  AgentMessage,
  AgentSession,
  AgentState,
  DbMergeQueueEntry,
  EventLevel,
  MailMessage,
  MergeQueueEntry,
  MergeStatus,
  MergeTier,
  MessagePriority,
  MessageType,
  MetricsSession,
  OvrstoryEvent,
  SwarmMetrics,
  TokenSnapshot,
} from "../shared/types.ts";

export interface SessionRow {
  id: string;
  agent_name: string;
  capability: string;
  worktree_path: string;
  branch_name: string;
  bead_id: string;
  tmux_session: string;
  state: string;
  pid: number | null;
  parent_agent: string | null;
  depth: number;
  run_id: string | null;
  started_at: string;
  last_activity: string;
  escalation_level: number;
  stalled_since: string | null;
}

export interface MessageRow {
  id: string;
  from_agent: string;
  to_agent: string;
  subject: string;
  body: string;
  type: string;
  priority: string;
  thread_id: string | null;
  read: number;
  created_at: string;
}

export interface MergeQueueRow {
  id: number;
  branch_name: string;
  bead_id: string;
  agent_name: string;
  files_modified: string;
  enqueued_at: string;
  status: string;
  resolved_tier: string | null;
}

export interface EventRow {
  id: number;
  run_id: string | null;
  agent_name: string;
  session_id: string | null;
  event_type: string;
  tool_name: string | null;
  tool_args: string | null;
  tool_duration_ms: number | null;
  level: string;
  data: string | null;
  created_at: string;
}

export interface MetricsSessionRow {
  agent_name: string;
  bead_id: string;
  capability: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  exit_code: number | null;
  merge_result: string | null;
  parent_agent: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  estimated_cost_usd: number | null;
  model_used: string | null;
}

export interface TokenSnapshotRow {
  id: number;
  agent_name: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  estimated_cost_usd: number | null;
  model_used: string | null;
  created_at: string;
}

// ── DB row → server-internal types ──────────────────────────────────────────

export function mapSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    agentName: row.agent_name,
    capability: row.capability,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    beadId: row.bead_id,
    tmuxSession: row.tmux_session,
    state: row.state as AgentState,
    pid: row.pid,
    parentAgent: row.parent_agent,
    depth: row.depth,
    runId: row.run_id,
    startedAt: row.started_at,
    lastActivity: row.last_activity,
    escalationLevel: row.escalation_level,
    stalledSince: row.stalled_since,
  };
}

export function mapMessage(row: MessageRow): MailMessage {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    subject: row.subject,
    body: row.body,
    type: row.type as MessageType,
    priority: row.priority as MessagePriority,
    threadId: row.thread_id,
    read: row.read === 1,
    createdAt: row.created_at,
  };
}

export function mapMergeEntry(row: MergeQueueRow): DbMergeQueueEntry {
  let filesModified: string[];
  try {
    filesModified = JSON.parse(row.files_modified) as string[];
  } catch {
    filesModified = [];
  }
  return {
    id: row.id,
    branchName: row.branch_name,
    beadId: row.bead_id,
    agentName: row.agent_name,
    filesModified,
    enqueuedAt: row.enqueued_at,
    status: row.status as MergeStatus,
    resolvedTier: row.resolved_tier as MergeTier | null,
  };
}

export function mapEvent(row: EventRow): OvrstoryEvent {
  return {
    id: row.id,
    runId: row.run_id,
    agentName: row.agent_name,
    sessionId: row.session_id,
    eventType: row.event_type,
    toolName: row.tool_name,
    toolArgs: row.tool_args,
    toolDurationMs: row.tool_duration_ms,
    level: row.level as EventLevel,
    data: row.data,
    createdAt: row.created_at,
  };
}

export function mapMetricsSession(row: MetricsSessionRow): MetricsSession {
  return {
    agentName: row.agent_name,
    beadId: row.bead_id,
    capability: row.capability,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    exitCode: row.exit_code,
    mergeResult: row.merge_result,
    parentAgent: row.parent_agent,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    modelUsed: row.model_used,
  };
}

export function mapTokenSnapshot(row: TokenSnapshotRow): TokenSnapshot {
  return {
    id: row.id,
    agentName: row.agent_name,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    modelUsed: row.model_used,
    createdAt: row.created_at,
  };
}

// ── server-internal types → viz protocol types ───────────────────────────────

const KNOWN_CAPABILITIES = new Set<string>([
  'coordinator', 'lead', 'scout', 'builder', 'reviewer', 'merger',
]);

/** Map AgentSession to viz-layer Agent for WebSocket transmission */
export function toAgent(s: AgentSession): Agent {
  const cap = KNOWN_CAPABILITIES.has(s.capability)
    ? (s.capability as AgentCapability)
    : 'builder';
  return {
    name: s.agentName,
    capability: cap,
    state: s.state,
    parentAgent: s.parentAgent,
    depth: s.depth,
    beadId: s.beadId || null,
    lastActivity: new Date(s.lastActivity).getTime(),
  };
}

/** Map MailMessage to viz-layer AgentMessage for WebSocket transmission */
export function toAgentMessage(m: MailMessage): AgentMessage {
  return {
    id: m.id,
    from: m.fromAgent,
    to: m.toAgent,
    type: m.type,
    priority: m.priority,
    subject: m.subject,
    createdAt: new Date(m.createdAt).getTime(),
  };
}

/** Map DbMergeQueueEntry to viz-layer MergeQueueEntry for WebSocket transmission */
export function toVizMergeEntry(e: DbMergeQueueEntry): MergeQueueEntry {
  return {
    branchName: e.branchName,
    agentName: e.agentName,
    status: e.status,
    filesModified: e.filesModified,
  };
}

function modelShorthand(model: string | null): string {
  if (!model) return '';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('gpt-4')) return 'gpt-4';
  if (m.includes('gpt-3')) return 'gpt-3';
  // Return first 8 chars as fallback
  return model.slice(0, 8);
}

/** Compute SwarmMetrics from current DB state */
export function computeMetrics(
  sessions: AgentSession[],
  totalMessages: number,
  metricsSessions: MetricsSession[],
  costPerMinute = 0,
): SwarmMetrics {
  const activeAgents = sessions.filter(
    (s) => s.state === 'working' || s.state === 'booting',
  ).length;

  // Aggregate per-agent costs from metrics sessions (last entry per agent wins)
  const agentCostMap = new Map<string, AgentCostEntry>();
  for (const s of metricsSessions) {
    const existing = agentCostMap.get(s.agentName);
    const entry: AgentCostEntry = {
      agentName: s.agentName,
      capability: s.capability,
      modelUsed: modelShorthand(s.modelUsed),
      costUsd: (existing?.costUsd ?? 0) + (s.estimatedCostUsd ?? 0),
      inputTokens: (existing?.inputTokens ?? 0) + s.inputTokens,
      outputTokens: (existing?.outputTokens ?? 0) + s.outputTokens,
      cacheReadTokens: (existing?.cacheReadTokens ?? 0) + s.cacheReadTokens,
    };
    // Use most recent model for this agent
    if (s.modelUsed) entry.modelUsed = modelShorthand(s.modelUsed);
    agentCostMap.set(s.agentName, entry);
  }

  const agentCosts = [...agentCostMap.values()].sort((a, b) => b.costUsd - a.costUsd);

  const totalCost = agentCosts.reduce((sum, e) => sum + e.costUsd, 0);
  const totalInputTokens = agentCosts.reduce((sum, e) => sum + e.inputTokens, 0);
  const totalOutputTokens = agentCosts.reduce((sum, e) => sum + e.outputTokens, 0);
  const totalCacheReadTokens = agentCosts.reduce((sum, e) => sum + e.cacheReadTokens, 0);

  return {
    totalAgents: sessions.length,
    activeAgents,
    totalMessages,
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    costPerMinute,
    agentCosts,
  };
}
