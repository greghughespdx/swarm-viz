import { describe, expect, test } from "bun:test";
import {
  computeMetrics,
  mapEvent,
  mapMessage,
  mapMergeEntry,
  mapMetricsSession,
  mapSession,
  mapTokenSnapshot,
  toAgent,
  toAgentMessage,
  toVizMergeEntry,
} from "./mappers.ts";
import type {
  EventRow,
  MessageRow,
  MergeQueueRow,
  MetricsSessionRow,
  SessionRow,
  TokenSnapshotRow,
} from "./mappers.ts";

describe("mapSession", () => {
  test("maps all fields from snake_case to camelCase", () => {
    const row: SessionRow = {
      id: "session-001",
      agent_name: "server-builder",
      capability: "builder",
      worktree_path: "/path/to/worktree",
      branch_name: "overstory/server-builder/task-1",
      bead_id: "task-1",
      tmux_session: "overstory-0",
      state: "working",
      pid: 12345,
      parent_agent: "server-lead",
      depth: 2,
      run_id: "run-abc",
      started_at: "2026-02-16T20:00:00.000Z",
      last_activity: "2026-02-16T20:05:00.000Z",
      escalation_level: 0,
      stalled_since: null,
    };

    const session = mapSession(row);

    expect(session.id).toBe("session-001");
    expect(session.agentName).toBe("server-builder");
    expect(session.capability).toBe("builder");
    expect(session.worktreePath).toBe("/path/to/worktree");
    expect(session.branchName).toBe("overstory/server-builder/task-1");
    expect(session.beadId).toBe("task-1");
    expect(session.tmuxSession).toBe("overstory-0");
    expect(session.state).toBe("working");
    expect(session.pid).toBe(12345);
    expect(session.parentAgent).toBe("server-lead");
    expect(session.depth).toBe(2);
    expect(session.runId).toBe("run-abc");
    expect(session.startedAt).toBe("2026-02-16T20:00:00.000Z");
    expect(session.lastActivity).toBe("2026-02-16T20:05:00.000Z");
    expect(session.escalationLevel).toBe(0);
    expect(session.stalledSince).toBeNull();
  });

  test("handles null optional fields", () => {
    const row: SessionRow = {
      id: "session-002",
      agent_name: "coordinator",
      capability: "coordinator",
      worktree_path: "/path",
      branch_name: "main",
      bead_id: "",
      tmux_session: "overstory-1",
      state: "booting",
      pid: null,
      parent_agent: null,
      depth: 0,
      run_id: null,
      started_at: "2026-02-16T20:00:00.000Z",
      last_activity: "2026-02-16T20:00:00.000Z",
      escalation_level: 0,
      stalled_since: null,
    };

    const session = mapSession(row);
    expect(session.pid).toBeNull();
    expect(session.parentAgent).toBeNull();
    expect(session.runId).toBeNull();
  });
});

describe("mapMessage", () => {
  test("maps all fields and converts read integer to boolean", () => {
    const row: MessageRow = {
      id: "msg-001",
      from_agent: "server-builder",
      to_agent: "server-lead",
      subject: "Worker done: task-1",
      body: "Implementation complete",
      type: "worker_done",
      priority: "normal",
      thread_id: null,
      read: 0,
      created_at: "2026-02-16T20:10:00.000Z",
    };

    const msg = mapMessage(row);

    expect(msg.id).toBe("msg-001");
    expect(msg.fromAgent).toBe("server-builder");
    expect(msg.toAgent).toBe("server-lead");
    expect(msg.subject).toBe("Worker done: task-1");
    expect(msg.type).toBe("worker_done");
    expect(msg.priority).toBe("normal");
    expect(msg.threadId).toBeNull();
    expect(msg.read).toBe(false);
    expect(msg.createdAt).toBe("2026-02-16T20:10:00.000Z");
  });

  test("read=1 maps to true", () => {
    const row: MessageRow = {
      id: "msg-002",
      from_agent: "a",
      to_agent: "b",
      subject: "s",
      body: "b",
      type: "status",
      priority: "low",
      thread_id: "thread-1",
      read: 1,
      created_at: "2026-02-16T20:00:00.000Z",
    };

    expect(mapMessage(row).read).toBe(true);
    expect(mapMessage(row).threadId).toBe("thread-1");
  });
});

