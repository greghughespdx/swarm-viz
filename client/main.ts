import type { StateSnapshot, SwarmMetrics } from "../shared/types.js";
import { createScene } from "./scene.js";
import { createWebSocket } from "./websocket.js";

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
// Toggle controls — keyboard shortcuts L / M / G
// ---------------------------------------------------------------------------
const toggles = { labels: false, msgLabels: false, clustering: false };

function updateToggles(): void {
	const el = document.getElementById("toggles");
	if (!el) return;
	el.textContent = [
		`[L] labels  ${toggles.labels ? "●" : "○"}`,
		`[M] msgs    ${toggles.msgLabels ? "●" : "○"}`,
		`[G] cluster ${toggles.clustering ? "●" : "○"}`,
	].join("\n");
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
	}
});

// Initialize toggle display
updateToggles();

// ---------------------------------------------------------------------------
// WebSocket URL: same host as the page, /ws path (server handles port)
// ---------------------------------------------------------------------------
const wsUrl = `ws://${window.location.host}/ws`;

createWebSocket(
	wsUrl,
	(msg) => {
		if (msg.type === "snapshot") {
			snapshot = msg.data;
			scene.applySnapshot(snapshot);
			updateStats(snapshot.metrics);
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
			}
		}
	},
	setStatus,
);
