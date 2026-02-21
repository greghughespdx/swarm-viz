/**
 * Auto-discovery: scans known project roots for active .overstory/ directories.
 * Periodically rescans and emits change events when the set of active projects changes.
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { DiscoveredProject } from "../shared/types.ts";

// ── Configuration ─────────────────────────────────────────────────────────────

/** Project roots to scan. Each directory is one level up from the actual projects. */
const PROJECT_ROOTS: string[] = [
  join(homedir(), "Dev", "projects"),
  join(homedir(), "gt"),
];

/** Files/directories that must exist inside .overstory/ for it to be "active" */
const REQUIRED_OVERSTORY_FILES = ["sessions.db"];

/** Rescan interval in milliseconds */
export const DISCOVERY_INTERVAL_MS = 30_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type DiscoveryChangeHandler = (projects: DiscoveredProject[]) => void;

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Scan a single project root directory and return all projects that have a
 * valid (non-empty) .overstory/ directory.
 */
function scanRoot(root: string): DiscoveredProject[] {
  if (!existsSync(root)) return [];

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const results: DiscoveredProject[] = [];

  for (const entry of entries) {
    const projectPath = join(root, entry);
    try {
      const stat = statSync(projectPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const overstoryDir = join(projectPath, ".overstory");
    if (!existsSync(overstoryDir)) continue;

    // Verify the .overstory/ directory has the required files
    const hasRequired = REQUIRED_OVERSTORY_FILES.every((f) =>
      existsSync(join(overstoryDir, f)),
    );
    if (!hasRequired) continue;

    results.push({
      name: basename(projectPath),
      path: projectPath,
      overstoryDir,
      active: false,
      activeAgents: 0,
    });
  }

  return results;
}

/**
 * Scan all project roots and return the combined list of discovered projects.
 */
export function discoverProjects(): DiscoveredProject[] {
  const all: DiscoveredProject[] = [];
  for (const root of PROJECT_ROOTS) {
    all.push(...scanRoot(root));
  }
  // Deduplicate by path (shouldn't happen in practice, but be safe)
  const seen = new Set<string>();
  return all.filter((p) => {
    if (seen.has(p.path)) return false;
    seen.add(p.path);
    return true;
  });
}

/**
 * Produce a stable string key for a list of projects so we can detect changes
 * without deep equality checks.
 */
function projectsKey(projects: DiscoveredProject[]): string {
  return projects
    .map((p) => p.path)
    .sort()
    .join("|");
}

// ── Discovery manager ─────────────────────────────────────────────────────────

export class DiscoveryManager {
  private projects: DiscoveredProject[] = [];
  private lastKey = "";
  private handlers: DiscoveryChangeHandler[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Initial scan
    this.scan();
  }

  /**
   * Register a handler to be called whenever the set of discovered projects changes.
   */
  onChange(handler: DiscoveryChangeHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Get the current list of discovered projects.
   */
  getProjects(): DiscoveredProject[] {
    return this.projects;
  }

  /**
   * Update the active agent count for a named project.
   * Called by the server when it polls SQLite databases.
   */
  updateActiveAgents(projectName: string, count: number): void {
    const project = this.projects.find((p) => p.name === projectName);
    if (project && project.activeAgents !== count) {
      project.activeAgents = count;
      this.notifyHandlers();
    }
  }

  /**
   * Start periodic rescanning.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan(), DISCOVERY_INTERVAL_MS);
  }

  /**
   * Stop periodic rescanning.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one discovery scan. Notifies handlers only when the project list changes.
   */
  private scan(): void {
    const discovered = discoverProjects();
    const key = projectsKey(discovered);

    if (key === this.lastKey) {
      // No structural change — preserve existing activeAgents counts
      return;
    }

    // Preserve activeAgents from previous scan for projects that persisted
    const prev = new Map(this.projects.map((p) => [p.path, p]));
    for (const p of discovered) {
      const existing = prev.get(p.path);
      if (existing) {
        p.activeAgents = existing.activeAgents;
      }
    }

    this.projects = discovered;
    this.lastKey = key;
    this.notifyHandlers();

    console.log(
      `[swarm-viz] Discovery scan: ${discovered.length} project(s) found — ${discovered.map((p) => p.name).join(", ") || "(none)"}`,
    );
  }

  private notifyHandlers(): void {
    for (const handler of this.handlers) {
      handler(this.projects);
    }
  }
}
