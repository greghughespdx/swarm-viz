import type { DashboardState, StateSnapshot, SwarmMetrics } from "../shared/types.js";
import { createScene } from "./scene.js";
import { createWebSocket } from "./websocket.js";
import { createDashboard } from "./dashboard.js";

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------
const canvas = document.createElement("canvas");
document.body.insertBefore(canvas, document.body.firstChild);

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
const scene = createScene(canvas);

// ---------------------------------------------------------------------------
// Dashboard overlay
// ---------------------------------------------------------------------------
const dashboard = createDashboard();

// ---------------------------------------------------------------------------
// Local state — keep a running copy so incremental updates can be merged
// ---------------------------------------------------------------------------
let snapshot: StateSnapshot = {
	agents: [],
	messages: [],
	mergeQueue: [],
	metrics: {
		totalAgents: 0,
		activeAgents: 0,
		totalMessages: 0,
		totalCost: 0,
	},
};

// ---------------------------------------------------------------------------
// HUD helpers
// ---------------------------------------------------------------------------
function setStatus(connected: boolean): void {
	const el = document.getElementById("status");
	if (!el) return;
	el.textContent = connected ? "⬤ live" : "⬤ reconnecting";
	el.className = connected ? "" : "disconnected";
}

function updateStats(metrics: SwarmMetrics): void {
	const el = document.getElementById("stats");
	if (!el) return;
	el.textContent = [
		`agents  ${metrics.totalAgents}`,
		`active  ${metrics.activeAgents}`,
		`msgs    ${metrics.totalMessages}`,
		`cost    $${metrics.totalCost.toFixed(4)}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Toggle controls — keyboard shortcuts L / M / G / W
// ---------------------------------------------------------------------------
const toggles = { labels: true, msgLabels: true, clustering: true, workItems: true };

function updateToggles(): void {
	const el = document.getElementById("toggles");
	if (!el) return;
	el.textContent = [
		`[L] labels  ${toggles.labels ? "●" : "○"}`,
		`[M] msgs    ${toggles.msgLabels ? "●" : "○"}`,
		`[G] cluster ${toggles.clustering ? "●" : "○"}`,
		`[W] work    ${toggles.workItems ? "●" : "○"}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Work items HUD — upper-left panel showing agent name + current bead
// ---------------------------------------------------------------------------
function updateWorkItems(): void {
	const el = document.getElementById("work-items");
	if (!el) return;

	if (!toggles.workItems) {
		el.style.display = "none";
		return;
	}

	el.style.display = "block";

	const activeAgents = snapshot.agents.filter(
		(a) => a.state === "working" || a.state === "booting",
	);

	if (activeAgents.length === 0) {
		el.textContent = "work items\n(no active agents)";
		return;
	}

	const lines = ["work items"];
	for (const agent of activeAgents) {
		const bead = agent.beadId ?? "—";
		lines.push(`${agent.name}  ${bead}`);
	}
	el.textContent = lines.join("\n");
}

window.addEventListener("keydown", (e) => {
	switch (e.key.toLowerCase()) {
		case "l":
			toggles.labels = !toggles.labels;
			scene.setLabelsVisible(toggles.labels);
			updateToggles();
			break;
		case "m":
			toggles.msgLabels = !toggles.msgLabels;
			scene.setMsgLabelsVisible(toggles.msgLabels);
			updateToggles();
			break;
		case "g":
			toggles.clustering = !toggles.clustering;
			scene.setClusteringEnabled(toggles.clustering);
			updateToggles();
			break;
		case "w":
			toggles.workItems = !toggles.workItems;
			updateWorkItems();
			updateToggles();
			break;
	}
});

// Initialize toggle display and apply defaults
updateToggles();
scene.setLabelsVisible(toggles.labels);
scene.setMsgLabelsVisible(toggles.msgLabels);
scene.setClusteringEnabled(toggles.clustering);

// ---------------------------------------------------------------------------
// WebSocket URL: same host as the page, /ws path (server handles port)
// ---------------------------------------------------------------------------
const wsUrl = `ws://${window.location.host}/ws`;

// Track current dashboard state for transition management
let currentDashboardState: DashboardState | null = null;

createWebSocket(
	wsUrl,
	(msg) => {
		if (msg.type === "snapshot") {
			snapshot = msg.data;
			scene.applySnapshot(snapshot);
			updateStats(snapshot.metrics);
			updateWorkItems();
			return;
		}

		if (msg.type === "dashboard_state") {
			const ds = msg.data;
			const prevMode = currentDashboardState?.mode;
			currentDashboardState = ds;
			dashboard.update(ds);

			// When mode switches, clear the scene for a clean transition
			if (prevMode !== undefined && prevMode !== ds.mode) {
				scene.applySnapshot({
					agents: [],
					messages: [],
					mergeQueue: [],
					metrics: { totalAgents: 0, activeAgents: 0, totalMessages: 0, totalCost: 0 },
				});
			}
			return;
		}

		if (msg.type === "update") {
			const update = msg.data;

			switch (update.type) {
				case "agent_update": {
					const agent = update.data;
					const idx = snapshot.agents.findIndex((a) => a.name === agent.name);
					if (idx >= 0) {
						snapshot.agents[idx] = agent;
					} else {
						snapshot.agents = [...snapshot.agents, agent];
					}
					scene.applySnapshot(snapshot);
					updateWorkItems();
					break;
				}

				case "message_event": {
					snapshot.messages = [...snapshot.messages, update.data];
					scene.addMessage(update.data);
					break;
				}

				case "merge_update": {
					const entry = update.data;
					const idx = snapshot.mergeQueue.findIndex(
						(e) => e.branchName === entry.branchName,
					);
					if (idx >= 0) {
						snapshot.mergeQueue[idx] = entry;
					} else {
						snapshot.mergeQueue = [...snapshot.mergeQueue, entry];
					}
					scene.applySnapshot(snapshot);
					break;
				}

				case "metrics_update": {
					snapshot.metrics = update.data;
					updateStats(snapshot.metrics);
					break;
				}

				case "tool_event": {
					const { agentName, toolName } = update.data;
					console.log(`[particle] ${agentName} -> ${toolName}`);
					scene.emitActivityParticle(agentName, toolName);
					break;
				}
			}
		}
	},
	setStatus,
);
