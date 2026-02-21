import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { join } from "node:path";
import type {
  Agent,
  AgentSession,
  DashboardMode,
  DashboardState,
  DbMergeQueueEntry,
  DiscoveredProject,
  MailMessage,
  MetricsSession,
  ServerMessage,
  StateSnapshot,
  StateUpdate,
  SwarmMetrics,
  ToolEventData,
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
import { DiscoveryManager } from "./discovery.ts";

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * OVERSTORY_DIR: explicit override. When set, disables auto-discovery and
 * connects directly to that directory (legacy / CI usage).
 */
const OVERSTORY_DIR_OVERRIDE = process.env["OVERSTORY_DIR"];
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const POLL_INTERVAL_MS = parseInt(process.env["POLL_INTERVAL_MS"] ?? "500", 10);
const STATIC_DIR = process.env["STATIC_DIR"] ?? join(import.meta.dir, "..");
const MAX_RECENT_MESSAGES = 50;

/**
 * DEMO_MODE=true forces demo mode regardless of discovered projects.
 * Used for testing / screenshots.
 */
const FORCE_DEMO = process.env["DEMO_MODE"] === "true";

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

// ── Live database connection bundle ──────────────────────────────────────────

/** Minimal tool event row returned from events.db */
interface ToolEventRow {
  id: number;
  agent_name: string;
  tool_name: string | null;
  event_type: string;
  created_at: string;
}

interface LiveDatabases {
  overstoryDir: string;
  projectName: string;
  querySessions: () => AgentSession[];
  queryRecentMessages: () => MailMessage[];
  queryNewMessages: (since: string) => MailMessage[];
  queryMessageCount: () => number;
  queryMergeQueue: () => DbMergeQueueEntry[];
  queryMetricsSessions: () => MetricsSession[];
  queryNewEvents: (sinceId: number) => ToolEventData[];
  close: () => void;
}

function openLiveDatabases(overstoryDir: string, projectName: string): LiveDatabases | null {
  const sessionsDbPath = `${overstoryDir}/sessions.db`;
  const sessionsDb = (() => {
    try {
      if (!Bun.file(sessionsDbPath).size) return null;
      const rw = new Database(sessionsDbPath);
      rw.close();
      return new Database(sessionsDbPath, { readonly: true });
    } catch {
      return null;
    }
  })();

  if (!sessionsDb) {
    console.warn(`[swarm-viz] Cannot open sessions.db for project '${projectName}'`);
    return null;
  }

  const mailDb = openDb(`${overstoryDir}/mail.db`, "mail.db", false);
  const mergeQueueDb = openDb(`${overstoryDir}/merge-queue.db`, "merge-queue.db", false);
  let metricsDb = openDb(`${overstoryDir}/metrics.db`, "metrics.db", false);
  // Events DB needs read-write mode to see WAL writes from other processes
  const eventsDb = (() => {
    const p = `${overstoryDir}/events.db`;
    try {
      if (!Bun.file(p).size) return null;
      return new Database(p);  // read-write so WAL updates are visible
    } catch {
      return null;
    }
  })();

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

  // Determine the current max event ID so we only stream new events going forward
  let initialMaxEventId = 0;
  const stmtNewEvents = eventsDb?.query<ToolEventRow, [number]>(
    `SELECT id, agent_name, tool_name, event_type, created_at
     FROM events
     WHERE id > ? AND event_type IN ('tool_start', 'mail_sent')
     ORDER BY id ASC
     LIMIT 50`
  ) ?? null;
  if (eventsDb && stmtNewEvents) {
    try {
      const maxRow = eventsDb.query<{ max_id: number | null }, []>(
        "SELECT MAX(id) as max_id FROM events"
      ).get();
      initialMaxEventId = maxRow?.max_id ?? 0;
    } catch { /* events table may not exist yet */ }
  }

  let metricsStmts: MetricsStatements | null = null;
  try {
    metricsStmts = metricsDb ? makeMetricsStatements(metricsDb) : null;
  } catch { /* tables may not exist yet */ }

  return {
    overstoryDir,
    projectName,
    querySessions: () => stmtAllSessions.all().map(mapSession),
    queryRecentMessages: () =>
      stmtRecentMessages?.all(MAX_RECENT_MESSAGES).map(mapMessage).reverse() ?? [],
    queryNewMessages: (since) => stmtNewMessages?.all(since).map(mapMessage) ?? [],
    queryMessageCount: () => {
      const row = stmtMessageCount?.get();
      return row?.count ?? 0;
    },
    queryMergeQueue: () => stmtMergeQueue?.all().map(mapMergeEntry) ?? [],
    queryMetricsSessions: () => {
      if (!metricsStmts) {
        if (metricsDb === null) {
          metricsDb = openDb(`${overstoryDir}/metrics.db`, "metrics.db", false);
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
    },
    queryNewEvents: (() => {
      let lastId = initialMaxEventId;
      return (_sinceId: number): ToolEventData[] => {
        if (!stmtNewEvents) return [];
        try {
          const rows = stmtNewEvents.all(lastId);
          if (rows.length > 0) {
            lastId = rows[rows.length - 1]!.id;
          }
          return rows.map((r) => ({
            agentName: r.agent_name,
            toolName: r.tool_name,
            eventType: r.event_type,
            createdAt: r.created_at,
          }));
        } catch {
          return [];
        }
      };
    })(),
    close: () => {
      try { sessionsDb.close(); } catch { /* ignore */ }
      try { mailDb?.close(); } catch { /* ignore */ }
      try { mergeQueueDb?.close(); } catch { /* ignore */ }
      try { metricsDb?.close(); } catch { /* ignore */ }
      try { eventsDb?.close(); } catch { /* ignore */ }
    },
  };
}

// ── Mode manager ─────────────────────────────────────────────────────────────
//
// Manages the current data source (live project or demo simulator).
// When auto-discovery is active, this switches automatically based on
// which projects have active agents.

class ModeManager {
  private _mode: DashboardMode = "demo";
  private _activeProject: string | null = null;
  private _live: LiveDatabases | null = null;
  private _simulator: DemoSimulator | null = null;
  private _projects: DiscoveredProject[] = [];
  private _forceDemoMode: boolean;
  private _overrideDir: string | null;

  // Query function pointers — updated when mode switches
  querySessions!: () => AgentSession[];
  queryRecentMessages!: () => MailMessage[];
  queryNewMessages!: (since: string) => MailMessage[];
  queryMessageCount!: () => number;
  queryMergeQueue!: () => DbMergeQueueEntry[];
  queryMetricsSessions!: () => MetricsSession[];
  queryNewEvents!: (sinceId: number) => ToolEventData[];

  constructor(forceDemoMode: boolean, overrideDir: string | null) {
    this._forceDemoMode = forceDemoMode;
    this._overrideDir = overrideDir;

    if (overrideDir) {
      // Legacy mode: explicit OVERSTORY_DIR provided
      if (!forceDemoMode) {
        const live = openLiveDatabases(overrideDir, "override");
        if (live) {
          this._live = live;
          this._setLiveMode(live, "override");
          return;
        }
      }
    }

    // Start in demo mode; auto-discovery will switch when live projects appear
    this._startDemo();
  }

  get mode(): DashboardMode { return this._mode; }
  get activeProject(): string | null { return this._activeProject; }
  get projects(): DiscoveredProject[] { return this._projects; }

  /**
   * Called by DiscoveryManager whenever the project list changes.
   * Picks the best active project or falls back to demo.
   */
  onProjectsChanged(projects: DiscoveredProject[]): void {
    this._projects = projects;

    if (this._forceDemoMode || this._overrideDir) {
      // Don't auto-switch when explicitly overridden
      return;
    }

    // Find the project with the most active agents (prefer already-active project)
    let best: DiscoveredProject | null = null;
    for (const p of projects) {
      if (p.activeAgents > 0) {
        if (!best || p.activeAgents > best.activeAgents) {
          best = p;
        }
      }
    }

    if (best) {
      if (this._mode !== "live" || this._activeProject !== best.name) {
        this._switchToLive(best);
      }
    } else {
      // No active agents anywhere — switch to demo
      if (this._mode !== "demo") {
        console.log("[swarm-viz] No active agents found — switching to demo mode");
        this._switchToDemo();
      }
    }
  }

  /**
   * Poll the currently active live project to get the latest agent count.
   * Returns the count so the discovery manager can be updated.
   */
  pollActiveAgentCount(): number {
    if (this._mode !== "live") return 0;
    try {
      const sessions = this.querySessions();
      return sessions.filter(
        (s) => s.state === "working" || s.state === "booting"
      ).length;
    } catch {
      return 0;
    }
  }

  /**
   * Tick the demo simulator (no-op in live mode).
   */
  tick(): void {
    if (this._simulator) this._simulator.tick();
  }

  /**
   * Builds the DashboardState message for a client.
   */
  buildDashboardState(): DashboardState {
    const annotated = this._projects.map((p) => ({
      ...p,
      active: p.name === this._activeProject,
    }));
    return {
      mode: this._mode,
      activeProject: this._activeProject,
      projects: annotated,
    };
  }

  private _switchToLive(project: DiscoveredProject): void {
    // Close existing live connection
    if (this._live) {
      this._live.close();
      this._live = null;
    }

    const live = openLiveDatabases(project.overstoryDir, project.name);
    if (!live) {
      console.warn(`[swarm-viz] Failed to connect to project '${project.name}' — staying in demo`);
      return;
    }

    this._live = live;
    // Stop demo simulator to save resources
    this._simulator = null;
    this._setLiveMode(live, project.name);
    console.log(`[swarm-viz] Switched to live mode — project: ${project.name}`);
  }

  private _switchToDemo(): void {
    if (this._live) {
      this._live.close();
      this._live = null;
    }
    this._startDemo();
    console.log("[swarm-viz] Switched to demo mode");
  }

  private _startDemo(): void {
    this._simulator = new DemoSimulator();
    const sim = this._simulator;
    this._mode = "demo";
    this._activeProject = null;
    this.querySessions = () => sim.querySessions();
    this.queryRecentMessages = () => sim.queryRecentMessages();
    this.queryNewMessages = (since) => sim.queryNewMessages(since);
    this.queryMessageCount = () => sim.queryMessageCount();
    this.queryMergeQueue = () => sim.queryMergeQueue();
    this.queryMetricsSessions = () => sim.queryMetricsSessions();
    this.queryNewEvents = () => [];
  }

  private _setLiveMode(live: LiveDatabases, projectName: string): void {
    this._mode = "live";
    this._activeProject = projectName;
    this.querySessions = live.querySessions;
    this.queryRecentMessages = live.queryRecentMessages;
    this.queryNewMessages = live.queryNewMessages;
    this.queryMessageCount = live.queryMessageCount;
    this.queryMergeQueue = live.queryMergeQueue;
    this.queryMetricsSessions = live.queryMetricsSessions;
    this.queryNewEvents = live.queryNewEvents;
  }
}

// ── Instantiate mode manager ──────────────────────────────────────────────────

const modeManager = new ModeManager(FORCE_DEMO, OVERSTORY_DIR_OVERRIDE ?? null);

// ── Auto-discovery (skipped when OVERSTORY_DIR is set or DEMO_MODE=true) ─────

const discovery = new DiscoveryManager();

discovery.onChange((projects) => {
  modeManager.onProjectsChanged(projects);
  // Broadcast updated dashboard state to all connected clients
  broadcastDashboardState();
});

if (!OVERSTORY_DIR_OVERRIDE && !FORCE_DEMO) {
  discovery.start();
  // Seed initial project list immediately
  modeManager.onProjectsChanged(discovery.getProjects());
}

// ── Viz-layer snapshot builder ───────────────────────────────────────────────

function buildSnapshot(): StateSnapshot {
  const sessions = modeManager.querySessions();
  const messages = modeManager.queryRecentMessages();
  const mergeQueue = modeManager.queryMergeQueue();
  const metricsSessions = modeManager.queryMetricsSessions();
  const totalMessages = modeManager.queryMessageCount();
  const metrics = computeMetrics(sessions, totalMessages, metricsSessions, smoothedCostPerMinute);
  recordCostSample(metrics.totalCost);

  return {
    agents: sessions.map(toAgent),
    messages: messages.map(toAgentMessage),
    mergeQueue: mergeQueue.map(toVizMergeEntry),
    metrics,
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
  /** last known dashboard mode/project for change detection */
  lastDashboardKey: string;
  /** last seen event ID for tool_event streaming (0 = start from current max) */
  lastEventId: number;
}

// ── Cost-per-minute tracking ──────────────────────────────────────────────────
// Smooth cost rate over a 30-second window using a rolling sample buffer.

interface CostSample {
  cost: number;
  ts: number; // Date.now() in ms
}

const COST_WINDOW_MS = 30_000;
const costSamples: CostSample[] = [];
let smoothedCostPerMinute = 0;

function recordCostSample(totalCost: number): void {
  const now = Date.now();
  costSamples.push({ cost: totalCost, ts: now });
  // Drop samples older than the window
  while (costSamples.length > 1 && now - costSamples[0]!.ts > COST_WINDOW_MS) {
    costSamples.shift();
  }
  // Need at least 2 samples to compute a rate
  if (costSamples.length >= 2) {
    const oldest = costSamples[0]!;
    const newest = costSamples[costSamples.length - 1]!;
    const deltaMs = newest.ts - oldest.ts;
    const deltaCost = newest.cost - oldest.cost;
    if (deltaMs > 0 && deltaCost >= 0) {
      smoothedCostPerMinute = (deltaCost / deltaMs) * 60_000;
    }
  }
}

function metricsKey(m: SwarmMetrics): string {
  return `${m.totalAgents}:${m.activeAgents}:${m.totalMessages}:${m.totalCost.toFixed(6)}:${m.costPerMinute.toFixed(4)}`;
}

function agentKey(a: Agent): string {
  return `${a.state}:${a.lastActivity}:${a.parentAgent ?? ""}`;
}

function dashboardKey(ds: DashboardState): string {
  return `${ds.mode}:${ds.activeProject ?? ""}:${ds.projects.map((p) => p.name + "=" + p.activeAgents).join(",")}`;
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

  const ds = modeManager.buildDashboardState();

  return {
    agentStateMap,
    lastMessageTimestamp,
    mergeStatusMap,
    metricsKey: metricsKey(snapshot.metrics),
    lastTotalMessages: snapshot.metrics.totalMessages,
    lastDashboardKey: dashboardKey(ds),
    lastEventId: 0,
  };
}

/**
 * Compute incremental updates since the last poll.
 * Returns an array of StateUpdate events to send (empty = no changes).
 */
function computeUpdates(state: ClientState): StateUpdate[] {
  const updates: StateUpdate[] = [];

  const sessions = modeManager.querySessions();
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
    const newMail = modeManager.queryNewMessages(state.lastMessageTimestamp).map(toAgentMessage);
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
  const currentMerge = modeManager.queryMergeQueue().map(toVizMergeEntry);
  for (const entry of currentMerge) {
    const prev = state.mergeStatusMap.get(entry.branchName);
    if (prev === undefined || prev !== entry.status) {
      updates.push({ type: "merge_update", data: entry });
    }
  }

  // Tool events since last poll
  const newEvents = modeManager.queryNewEvents(state.lastEventId);
  if (newEvents.length > 0) {
    console.log(`[swarm-viz] Streaming ${newEvents.length} tool events to client`);
  }
  for (const evt of newEvents) {
    updates.push({ type: "tool_event", data: evt });
  }

  // Metrics update (check if anything changed)
  const totalMessages = modeManager.queryMessageCount();
  const metricsSessions = modeManager.queryMetricsSessions();
  const currentMetrics = computeMetrics(sessions, totalMessages, metricsSessions, smoothedCostPerMinute);
  recordCostSample(currentMetrics.totalCost);
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

// ── Broadcast helpers ─────────────────────────────────────────────────────────

const clientStates = new Map<ServerWebSocket, ClientState>();

function broadcastDashboardState(): void {
  const ds = modeManager.buildDashboardState();
  const key = dashboardKey(ds);
  const msg: ServerMessage = { type: "dashboard_state", data: ds };
  const json = JSON.stringify(msg);

  for (const [ws, state] of clientStates) {
    if (state.lastDashboardKey !== key) {
      try {
        ws.send(json);
        state.lastDashboardKey = key;
      } catch { /* client may have disconnected */ }
    }
  }
}

// ── WebSocket server ─────────────────────────────────────────────────────────

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
        JSON.stringify({
          status: "ok",
          mode: modeManager.mode,
          activeProject: modeManager.activeProject,
          projects: modeManager.projects.length,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/api/projects") {
      return new Response(
        JSON.stringify(modeManager.buildDashboardState()),
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

        // Send snapshot first
        const snapMsg: ServerMessage = { type: "snapshot", data: snapshot };
        ws.send(JSON.stringify(snapMsg));

        // Then send dashboard state
        const dsMsg: ServerMessage = {
          type: "dashboard_state",
          data: modeManager.buildDashboardState(),
        };
        ws.send(JSON.stringify(dsMsg));
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

if (FORCE_DEMO) {
  console.log("[swarm-viz] Demo mode active (forced via DEMO_MODE=true)");
} else if (OVERSTORY_DIR_OVERRIDE) {
  console.log(`[swarm-viz] Live mode — fixed OVERSTORY_DIR: ${OVERSTORY_DIR_OVERRIDE}`);
} else {
  console.log("[swarm-viz] Auto-discovery mode active — scanning for Overstory projects");
}
console.log(`[swarm-viz] Server listening on http://localhost:${PORT}`);
console.log(`[swarm-viz] WebSocket endpoint: ws://localhost:${PORT}/ws`);
console.log(`[swarm-viz] Static files from: ${STATIC_DIR}`);

// ── Poll loop ────────────────────────────────────────────────────────────────

setInterval(() => {
  modeManager.tick();
  if (clientStates.size === 0) return;

  // Update active agent counts for all discovered projects.
  // This must run in ALL modes (including demo) so we detect when a project
  // starts running agents and can switch from demo to live.
  if (modeManager.mode === "live" && modeManager.activeProject) {
    // Currently connected project — use the open DB handles
    const count = modeManager.pollActiveAgentCount();
    discovery.updateActiveAgents(modeManager.activeProject, count);
  }
  // Also probe all other discovered projects (cheap: one query per project)
  for (const project of discovery.getProjects()) {
    if (modeManager.mode === "live" && project.name === modeManager.activeProject) {
      continue; // Already polled above via open handles
    }
    try {
      const sessionsPath = join(project.overstoryDir, "sessions.db");
      if (!Bun.file(sessionsPath).size) continue;
      const db = new Database(sessionsPath, { readonly: true });
      const row = db.query<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM sessions WHERE state IN ('working', 'booting')"
      ).get();
      db.close();
      const count = row?.count ?? 0;
      if (count !== project.activeAgents) {
        discovery.updateActiveAgents(project.name, count);
      }
    } catch { /* DB not ready or locked — skip this cycle */ }
  }

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
