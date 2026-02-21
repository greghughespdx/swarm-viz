/**
 * Dashboard overlay — shows active mode, project list, and smooth transitions
 * between live and demo states.
 *
 * Designed for always-on display: minimal chrome, auto-hides when active,
 * appears on idle to show project discovery status.
 */

import type { DashboardState } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardController {
	update(state: DashboardState): void;
	dispose(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long (ms) the mode banner is visible after a transition */
const BANNER_VISIBLE_MS = 4000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDashboard(): DashboardController {
	// -------------------------------------------------------------------------
	// Build DOM structure
	// -------------------------------------------------------------------------

	/** Outer container — pointer-events: none so it doesn't block the canvas */
	const container = document.createElement("div");
	container.id = "dashboard-overlay";
	document.body.appendChild(container);

	// ── Mode banner (top-center, shown briefly on transition) ──────────────
	const modeBanner = document.createElement("div");
	modeBanner.id = "mode-banner";
	modeBanner.textContent = "";
	container.appendChild(modeBanner);

	// -------------------------------------------------------------------------
	// State tracking
	// -------------------------------------------------------------------------

	let prevMode: string | null = null;
	let bannerTimer: ReturnType<typeof setTimeout> | null = null;
	let isTransitioning = false;

	// -------------------------------------------------------------------------
	// Mode banner
	// -------------------------------------------------------------------------

	function showBanner(text: string, cssClass: string): void {
		modeBanner.textContent = text;
		modeBanner.className = cssClass + " visible";

		if (bannerTimer) clearTimeout(bannerTimer);
		bannerTimer = setTimeout(() => {
			modeBanner.classList.remove("visible");
		}, BANNER_VISIBLE_MS);
	}

	// -------------------------------------------------------------------------
	// Main update
	// -------------------------------------------------------------------------

	function update(state: DashboardState): void {
		const modeChanged = prevMode !== null && prevMode !== state.mode;

		if (modeChanged) {
			isTransitioning = true;

			if (state.mode === "live") {
				showBanner(
					`◈ LIVE — ${state.activeProject ?? "unknown"}`,
					"banner-live",
				);
			} else {
				showBanner("◈ DEMO MODE — no active swarms", "banner-demo");
			}

			// Reset transition flag after animation settles
			setTimeout(() => { isTransitioning = false; }, 600);
		}

		// Update the status indicator in the existing #status HUD element
		const statusEl = document.getElementById("status");
		if (statusEl) {
			if (state.mode === "live") {
				statusEl.textContent = `⬤ ${state.activeProject}`;
				statusEl.className = "live-project";
			}
			// disconnected state is set by the websocket handler, don't override it here
		}

		prevMode = state.mode;
	}

	// -------------------------------------------------------------------------
	// Dispose
	// -------------------------------------------------------------------------

	function dispose(): void {
		if (bannerTimer) clearTimeout(bannerTimer);
		container.remove();
	}

	return { update, dispose };
}
