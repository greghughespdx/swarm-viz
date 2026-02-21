import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { join } from "node:path";
import type {
  Agent,
  AgentSession,
  DbMergeQueueEntry,
  MailMessage,
  MetricsSession,
  ServerMessage,
  StateSnapshot,
  StateUpdate,
  SwarmMetrics,
} from "../shared/types.ts";
import {
  computeMetrics,
  mapMessage,
  mapMergeEntry,
  mapMetricsSession,
  mapSession,
  toAgent,
  toAgentMessage,
  toVizMergeEntry,
} from "./mappers.ts";
import type {
  MessageRow,
  MergeQueueRow,
  MetricsSessionRow,
  SessionRow,
} from "./mappers.ts";
import { DemoSimulator } from "./simulator.ts";

// ── Configuration ────────────────────────────────────────────────────────────

const OVERSTORY_DIR =
  process.env["OVERSTORY_DIR"] ?? `${import.meta.dir}/../.overstory`;
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const POLL_INTERVAL_MS = parseInt(process.env["POLL_INTERVAL_MS"] ?? "500", 10);
const STATIC_DIR = process.env["STATIC_DIR"] ?? join(import.meta.dir, "../dist");
const MAX_RECENT_MESSAGES = 50;
const DEMO_MODE = process.env["DEMO_MODE"] === "true";

// ── Graceful database open ────────────────────────────────────────────────────

function openDb(path: string, label: string, required: boolean): Database | null {
  try {
    if (!Bun.file(path).size) throw new Error(`${label} does not exist or is empty`);
    // Open read-write briefly to allow WAL recovery, then reopen readonly
    const rw = new Database(path);
    rw.close();
    return new Database(path, { readonly: true });
  } catch (err) {
    if (required) {
      console.error(`[swarm-viz] Failed to open required database ${label}:`, err);
      console.error(`  Path: ${path}`);
      console.error(`  Set OVERSTORY_DIR to the .overstory directory path`);
      process.exit(1);
    }
    console.warn(`[swarm-viz] Optional database ${label} not available: ${path}`);
    return null;
  }
}

function makeMetricsStatements(db: Database) {
  return {
    allSessions: db.query<MetricsSessionRow, []>(
      `SELECT agent_name, bead_id, capability, started_at, completed_at,
              duration_ms, exit_code, merge_result, parent_agent,
              input_tokens, output_tokens, cache_read_tokens,
              cache_creation_tokens, estimated_cost_usd, model_used
       FROM sessions
       ORDER BY started_at DESC`
    ),
  };
}

type MetricsStatements = ReturnType<typeof makeMetricsStatements>;

// ── Setup: demo mode or live databases ──────────────────────────────────────

let _simulator: DemoSimulator | null = null;
let metricsDb: Database | null = null;

let querySessions: () => AgentSession[];
let queryRecentMessages: () => MailMessage[];
let queryNewMessages: (since: string) => MailMessage[];
let queryMessageCount: () => number;
let queryMergeQueue: () => DbMergeQueueEntry[];
let queryMetricsSessions: () => MetricsSession[];

