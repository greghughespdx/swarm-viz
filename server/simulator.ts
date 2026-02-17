/**
 * Demo simulator that produces fake swarm data on a repeating ~2-minute cycle.
 * Activated when DEMO_MODE=true env var is set.
 *
 * Produces the server-internal types (AgentSession, MailMessage, DbMergeQueueEntry)
 * so the existing mapper pipeline works unchanged.
 */

import type {
  AgentSession,
  AgentState,
  DbMergeQueueEntry,
  MailMessage,
  MergeStatus,
  MessageType,
  MetricsSession,
} from "../shared/types.ts";

// ── Timeline event types ──────────────────────────────────────────────────────

type TimelineEvent =
  | {
      offsetMs: number;
      action: "spawn_agent";
      name: string;
      capability: string;
      state: AgentState;
      parent: string | null;
      depth: number;
      beadId: string;
    }
  | { offsetMs: number; action: "change_state"; name: string; state: AgentState }
  | {
      offsetMs: number;
      action: "add_message";
      from: string;
      to: string;
      type: MessageType;
      subject: string;
    }
  | {
      offsetMs: number;
      action: "enqueue_merge";
      agentName: string;
      branchName: string;
      beadId: string;
    }
  | { offsetMs: number; action: "update_merge"; branchName: string; status: MergeStatus }
  | { offsetMs: number; action: "remove_merge"; branchName: string };

// ── Simulator ────────────────────────────────────────────────────────────────

const BEAD_PREFIXES = [
  "auth-refactor",
  "api-gateway",
  "db-migration",
  "ui-overhaul",
  "perf-tuning",
  "test-infra",
  "cache-layer",
  "deploy-pipeline",
];

const CYCLE_DURATION_MS = 115_000;

export class DemoSimulator {
  private agents = new Map<string, AgentSession>();
  private messages: MailMessage[] = [];
  private mergeQueue = new Map<string, DbMergeQueueEntry>();
  private completedAgents: MetricsSession[] = [];

  private cycleStartTime = Date.now();
  private cycleCount = 0;
  private nextEventIndex = 0;
  private timeline: TimelineEvent[] = [];

  private sessionIdCounter = 0;
  private msgIdCounter = 0;
  private mergeIdCounter = 0;

  constructor() {
    this.buildTimeline();
  }

  // ── Timeline construction ────────────────────────────────────────────────

  private getBead(offset: number): string {
    return BEAD_PREFIXES[(this.cycleCount + offset) % BEAD_PREFIXES.length]!;
  }

