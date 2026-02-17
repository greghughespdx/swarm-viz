import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { join } from "node:path";
import type {
  AgentSession,
  MailMessage,
  MergeQueueEntry,
  MetricsSession,
  OvrstoryEvent,
  ServerMessage,
  SwarmDelta,
  SwarmSnapshot,
} from "../shared/types.ts";
import {
  mapEvent,
  mapMessage,
  mapMergeEntry,
  mapMetricsSession,
  mapSession,
} from "./mappers.ts";
import type {
  EventRow,
  MessageRow,
  MergeQueueRow,
  MetricsSessionRow,
  SessionRow,
} from "./mappers.ts";

// ── Configuration ────────────────────────────────────────────────────────────

const OVERSTORY_DIR =
  process.env["OVERSTORY_DIR"] ?? `${import.meta.dir}/../.overstory`;
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const POLL_INTERVAL_MS = parseInt(process.env["POLL_INTERVAL_MS"] ?? "500", 10);
const STATIC_DIR = process.env["STATIC_DIR"] ?? join(import.meta.dir, "../dist");
const MAX_RECENT_MESSAGES = 50;
const MAX_RECENT_EVENTS = 100;

// ── Graceful database open ────────────────────────────────────────────────────

function openDb(path: string, label: string, required: boolean): Database | null {
  try {
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

// Core databases (required) — exit if unavailable
const sessionsDb = openDb(`${OVERSTORY_DIR}/sessions.db`, "sessions.db", true)!;
const mailDb = openDb(`${OVERSTORY_DIR}/mail.db`, "mail.db", true)!;
const mergeQueueDb = openDb(`${OVERSTORY_DIR}/merge-queue.db`, "merge-queue.db", true)!;

// Optional databases — continue with degraded data if unavailable
let eventsDb: Database | null = openDb(`${OVERSTORY_DIR}/events.db`, "events.db", false);
let metricsDb: Database | null = openDb(`${OVERSTORY_DIR}/metrics.db`, "metrics.db", false);

// ── Prepared statements ──────────────────────────────────────────────────────

const stmtAllSessions = sessionsDb.query<SessionRow, []>(
  "SELECT * FROM sessions ORDER BY depth ASC, started_at ASC"
);

const stmtRecentMessages = mailDb.query<MessageRow, [number]>(
  `SELECT id, from_agent, to_agent, subject, body, type, priority,
          thread_id, read, created_at
   FROM messages
   ORDER BY created_at DESC
   LIMIT ?`
);

const stmtNewMessages = mailDb.query<MessageRow, [string]>(
  `SELECT id, from_agent, to_agent, subject, body, type, priority,
          thread_id, read, created_at
   FROM messages
   WHERE created_at > ?
   ORDER BY created_at ASC`
);

const stmtMergeQueue = mergeQueueDb.query<MergeQueueRow, []>(
  "SELECT * FROM merge_queue ORDER BY enqueued_at DESC"
);

// Events and metrics statements are created lazily since these DBs are optional
function makeEventStatements(db: Database) {
  return {
    recent: db.query<EventRow, [number]>(
      `SELECT id, run_id, agent_name, session_id, event_type, tool_name,
              tool_args, tool_duration_ms, level, data, created_at
       FROM events
       ORDER BY created_at DESC
       LIMIT ?`
    ),
    since: db.query<EventRow, [string]>(
      `SELECT id, run_id, agent_name, session_id, event_type, tool_name,
              tool_args, tool_duration_ms, level, data, created_at
       FROM events
       WHERE created_at > ?
       ORDER BY created_at ASC`
    ),
  };
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

type EventStatements = ReturnType<typeof makeEventStatements>;
type MetricsStatements = ReturnType<typeof makeMetricsStatements>;

let eventStmts: EventStatements | null = eventsDb ? makeEventStatements(eventsDb) : null;
let metricsStmts: MetricsStatements | null = metricsDb ? makeMetricsStatements(metricsDb) : null;

// ── Query helpers ────────────────────────────────────────────────────────────

function querySessions(): AgentSession[] {
  return stmtAllSessions.all().map(mapSession);
}

function queryRecentMessages(): MailMessage[] {
  return stmtRecentMessages.all(MAX_RECENT_MESSAGES).map(mapMessage).reverse();
}

function queryNewMessages(since: string): MailMessage[] {
  return stmtNewMessages.all(since).map(mapMessage);
}

function queryMergeQueue(): MergeQueueEntry[] {
  return stmtMergeQueue.all().map(mapMergeEntry);
}

function queryRecentEvents(): OvrstoryEvent[] {
  if (!eventStmts) {
    // Retry opening the DB in case it became available after server start
    if (eventsDb === null) {
      eventsDb = openDb(`${OVERSTORY_DIR}/events.db`, "events.db", false);
      if (eventsDb) {
        eventStmts = makeEventStatements(eventsDb);
      }
    }
    if (!eventStmts) return [];
  }
  try {
    return eventStmts.recent.all(MAX_RECENT_EVENTS).map(mapEvent).reverse();
  } catch (err) {
    console.warn("[swarm-viz] Error querying events:", err);
    eventStmts = null;
    eventsDb = null;
    return [];
  }
}

function queryNewEvents(since: string): OvrstoryEvent[] {
  if (!eventStmts) return [];
  try {
    return eventStmts.since.all(since).map(mapEvent);
  } catch (err) {
    console.warn("[swarm-viz] Error querying new events:", err);
    eventStmts = null;
    eventsDb = null;
    return [];
  }
}

function queryMetricsSessions(): MetricsSession[] {
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
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

function buildSnapshot(): SwarmSnapshot {
  return {
    timestamp: new Date().toISOString(),
    sessions: querySessions(),
    recentMessages: queryRecentMessages(),
    mergeQueue: queryMergeQueue(),
    recentEvents: queryRecentEvents(),
    metricsSessions: queryMetricsSessions(),
  };
}

// ── Per-client delta tracking ─────────────────────────────────────────────────

interface ClientState {
  sessionMap: Map<string, AgentSession>;
  lastMessageTimestamp: string;
  mergeStatusMap: Map<number, string>;
  lastEventTimestamp: string;
  metricsKey: string; // serialized for change detection
}

function metricsKey(sessions: MetricsSession[]): string {
  return sessions
    .map((s) => `${s.agentName}:${s.beadId}:${s.durationMs}:${s.completedAt ?? ""}`)
    .join("|");
}

function initClientState(snapshot: SwarmSnapshot): ClientState {
  const sessionMap = new Map<string, AgentSession>();
  for (const s of snapshot.sessions) {
    sessionMap.set(s.id, s);
  }

  const lastMsg = snapshot.recentMessages[snapshot.recentMessages.length - 1];
  const lastMessageTimestamp = lastMsg?.createdAt ?? "";

  const mergeStatusMap = new Map<number, string>();
  for (const e of snapshot.mergeQueue) {
    mergeStatusMap.set(e.id, e.status);
  }

  const lastEvent = snapshot.recentEvents[snapshot.recentEvents.length - 1];
  const lastEventTimestamp = lastEvent?.createdAt ?? "";

  return {
    sessionMap,
    lastMessageTimestamp,
    mergeStatusMap,
    lastEventTimestamp,
    metricsKey: metricsKey(snapshot.metricsSessions),
  };
}

function computeDelta(state: ClientState): SwarmDelta | null {
  const currentSessions = querySessions();
  const newMessages = state.lastMessageTimestamp
    ? queryNewMessages(state.lastMessageTimestamp)
    : [];
  const currentMerge = queryMergeQueue();
  const newEvents = state.lastEventTimestamp
    ? queryNewEvents(state.lastEventTimestamp)
    : [];
  const currentMetrics = queryMetricsSessions();

  // Changed or new sessions
  const sessionsChanged: AgentSession[] = [];
  for (const session of currentSessions) {
    const prev = state.sessionMap.get(session.id);
    if (
      !prev ||
      prev.state !== session.state ||
      prev.lastActivity !== session.lastActivity ||
      prev.escalationLevel !== session.escalationLevel
    ) {
      sessionsChanged.push(session);
    }
  }

  // Changed merge queue entries
  const mergeQueueChanged: MergeQueueEntry[] = [];
  for (const entry of currentMerge) {
    const prevStatus = state.mergeStatusMap.get(entry.id);
    if (prevStatus === undefined || prevStatus !== entry.status) {
      mergeQueueChanged.push(entry);
    }
  }

  // Changed metrics (compare entire set via key)
  const newMetricsKey = metricsKey(currentMetrics);
  const metricsUpdated: MetricsSession[] =
    newMetricsKey !== state.metricsKey ? currentMetrics : [];

  if (
    sessionsChanged.length === 0 &&
    newMessages.length === 0 &&
    mergeQueueChanged.length === 0 &&
    newEvents.length === 0 &&
    metricsUpdated.length === 0
  ) {
    return null;
  }

  // Advance tracking state
  state.sessionMap.clear();
  for (const s of currentSessions) {
    state.sessionMap.set(s.id, s);
  }
  const lastNew = newMessages[newMessages.length - 1];
  if (lastNew) {
    state.lastMessageTimestamp = lastNew.createdAt;
  }
  state.mergeStatusMap.clear();
  for (const e of currentMerge) {
    state.mergeStatusMap.set(e.id, e.status);
  }
  const lastNewEvent = newEvents[newEvents.length - 1];
  if (lastNewEvent) {
    state.lastEventTimestamp = lastNewEvent.createdAt;
  }
  if (metricsUpdated.length > 0) {
    state.metricsKey = newMetricsKey;
  }

  return {
    timestamp: new Date().toISOString(),
    sessionsChanged,
    newMessages,
    mergeQueueChanged,
    newEvents,
    metricsUpdated,
  };
}

// ── Static file serving ──────────────────────────────────────────────────────

async function serveStatic(pathname: string): Promise<Response> {
  // Normalize: strip leading slash, default to index.html
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");

  // Prevent directory traversal
  if (rel.includes("..")) {
    return new Response("Forbidden", { status: 403 });
  }

  const filePath = join(STATIC_DIR, rel);
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    // SPA fallback: serve index.html for unknown paths
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

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", databases: { events: eventsDb !== null, metrics: metricsDb !== null } }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Serve static files for everything else
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

console.log(`[swarm-viz] Server listening on http://localhost:${PORT}`);
console.log(`[swarm-viz] WebSocket endpoint: ws://localhost:${PORT}/ws`);
console.log(`[swarm-viz] Static files from: ${STATIC_DIR}`);

// ── Poll loop ────────────────────────────────────────────────────────────────

setInterval(() => {
  if (clientStates.size === 0) return;

  for (const [ws, state] of clientStates) {
    try {
      const delta = computeDelta(state);
      if (!delta) continue;
      const msg: ServerMessage = { type: "delta", data: delta };
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("Error computing or sending delta:", err);
    }
  }
}, POLL_INTERVAL_MS);
