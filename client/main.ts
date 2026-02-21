import type { AgentCostEntry, DashboardState, StateSnapshot, SwarmMetrics } from "../shared/types.js";
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
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		costPerMinute: 0,
		agentCosts: [],
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

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function updateStats(metrics: SwarmMetrics): void {
	const el = document.getElementById("stats");
	if (!el) return;
	const totalTokens = metrics.totalInputTokens + metrics.totalOutputTokens + metrics.totalCacheReadTokens;
	el.textContent = [
		"",
		"",
		`agents  ${metrics.totalAgents}`,
		`active  ${metrics.activeAgents}`,
		`msgs    ${metrics.totalMessages}`,
		`tokens  ${formatTokens(totalTokens)}`,
		`$/min   $${metrics.costPerMinute.toFixed(2)}`,
		`cost    $${metrics.totalCost.toFixed(4)}`,
	].join("\n");
}

function updateCostPanel(metrics: SwarmMetrics, visible: boolean): void {
	const el = document.getElementById("cost-panel");
	if (!el) return;

	if (!visible) {
		el.style.display = "none";
		return;
	}

	el.style.display = "block";

	if (metrics.agentCosts.length === 0) {
		el.textContent = "cost breakdown\n(no data)";
		return;
	}

	// Dynamic row count: measure actual available space between work-items and stats panels.
	const lineHeightPx = 12; // ~9px font * 1.3 line-height
	const workEl = document.getElementById("work-items");
	const statsEl = document.getElementById("stats");
	const workBottom = workEl && workEl.style.display !== "none" ? workEl.getBoundingClientRect().bottom : 40;
	const statsTop = statsEl ? statsEl.getBoundingClientRect().top : window.innerHeight - 20;
	const availableHeight = statsTop - workBottom - 24; // 24px padding
	const summaryLines = 4; // total, tokens, $/min, header
	const maxRows = Math.max(3, Math.floor(availableHeight / lineHeightPx) - summaryLines);
	const lines = ["cost breakdown"];
	const shownCosts = metrics.agentCosts.slice(0, maxRows);
	const hidden = metrics.agentCosts.length - maxRows;
	for (const entry of shownCosts) {
		const name = entry.agentName.length > 18 ? entry.agentName.slice(0, 18) : entry.agentName;
		const cost = `$${entry.costUsd.toFixed(2)}`;
		const model = entry.modelUsed || '?';
		lines.push(`${name.padEnd(18)}  ${cost.padStart(7)}  ${model}`);
	}
	if (hidden > 0) {
		lines.push(`  ... +${hidden} more`);
	}
	lines.push(`${"total".padEnd(18)}  $${metrics.totalCost.toFixed(2).padStart(6)}`);
	const totalIn = metrics.totalInputTokens + metrics.totalCacheReadTokens;
	const totalOut = metrics.totalOutputTokens;
	lines.push(`tokens in:  ${formatTokens(totalIn).padStart(6)}  out: ${formatTokens(totalOut)}`);
	lines.push(`$/min       $${metrics.costPerMinute.toFixed(2)}`);

	el.textContent = lines.join("\n");

	// After rendering, check if panel overlaps stats and shift up if needed.
	requestAnimationFrame(() => {
		const costRect = el.getBoundingClientRect();
		const statsEl2 = document.getElementById("stats");
		if (!statsEl2) return;
		const statsTop2 = statsEl2.getBoundingClientRect().top;
		const overlap = costRect.bottom - statsTop2 + 8;
		if (overlap > 0) {
			el.style.top = `calc(50% - ${overlap}px)`;
		} else {
			el.style.top = "50%";
		}
	});
}

// ---------------------------------------------------------------------------
// Toggle controls — keyboard shortcuts L / M / G / W / C
// ---------------------------------------------------------------------------
// costMode cycles: 0 = both (panel + labels), 1 = labels only, 2 = panel only, 3 = off
let costMode = 0;
const toggles = { labels: true, msgLabels: true, clustering: true, workItems: true, costs: true };

function updateToggles(): void {
	const el = document.getElementById("toggles");
	if (!el) return;

	const items = [
		{ key: "l", label: "labels ", on: toggles.labels },
		{ key: "m", label: "msgs   ", on: toggles.msgLabels },
		{ key: "g", label: "cluster", on: toggles.clustering },
		{ key: "w", label: "work   ", on: toggles.workItems },
		{ key: "c", label: "costs  ", on: costMode < 3 },
	];

	el.innerHTML = items.map((item) =>
		`<span class="toggle-row" data-key="${item.key}">[${item.key.toUpperCase()}] ${item.label} ${item.on ? "●" : "○"}</span>`
	).join("\n");
}

// Click handler for toggles
document.getElementById("toggles")?.addEventListener("click", (e) => {
	const row = (e.target as HTMLElement).closest(".toggle-row");
	if (!row) return;
	const key = row.getAttribute("data-key");
	if (key) {
		window.dispatchEvent(new KeyboardEvent("keydown", { key }));
	}
});

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

// ---------------------------------------------------------------------------
// Cost panel — update from current snapshot metrics
// ---------------------------------------------------------------------------
function refreshCostPanel(): void {
	const showPanel = costMode === 0 || costMode === 2;
	const showLabels = costMode === 0 || costMode === 1;
	updateCostPanel(snapshot.metrics, showPanel);
	scene.setCostLabelsVisible(showLabels);
	scene.updateAgentCosts(snapshot.metrics.agentCosts);
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
		case "c":
			costMode = (costMode + 1) % 4;
			refreshCostPanel();
			updateToggles();
			break;
	}
});

// Initialize toggle display and apply defaults
updateToggles();
scene.setLabelsVisible(toggles.labels);
scene.setMsgLabelsVisible(toggles.msgLabels);
scene.setClusteringEnabled(toggles.clustering);
scene.setCostLabelsVisible(costMode === 0 || costMode === 1);

// ---------------------------------------------------------------------------
// Resize handler — recalculate dynamic panels
// ---------------------------------------------------------------------------
window.addEventListener("resize", () => {
	refreshCostPanel();
});

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
			refreshCostPanel();
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
					metrics: {
						totalAgents: 0,
						activeAgents: 0,
						totalMessages: 0,
						totalCost: 0,
						totalInputTokens: 0,
						totalOutputTokens: 0,
						totalCacheReadTokens: 0,
						costPerMinute: 0,
						agentCosts: [],
					},
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
					refreshCostPanel();
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