  private buildTimeline(): void {
    const srvBead = this.getBead(0);
    const cliBead = this.getBead(1);

    this.timeline = [
      // Phase 1 (0–8s): Coordinator boots, dispatches to leads
      {
        offsetMs: 0,
        action: "spawn_agent",
        name: "coordinator",
        capability: "coordinator",
        state: "booting",
        parent: null,
        depth: 0,
        beadId: srvBead,
      },
      { offsetMs: 2_000, action: "change_state", name: "coordinator", state: "working" },
      {
        offsetMs: 3_000,
        action: "add_message",
        from: "coordinator",
        to: "server-lead",
        type: "dispatch",
        subject: `Dispatch: ${srvBead}`,
      },
      {
        offsetMs: 4_000,
        action: "add_message",
        from: "coordinator",
        to: "client-lead",
        type: "dispatch",
        subject: `Dispatch: ${cliBead}`,
      },
      {
        offsetMs: 5_000,
        action: "spawn_agent",
        name: "server-lead",
        capability: "lead",
        state: "booting",
        parent: "coordinator",
        depth: 1,
        beadId: srvBead,
      },
      {
        offsetMs: 7_000,
        action: "spawn_agent",
        name: "client-lead",
        capability: "lead",
        state: "booting",
        parent: "coordinator",
        depth: 1,
        beadId: cliBead,
      },
      { offsetMs: 8_000, action: "change_state", name: "server-lead", state: "working" },
      { offsetMs: 8_500, action: "change_state", name: "client-lead", state: "working" },

      // Phase 2 (10–25s): Leads spawn scouts, scouts explore and complete
      {
        offsetMs: 10_000,
        action: "spawn_agent",
        name: "scout-srv",
        capability: "scout",
        state: "booting",
        parent: "server-lead",
        depth: 2,
        beadId: srvBead,
      },
      {
        offsetMs: 11_000,
        action: "add_message",
        from: "server-lead",
        to: "scout-srv",
        type: "dispatch",
        subject: "Scout: explore server codebase",
      },
      {
        offsetMs: 12_000,
        action: "spawn_agent",
        name: "scout-cli",
        capability: "scout",
        state: "booting",
        parent: "client-lead",
        depth: 2,
        beadId: cliBead,
      },
      {
        offsetMs: 13_000,
        action: "add_message",
        from: "client-lead",
        to: "scout-cli",
        type: "dispatch",
        subject: "Scout: explore client codebase",
      },
      { offsetMs: 14_000, action: "change_state", name: "scout-srv", state: "working" },
      { offsetMs: 15_000, action: "change_state", name: "scout-cli", state: "working" },
      {
        offsetMs: 18_000,
        action: "add_message",
        from: "scout-srv",
        to: "server-lead",
        type: "result",
        subject: "Scout report: server patterns found",
      },
      {
        offsetMs: 20_000,
        action: "add_message",
        from: "scout-cli",
        to: "client-lead",
        type: "result",
        subject: "Scout report: client patterns found",
      },
      { offsetMs: 22_000, action: "change_state", name: "scout-srv", state: "completed" },
      { offsetMs: 24_000, action: "change_state", name: "scout-cli", state: "completed" },

      // Phase 3 (28–35s): Leads spawn 4 builders, builders start working
      {
        offsetMs: 28_000,
        action: "spawn_agent",
        name: "srv-builder-1",
        capability: "builder",
        state: "booting",
        parent: "server-lead",
        depth: 2,
        beadId: srvBead,
      },
      {
        offsetMs: 29_000,
        action: "spawn_agent",
        name: "srv-builder-2",
        capability: "builder",
        state: "booting",
        parent: "server-lead",
        depth: 2,
        beadId: srvBead,
      },
      {
        offsetMs: 30_000,
        action: "spawn_agent",
        name: "cli-builder-1",
        capability: "builder",
        state: "booting",
        parent: "client-lead",
        depth: 2,
        beadId: cliBead,
      },
      {
        offsetMs: 31_000,
        action: "spawn_agent",
        name: "cli-builder-2",
        capability: "builder",
        state: "booting",
        parent: "client-lead",
        depth: 2,
        beadId: cliBead,
      },
      {
        offsetMs: 32_000,
        action: "add_message",
        from: "server-lead",
        to: "srv-builder-1",
        type: "dispatch",
        subject: "Build: server module A",
      },
      {
        offsetMs: 32_500,
        action: "add_message",
        from: "server-lead",
        to: "srv-builder-2",
        type: "dispatch",
        subject: "Build: server module B",
      },
      {
        offsetMs: 33_000,
        action: "add_message",
        from: "client-lead",
        to: "cli-builder-1",
        type: "dispatch",
        subject: "Build: client module A",
      },
      {
        offsetMs: 33_500,
        action: "add_message",
        from: "client-lead",
        to: "cli-builder-2",
        type: "dispatch",
        subject: "Build: client module B",
      },
      { offsetMs: 34_000, action: "change_state", name: "srv-builder-1", state: "working" },
      { offsetMs: 34_500, action: "change_state", name: "srv-builder-2", state: "working" },
      { offsetMs: 35_000, action: "change_state", name: "cli-builder-1", state: "working" },
      { offsetMs: 35_500, action: "change_state", name: "cli-builder-2", state: "working" },

      // Phase 4 (40–68s): Periodic status/question messages
      {
        offsetMs: 40_000,
        action: "add_message",
        from: "srv-builder-1",
        to: "server-lead",
        type: "status",
        subject: "Progress: 30% complete",
      },
      {
        offsetMs: 45_000,
        action: "add_message",
        from: "cli-builder-1",
        to: "client-lead",
        type: "question",
        subject: "Question: type definition ambiguity in shared module",
      },
      {
        offsetMs: 48_000,
        action: "add_message",
        from: "client-lead",
        to: "cli-builder-1",
        type: "result",
        subject: "Answer: use the shared interface from types.ts",
      },
      {
        offsetMs: 52_000,
        action: "add_message",
        from: "srv-builder-2",
        to: "server-lead",
        type: "status",
        subject: "Progress: core logic implemented, writing tests",
      },
      {
        offsetMs: 55_000,
        action: "add_message",
        from: "cli-builder-2",
        to: "client-lead",
        type: "status",
        subject: "Progress: 60% complete",
      },
      {
        offsetMs: 60_000,
        action: "add_message",
        from: "srv-builder-1",
        to: "server-lead",
        type: "status",
        subject: "Progress: tests passing, lint clean",
      },
      {
        offsetMs: 63_000,
        action: "add_message",
        from: "cli-builder-1",
        to: "client-lead",
        type: "status",
        subject: "Progress: integration complete",
      },
      {
        offsetMs: 66_000,
        action: "add_message",
        from: "srv-builder-2",
        to: "server-lead",
        type: "status",
        subject: "Progress: ready to finalize",
      },

      // Phase 5 (72–86s): Builders complete, merge queue entries appear
      {
        offsetMs: 72_000,
        action: "add_message",
        from: "srv-builder-1",
        to: "server-lead",
        type: "worker_done",
        subject: `Worker done: ${srvBead}-mod-a`,
      },
      { offsetMs: 72_500, action: "change_state", name: "srv-builder-1", state: "completed" },
      {
        offsetMs: 73_000,
        action: "enqueue_merge",
        agentName: "srv-builder-1",
        branchName: `overstory/srv-builder-1/${srvBead}`,
        beadId: srvBead,
      },

      {
        offsetMs: 75_000,
        action: "add_message",
        from: "srv-builder-2",
        to: "server-lead",
        type: "worker_done",
        subject: `Worker done: ${srvBead}-mod-b`,
      },
      { offsetMs: 75_500, action: "change_state", name: "srv-builder-2", state: "completed" },
      {
        offsetMs: 76_000,
        action: "enqueue_merge",
        agentName: "srv-builder-2",
        branchName: `overstory/srv-builder-2/${srvBead}`,
        beadId: srvBead,
      },

      {
        offsetMs: 78_000,
        action: "add_message",
        from: "cli-builder-1",
        to: "client-lead",
        type: "worker_done",
        subject: `Worker done: ${cliBead}-mod-a`,
      },
      { offsetMs: 78_500, action: "change_state", name: "cli-builder-1", state: "completed" },
      {
        offsetMs: 79_000,
        action: "enqueue_merge",
        agentName: "cli-builder-1",
        branchName: `overstory/cli-builder-1/${cliBead}`,
        beadId: cliBead,
      },

      {
        offsetMs: 82_000,
        action: "add_message",
        from: "cli-builder-2",
        to: "client-lead",
        type: "worker_done",
        subject: `Worker done: ${cliBead}-mod-b`,
      },
      { offsetMs: 82_500, action: "change_state", name: "cli-builder-2", state: "completed" },
      {
        offsetMs: 83_000,
        action: "enqueue_merge",
        agentName: "cli-builder-2",
        branchName: `overstory/cli-builder-2/${cliBead}`,
        beadId: cliBead,
      },

      // Phase 6 (88–97s): Merge queue pending → merging → removed
      {
        offsetMs: 88_000,
        action: "update_merge",
        branchName: `overstory/srv-builder-1/${srvBead}`,
        status: "merging",
      },
      { offsetMs: 90_000, action: "remove_merge", branchName: `overstory/srv-builder-1/${srvBead}` },
      {
        offsetMs: 91_000,
        action: "update_merge",
        branchName: `overstory/srv-builder-2/${srvBead}`,
        status: "merging",
      },
      { offsetMs: 92_500, action: "remove_merge", branchName: `overstory/srv-builder-2/${srvBead}` },
      {
        offsetMs: 93_000,
        action: "update_merge",
        branchName: `overstory/cli-builder-1/${cliBead}`,
        status: "merging",
      },
      { offsetMs: 94_500, action: "remove_merge", branchName: `overstory/cli-builder-1/${cliBead}` },
      {
        offsetMs: 95_000,
        action: "update_merge",
        branchName: `overstory/cli-builder-2/${cliBead}`,
        status: "merging",
      },
      { offsetMs: 96_500, action: "remove_merge", branchName: `overstory/cli-builder-2/${cliBead}` },

      // Phase 7 (98–106s): Leads send merge_ready, all agents complete
      {
        offsetMs: 98_000,
        action: "add_message",
        from: "server-lead",
        to: "coordinator",
        type: "merge_ready",
        subject: `Merge ready: ${srvBead}`,
      },
      {
        offsetMs: 100_000,
        action: "add_message",
        from: "client-lead",
        to: "coordinator",
        type: "merge_ready",
        subject: `Merge ready: ${cliBead}`,
      },
      { offsetMs: 102_000, action: "change_state", name: "server-lead", state: "completed" },
      { offsetMs: 104_000, action: "change_state", name: "client-lead", state: "completed" },
      { offsetMs: 106_000, action: "change_state", name: "coordinator", state: "completed" },

      // Phase 8 (106–115s): Brief pause, then cycle resets automatically via tick()
    ];
  }