describe("mapMergeEntry", () => {
  test("parses files_modified JSON and maps fields", () => {
    const row: MergeQueueRow = {
      id: 1,
      branch_name: "overstory/builder/task-1",
      bead_id: "task-1",
      agent_name: "builder",
      files_modified: '["server/index.ts","shared/types.ts"]',
      enqueued_at: "2026-02-16T20:15:00.000Z",
      status: "pending",
      resolved_tier: null,
    };

    const entry = mapMergeEntry(row);

    expect(entry.id).toBe(1);
    expect(entry.branchName).toBe("overstory/builder/task-1");
    expect(entry.beadId).toBe("task-1");
    expect(entry.agentName).toBe("builder");
    expect(entry.filesModified).toEqual(["server/index.ts", "shared/types.ts"]);
    expect(entry.enqueuedAt).toBe("2026-02-16T20:15:00.000Z");
    expect(entry.status).toBe("pending");
    expect(entry.resolvedTier).toBeNull();
  });

  test("falls back to empty array on invalid JSON", () => {
    const row: MergeQueueRow = {
      id: 2,
      branch_name: "branch",
      bead_id: "task-2",
      agent_name: "agent",
      files_modified: "not-valid-json",
      enqueued_at: "2026-02-16T20:00:00.000Z",
      status: "merged",
      resolved_tier: "clean-merge",
    };

    const entry = mapMergeEntry(row);
    expect(entry.filesModified).toEqual([]);
    expect(entry.resolvedTier).toBe("clean-merge");
  });

  test("maps all merge statuses", () => {
    const statuses = ["pending", "merging", "merged", "conflict", "failed"] as const;
    for (const status of statuses) {
      const row: MergeQueueRow = {
        id: 1,
        branch_name: "b",
        bead_id: "t",
        agent_name: "a",
        files_modified: "[]",
        enqueued_at: "2026-02-16T20:00:00.000Z",
        status,
        resolved_tier: null,
      };
      expect(mapMergeEntry(row).status).toBe(status);
    }
  });
});

describe("mapEvent", () => {
  test("maps all fields from snake_case to camelCase", () => {
    const row: EventRow = {
      id: 42,
      run_id: "run-xyz",
      agent_name: "server-builder",
      session_id: "sess-001",
      event_type: "tool_call",
      tool_name: "Bash",
      tool_args: '{"command":"bun test"}',
      tool_duration_ms: 1234,
      level: "info",
      data: null,
      created_at: "2026-02-16T21:00:00.000Z",
    };

    const event = mapEvent(row);

    expect(event.id).toBe(42);
    expect(event.runId).toBe("run-xyz");
    expect(event.agentName).toBe("server-builder");
    expect(event.sessionId).toBe("sess-001");
    expect(event.eventType).toBe("tool_call");
    expect(event.toolName).toBe("Bash");
    expect(event.toolArgs).toBe('{"command":"bun test"}');
    expect(event.toolDurationMs).toBe(1234);
    expect(event.level).toBe("info");
    expect(event.data).toBeNull();
    expect(event.createdAt).toBe("2026-02-16T21:00:00.000Z");
  });

  test("handles null optional fields", () => {
    const row: EventRow = {
      id: 1,
      run_id: null,
      agent_name: "agent",
      session_id: null,
      event_type: "session_start",
      tool_name: null,
      tool_args: null,
      tool_duration_ms: null,
      level: "debug",
      data: null,
      created_at: "2026-02-16T21:00:00.000Z",
    };

    const event = mapEvent(row);
    expect(event.runId).toBeNull();
    expect(event.sessionId).toBeNull();
    expect(event.toolName).toBeNull();
    expect(event.toolArgs).toBeNull();
    expect(event.toolDurationMs).toBeNull();
  });

  test("maps all event levels", () => {
    const levels = ["debug", "info", "warn", "error"] as const;
    for (const level of levels) {
      const row: EventRow = {
        id: 1,
        run_id: null,
        agent_name: "a",
        session_id: null,
        event_type: "test",
        tool_name: null,
        tool_args: null,
        tool_duration_ms: null,
        level,
        data: null,
        created_at: "2026-02-16T21:00:00.000Z",
      };
      expect(mapEvent(row).level).toBe(level);
    }
  });
});