if (DEMO_MODE) {
  _simulator = new DemoSimulator();
  const sim = _simulator;
  querySessions = () => sim.querySessions();
  queryRecentMessages = () => sim.queryRecentMessages();
  queryNewMessages = (since) => sim.queryNewMessages(since);
  queryMessageCount = () => sim.queryMessageCount();
  queryMergeQueue = () => sim.queryMergeQueue();
  queryMetricsSessions = () => sim.queryMetricsSessions();
} else {
  // Core databases — gracefully handle missing DBs from fresh overstory init
  const sessionsDb = openDb(`${OVERSTORY_DIR}/sessions.db`, "sessions.db", true)!;
  const mailDb = openDb(`${OVERSTORY_DIR}/mail.db`, "mail.db", false);
  const mergeQueueDb = openDb(`${OVERSTORY_DIR}/merge-queue.db`, "merge-queue.db", false);

  // Optional databases — continue with degraded data if unavailable
  metricsDb = openDb(`${OVERSTORY_DIR}/metrics.db`, "metrics.db", false);

  // Prepared statements
  const stmtAllSessions = sessionsDb.query<SessionRow, []>(
    "SELECT * FROM sessions ORDER BY depth ASC, started_at ASC"
  );

  const stmtRecentMessages = mailDb?.query<MessageRow, [number]>(
    `SELECT id, from_agent, to_agent, subject, body, type, priority,
            thread_id, read, created_at
     FROM messages
     ORDER BY created_at DESC
     LIMIT ?`
  ) ?? null;

  const stmtNewMessages = mailDb?.query<MessageRow, [string]>(
    `SELECT id, from_agent, to_agent, subject, body, type, priority,
            thread_id, read, created_at
     FROM messages
     WHERE created_at > ?
     ORDER BY created_at ASC`
  ) ?? null;

  const stmtMessageCount = mailDb?.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM messages"
  ) ?? null;

  let stmtMergeQueue: ReturnType<Database["query"]> | null = null;
  try {
    stmtMergeQueue = mergeQueueDb?.query<MergeQueueRow, []>(
      "SELECT * FROM merge_queue WHERE status IN ('pending', 'merging') ORDER BY enqueued_at DESC"
    ) ?? null;
  } catch { /* table may not exist yet */ }

  let metricsStmts: MetricsStatements | null = null;
  try {
    metricsStmts = metricsDb ? makeMetricsStatements(metricsDb) : null;
  } catch { /* tables may not exist yet */ }

  querySessions = () => stmtAllSessions.all().map(mapSession);
  queryRecentMessages = () =>
    stmtRecentMessages?.all(MAX_RECENT_MESSAGES).map(mapMessage).reverse() ?? [];
  queryNewMessages = (since) => stmtNewMessages?.all(since).map(mapMessage) ?? [];
  queryMessageCount = () => {
    const row = stmtMessageCount?.get();
    return row?.count ?? 0;
  };
  queryMergeQueue = () => stmtMergeQueue?.all().map(mapMergeEntry) ?? [];
  queryMetricsSessions = () => {
    if (!metricsStmts) {
      if (metricsDb === null) {
        metricsDb = openDb(`${OVERSTORY_DIR}/metrics.db`, "metrics.db", false);
        if (metricsDb) {
          metricsStmts = makeMetricsStatements(metricsDb);
        }
      }
      if (!metricsStmts) return [];
    }
    try {
      return metricsStmts.allSessions.all().map(mapMetricsSession);
    } catch (err) {
      console.warn("[swarm-viz] Error querying metrics sessions:", err);
      metricsStmts = null;
      metricsDb = null;
      return [];
    }
  };
}

// ── Viz-layer snapshot builder ───────────────────────────────────────────────

function buildSnapshot(): StateSnapshot {
  const sessions = querySessions();
  const messages = queryRecentMessages();
  const mergeQueue = queryMergeQueue();
  const metricsSessions = queryMetricsSessions();
  const totalMessages = queryMessageCount();

  return {
    agents: sessions.map(toAgent),
    messages: messages.map(toAgentMessage),
    mergeQueue: mergeQueue.map(toVizMergeEntry),
    metrics: computeMetrics(sessions, totalMessages, metricsSessions),
  };
}

// ── Per-client delta tracking ─────────────────────────────────────────────────

interface ClientState {
  /** agent name → serialized state for change detection */
  agentStateMap: Map<string, string>;
  /** ISO timestamp of the last message seen */
  lastMessageTimestamp: string;
  /** branchName → status string */
  mergeStatusMap: Map<string, string>;
  /** cached metrics key for change detection */
  metricsKey: string;
  /** last known total message count */
  lastTotalMessages: number;
}

function metricsKey(m: SwarmMetrics): string {
  return `${m.totalAgents}:${m.activeAgents}:${m.totalMessages}:${m.totalCost.toFixed(6)}`;
}

function agentKey(a: Agent): string {
  return `${a.state}:${a.lastActivity}:${a.parentAgent ?? ""}`;
}

function initClientState(snapshot: StateSnapshot): ClientState {
  const agentStateMap = new Map<string, string>();
  for (const a of snapshot.agents) {
    agentStateMap.set(a.name, agentKey(a));
  }

  const lastMsg = snapshot.messages[snapshot.messages.length - 1];
  const lastMessageTimestamp = lastMsg
    ? new Date(lastMsg.createdAt).toISOString()
    : new Date(0).toISOString();

  const mergeStatusMap = new Map<string, string>();
  for (const e of snapshot.mergeQueue) {
    mergeStatusMap.set(e.branchName, e.status);
  }

  return {
    agentStateMap,
    lastMessageTimestamp,
    mergeStatusMap,
    metricsKey: metricsKey(snapshot.metrics),
    lastTotalMessages: snapshot.metrics.totalMessages,
  };
}