  // ── Tick ────────────────────────────────────────────────────────────────────

  tick(): void {
    const elapsed = Date.now() - this.cycleStartTime;

    if (elapsed >= CYCLE_DURATION_MS) {
      this.resetCycle();
      return;
    }

    while (this.nextEventIndex < this.timeline.length) {
      const event = this.timeline[this.nextEventIndex];
      if (!event) break;
      if (elapsed >= event.offsetMs) {
        this.fireEvent(event);
        this.nextEventIndex++;
      } else {
        break;
      }
    }
  }

  // ── Cycle reset ──────────────────────────────────────────────────────────

  private resetCycle(): void {
    for (const session of this.agents.values()) {
      this.completedAgents.push(this.toMetrics(session));
    }
    // Keep last 100 messages across cycles
    this.messages = this.messages.slice(-100);
    this.agents.clear();
    this.mergeQueue.clear();
    this.cycleCount++;
    this.nextEventIndex = 0;
    this.cycleStartTime = Date.now();
    this.buildTimeline();
  }

  private toMetrics(s: AgentSession): MetricsSession {
    const durationMs = Math.max(1000, Date.now() - new Date(s.startedAt).getTime());
    return {
      agentName: s.agentName,
      beadId: s.beadId,
      capability: s.capability,
      startedAt: s.startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      exitCode: 0,
      mergeResult: "merged",
      parentAgent: s.parentAgent,
      inputTokens: Math.floor(Math.random() * 50_000) + 10_000,
      outputTokens: Math.floor(Math.random() * 20_000) + 5_000,
      cacheReadTokens: Math.floor(Math.random() * 30_000),
      cacheCreationTokens: Math.floor(Math.random() * 10_000),
      estimatedCostUsd: Math.random() * 0.4 + 0.05,
      modelUsed: "claude-sonnet-4-5-20250929",
    };
  }