describe("mapMetricsSession", () => {
  test("maps all fields from snake_case to camelCase", () => {
    const row: MetricsSessionRow = {
      agent_name: "server-builder",
      bead_id: "task-1",
      capability: "builder",
      started_at: "2026-02-16T20:00:00.000Z",
      completed_at: "2026-02-16T21:00:00.000Z",
      duration_ms: 3600000,
      exit_code: 0,
      merge_result: "clean",
      parent_agent: "server-lead",
      input_tokens: 50000,
      output_tokens: 10000,
      cache_read_tokens: 5000,
      cache_creation_tokens: 2000,
      estimated_cost_usd: 0.15,
      model_used: "claude-sonnet-4-5",
    };

    const session = mapMetricsSession(row);

    expect(session.agentName).toBe("server-builder");
    expect(session.beadId).toBe("task-1");
    expect(session.capability).toBe("builder");
    expect(session.startedAt).toBe("2026-02-16T20:00:00.000Z");
    expect(session.completedAt).toBe("2026-02-16T21:00:00.000Z");
    expect(session.durationMs).toBe(3600000);
    expect(session.exitCode).toBe(0);
    expect(session.mergeResult).toBe("clean");
    expect(session.parentAgent).toBe("server-lead");
    expect(session.inputTokens).toBe(50000);
    expect(session.outputTokens).toBe(10000);
    expect(session.cacheReadTokens).toBe(5000);
    expect(session.cacheCreationTokens).toBe(2000);
    expect(session.estimatedCostUsd).toBe(0.15);
    expect(session.modelUsed).toBe("claude-sonnet-4-5");
  });

  test("handles null optional fields", () => {
    const row: MetricsSessionRow = {
      agent_name: "agent",
      bead_id: "task",
      capability: "builder",
      started_at: "2026-02-16T20:00:00.000Z",
      completed_at: null,
      duration_ms: 0,
      exit_code: null,
      merge_result: null,
      parent_agent: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      estimated_cost_usd: null,
      model_used: null,
    };

    const session = mapMetricsSession(row);
    expect(session.completedAt).toBeNull();
    expect(session.exitCode).toBeNull();
    expect(session.mergeResult).toBeNull();
    expect(session.parentAgent).toBeNull();
    expect(session.estimatedCostUsd).toBeNull();
    expect(session.modelUsed).toBeNull();
  });
});

// ── Viz mapper tests ─────────────────────────────────────────────────────────

describe("toAgent", () => {
  test("maps AgentSession to viz Agent", () => {
    const session = mapSession({
      id: "sess-001",
      agent_name: "server-builder",
      capability: "builder",
      worktree_path: "/path",
      branch_name: "overstory/server-builder/task-1",
      bead_id: "task-1",
      tmux_session: "overstory-0",
      state: "working",
      pid: 123,
      parent_agent: "server-lead",
      depth: 2,
      run_id: null,
      started_at: "2026-02-16T20:00:00.000Z",
      last_activity: "2026-02-16T20:05:00.000Z",
      escalation_level: 0,
      stalled_since: null,
    });

    const agent = toAgent(session);

    expect(agent.name).toBe("server-builder");
    expect(agent.capability).toBe("builder");
    expect(agent.state).toBe("working");
    expect(agent.parentAgent).toBe("server-lead");
    expect(agent.depth).toBe(2);
    expect(agent.beadId).toBe("task-1");
    expect(agent.lastActivity).toBe(new Date("2026-02-16T20:05:00.000Z").getTime());
  });

  test("falls back to 'builder' for unknown capability", () => {
    const session = mapSession({
      id: "sess-002",
      agent_name: "unknown-agent",
      capability: "some-future-capability",
      worktree_path: "/path",
      branch_name: "branch",
      bead_id: "",
      tmux_session: "tmux-0",
      state: "booting",
      pid: null,
      parent_agent: null,
      depth: 0,
      run_id: null,
      started_at: "2026-02-16T20:00:00.000Z",
      last_activity: "2026-02-16T20:00:00.000Z",
      escalation_level: 0,
      stalled_since: null,
    });

    expect(toAgent(session).capability).toBe("builder");
  });

  test("maps empty beadId to null", () => {
    const session = mapSession({
      id: "sess-003",
      agent_name: "a",
      capability: "coordinator",
      worktree_path: "/p",
      branch_name: "main",
      bead_id: "",
      tmux_session: "t",
      state: "working",
      pid: null,
      parent_agent: null,
      depth: 0,
      run_id: null,
      started_at: "2026-02-16T20:00:00.000Z",
      last_activity: "2026-02-16T20:00:00.000Z",
      escalation_level: 0,
      stalled_since: null,
    });

    expect(toAgent(session).beadId).toBeNull();
  });
});

describe("toAgentMessage", () => {
  test("maps MailMessage to viz AgentMessage", () => {
    const msg = mapMessage({
      id: "msg-001",
      from_agent: "server-builder",
      to_agent: "server-lead",
      subject: "Worker done: task-1",
      body: "body",
      type: "worker_done",
      priority: "normal",
      thread_id: null,
      read: 0,
      created_at: "2026-02-16T20:10:00.000Z",
    });

    const vizMsg = toAgentMessage(msg);

    expect(vizMsg.id).toBe("msg-001");
    expect(vizMsg.from).toBe("server-builder");
    expect(vizMsg.to).toBe("server-lead");
    expect(vizMsg.type).toBe("worker_done");
    expect(vizMsg.priority).toBe("normal");
    expect(vizMsg.subject).toBe("Worker done: task-1");
    expect(vizMsg.createdAt).toBe(new Date("2026-02-16T20:10:00.000Z").getTime());
  });
});