/**
 * Compute incremental updates since the last poll.
 * Returns an array of StateUpdate events to send (empty = no changes).
 */
function computeUpdates(state: ClientState): StateUpdate[] {
  const updates: StateUpdate[] = [];

  const sessions = querySessions();
  const vizAgents = sessions.map(toAgent);

  // Agent changes (new agents or state/activity changes)
  for (const agent of vizAgents) {
    const prev = state.agentStateMap.get(agent.name);
    if (prev === undefined || prev !== agentKey(agent)) {
      updates.push({ type: "agent_update", data: agent });
    }
  }

  // New messages since last poll
  if (state.lastMessageTimestamp) {
    const newMail = queryNewMessages(state.lastMessageTimestamp).map(toAgentMessage);
    for (const msg of newMail) {
      updates.push({ type: "message_event", data: msg });
    }
    if (newMail.length > 0) {
      const lastNew = newMail[newMail.length - 1];
      if (lastNew) {
        state.lastMessageTimestamp = new Date(lastNew.createdAt).toISOString();
      }
    }
  }

  // Merge queue changes
  const currentMerge = queryMergeQueue().map(toVizMergeEntry);
  for (const entry of currentMerge) {
    const prev = state.mergeStatusMap.get(entry.branchName);
    if (prev === undefined || prev !== entry.status) {
      updates.push({ type: "merge_update", data: entry });
    }
  }

  // Metrics update (check if anything changed)
  const totalMessages = queryMessageCount();
  const metricsSessions = queryMetricsSessions();
  const currentMetrics = computeMetrics(sessions, totalMessages, metricsSessions);
  const currentKey = metricsKey(currentMetrics);
  if (currentKey !== state.metricsKey) {
    updates.push({ type: "metrics_update", data: currentMetrics });
    state.metricsKey = currentKey;
    state.lastTotalMessages = totalMessages;
  }

  // Advance agent tracking state
  state.agentStateMap.clear();
  for (const a of vizAgents) {
    state.agentStateMap.set(a.name, agentKey(a));
  }
  state.mergeStatusMap.clear();
  for (const e of currentMerge) {
    state.mergeStatusMap.set(e.branchName, e.status);
  }

  return updates;
}

// ── Static file serving ──────────────────────────────────────────────────────

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");

  if (rel.includes("..")) {
    return new Response("Forbidden", { status: 403 });
  }

  const filePath = join(STATIC_DIR, rel);
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    const index = Bun.file(join(STATIC_DIR, "index.html"));
    if (await index.exists()) {
      return new Response(index, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  }

  return new Response(file);
}

// ── WebSocket server ─────────────────────────────────────────────────────────

const clientStates = new Map<ServerWebSocket, ClientState>();

export const server = Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", databases: { metrics: metricsDb !== null } }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return serveStatic(url.pathname);
  },

  websocket: {
    open(ws) {
      try {
        const snapshot = buildSnapshot();
        const state = initClientState(snapshot);
        clientStates.set(ws, state);
        const msg: ServerMessage = { type: "snapshot", data: snapshot };
        ws.send(JSON.stringify(msg));
      } catch (err) {
        console.error("Error sending snapshot to new client:", err);
        ws.close(1011, "Internal server error");
      }
    },

    close(ws) {
      clientStates.delete(ws);
    },

    message(_ws, _data) {
      // Client → server messages not used; visualization is read-only
    },
  },
});

if (DEMO_MODE) {
  console.log("[swarm-viz] Demo mode active");
}
console.log(`[swarm-viz] Server listening on http://localhost:${PORT}`);
console.log(`[swarm-viz] WebSocket endpoint: ws://localhost:${PORT}/ws`);
console.log(`[swarm-viz] Static files from: ${STATIC_DIR}`);

// ── Poll loop ────────────────────────────────────────────────────────────────

setInterval(() => {
  if (_simulator) _simulator.tick();
  if (clientStates.size === 0) return;

  for (const [ws, state] of clientStates) {
    try {
      const updates = computeUpdates(state);
      for (const update of updates) {
        const msg: ServerMessage = { type: "update", data: update };
        ws.send(JSON.stringify(msg));
      }
    } catch (err) {
      console.error("Error computing or sending updates:", err);
    }
  }
}, POLL_INTERVAL_MS);