  // ── Event dispatch ──────────────────────────────────────────────────────

  private fireEvent(event: TimelineEvent): void {
    const now = new Date().toISOString();

    switch (event.action) {
      case "spawn_agent": {
        const session: AgentSession = {
          id: `sim-session-${++this.sessionIdCounter}`,
          agentName: event.name,
          capability: event.capability,
          worktreePath: `/sim/worktrees/${event.name}`,
          branchName: `overstory/${event.name}/${event.beadId}`,
          beadId: event.beadId,
          tmuxSession: `sim:${event.name}`,
          state: event.state,
          pid: 10_000 + this.sessionIdCounter,
          parentAgent: event.parent,
          depth: event.depth,
          runId: null,
          startedAt: now,
          lastActivity: now,
          escalationLevel: 0,
          stalledSince: null,
        };
        this.agents.set(event.name, session);
        break;
      }

      case "change_state": {
        const session = this.agents.get(event.name);
        if (session) {
          session.state = event.state;
          session.lastActivity = now;
        }
        break;
      }

      case "add_message": {
        const msg: MailMessage = {
          id: `sim-msg-${++this.msgIdCounter}`,
          fromAgent: event.from,
          toAgent: event.to,
          subject: event.subject,
          body: `Simulated ${event.type} message from ${event.from} to ${event.to}.`,
          type: event.type,
          priority: "normal",
          threadId: null,
          read: false,
          createdAt: now,
        };
        this.messages.push(msg);

        const sender = this.agents.get(event.from);
        if (sender) sender.lastActivity = now;
        break;
      }

      case "enqueue_merge": {
        const entry: DbMergeQueueEntry = {
          id: ++this.mergeIdCounter,
          branchName: event.branchName,
          beadId: event.beadId,
          agentName: event.agentName,
          filesModified: [
            `server/${event.agentName}.ts`,
            `tests/${event.agentName}.test.ts`,
          ],
          enqueuedAt: now,
          status: "pending",
          resolvedTier: null,
        };
        this.mergeQueue.set(event.branchName, entry);
        break;
      }

      case "update_merge": {
        const entry = this.mergeQueue.get(event.branchName);
        if (entry) {
          entry.status = event.status;
        }
        break;
      }

      case "remove_merge": {
        this.mergeQueue.delete(event.branchName);
        break;
      }
    }
  }

  // ── Query methods (matching server query layer signatures) ───────────────

  querySessions(): AgentSession[] {
    return Array.from(this.agents.values());
  }

  queryRecentMessages(): MailMessage[] {
    return this.messages.slice(-50);
  }

  queryNewMessages(since: string): MailMessage[] {
    return this.messages.filter((m) => m.createdAt > since);
  }

  queryMessageCount(): number {
    return this.messages.length;
  }

  queryMergeQueue(): DbMergeQueueEntry[] {
    return Array.from(this.mergeQueue.values()).filter(
      (e) => e.status === "pending" || e.status === "merging",
    );
  }

  queryMetricsSessions(): MetricsSession[] {
    return [...this.completedAgents];
  }
}
