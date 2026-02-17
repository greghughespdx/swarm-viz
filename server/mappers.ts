/**
 * Pure functions mapping raw SQLite rows to protocol types.
 * Separated for testability (no database dependency).
 */
import type {
  AgentSession,
  AgentState,
  EventLevel,
  MailMessage,
  MergeQueueEntry,
  MergeStatus,
  MergeTier,
  MessagePriority,
  MessageType,
  MetricsSession,
  OvrstoryEvent,
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

export function mapMergeEntry(row: MergeQueueRow): MergeQueueEntry {
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