describe("toVizMergeEntry", () => {
  test("maps DbMergeQueueEntry to viz MergeQueueEntry (strips DB-only fields)", () => {
    const dbEntry = mapMergeEntry({
      id: 1,
      branch_name: "overstory/builder/task-1",
      bead_id: "task-1",
      agent_name: "builder",
      files_modified: '["server/index.ts"]',
      enqueued_at: "2026-02-16T20:15:00.000Z",
      status: "pending",
      resolved_tier: null,
    });

    const vizEntry = toVizMergeEntry(dbEntry);

    expect(vizEntry.branchName).toBe("overstory/builder/task-1");
    expect(vizEntry.agentName).toBe("builder");
    expect(vizEntry.status).toBe("pending");
    expect(vizEntry.filesModified).toEqual(["server/index.ts"]);
    // DB-only fields should not be present
    expect((vizEntry as { id?: number }).id).toBeUndefined();
    expect((vizEntry as { enqueuedAt?: string }).enqueuedAt).toBeUndefined();
  });
});

describe("computeMetrics", () => {
  const makeSession = (state: string, name: string) =>
    mapSession({
      id: name,
      agent_name: name,
      capability: "builder",
      worktree_path: "/p",
      branch_name: "b",
      bead_id: "t",
      tmux_session: "s",
      state,
      pid: null,
      parent_agent: null,
      depth: 1,
      run_id: null,
      started_at: "2026-02-16T20:00:00.000Z",
      last_activity: "2026-02-16T20:00:00.000Z",
      escalation_level: 0,
      stalled_since: null,
    });

  test("counts agents and active agents correctly", () => {
    const sessions = [
      makeSession("working", "a"),
      makeSession("booting", "b"),
      makeSession("completed", "c"),
      makeSession("stalled", "d"),
    ];

    const metrics = computeMetrics(sessions, 10, []);
    expect(metrics.totalAgents).toBe(4);
    expect(metrics.activeAgents).toBe(2); // working + booting
    expect(metrics.totalMessages).toBe(10);
    expect(metrics.totalCost).toBe(0);
  });

  test("sums estimated cost from metrics sessions", () => {
    const metricsSessions = [
      mapMetricsSession({
        agent_name: "a",
        bead_id: "t1",
        capability: "builder",
        started_at: "2026-02-16T20:00:00.000Z",
        completed_at: null,
        duration_ms: 0,
        exit_code: null,
        merge_result: null,
        parent_agent: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        estimated_cost_usd: 0.10,
        model_used: null,
      }),
      mapMetricsSession({
        agent_name: "b",
        bead_id: "t2",
        capability: "lead",
        started_at: "2026-02-16T20:00:00.000Z",
        completed_at: null,
        duration_ms: 0,
        exit_code: null,
        merge_result: null,
        parent_agent: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        estimated_cost_usd: 0.25,
        model_used: null,
      }),
    ];

    const metrics = computeMetrics([], 0, metricsSessions);
    expect(metrics.totalCost).toBeCloseTo(0.35);
  });

  test("handles null estimatedCostUsd gracefully", () => {
    const metricsSessions = [
      mapMetricsSession({
        agent_name: "a",
        bead_id: "t1",
        capability: "builder",
        started_at: "2026-02-16T20:00:00.000Z",
        completed_at: null,
        duration_ms: 0,
        exit_code: null,
        merge_result: null,
        parent_agent: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        estimated_cost_usd: null,
        model_used: null,
      }),
    ];

    expect(computeMetrics([], 0, metricsSessions).totalCost).toBe(0);
  });
});

describe("mapTokenSnapshot", () => {
  test("maps all fields", () => {
    const row: TokenSnapshotRow = {
      id: 7,
      agent_name: "server-builder",
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 200,
      cache_creation_tokens: 100,
      estimated_cost_usd: 0.02,
      model_used: "claude-sonnet-4-5",
      created_at: "2026-02-16T20:30:00.000Z",
    };

    const snap = mapTokenSnapshot(row);

    expect(snap.id).toBe(7);
    expect(snap.agentName).toBe("server-builder");
    expect(snap.inputTokens).toBe(1000);
    expect(snap.outputTokens).toBe(500);
    expect(snap.cacheReadTokens).toBe(200);
    expect(snap.cacheCreationTokens).toBe(100);
    expect(snap.estimatedCostUsd).toBe(0.02);
    expect(snap.modelUsed).toBe("claude-sonnet-4-5");
    expect(snap.createdAt).toBe("2026-02-16T20:30:00.000Z");
  });

  test("handles null optional fields", () => {
    const row: TokenSnapshotRow = {
      id: 1,
      agent_name: "a",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      estimated_cost_usd: null,
      model_used: null,
      created_at: "2026-02-16T20:00:00.000Z",
    };

    const snap = mapTokenSnapshot(row);
    expect(snap.estimatedCostUsd).toBeNull();
    expect(snap.modelUsed).toBeNull();
  });
});
