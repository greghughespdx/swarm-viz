# Swarm Viz

Real-time, full-screen animated visualization of Overstory multi-agent swarm activity.

## Vision

A stunning, dark-themed WebGL dashboard that shows the Overstory swarm in action:

- **Agent nodes** as glowing orbs in a force-directed graph, pulsing with activity
- **Messages** as animated particle trails arcing between agents
- **Worktrees** as branching light paths from the canonical trunk
- **Merge queue** as a converging flow visualization
- **Watchdog health** as ambient glow/pulse on the entire scene
- **Agent lifecycle** — nodes spawn in with bloom effects, fade on completion

Think: Tron meets NASA mission control. Dark background, neon accents, smooth 60fps animation.

## Tech Stack

- **Three.js** — WebGL rendering, particle systems, post-processing (bloom, glow)
- **WebSocket server** — Bridges Overstory SQLite state to the browser in real-time
- **Bun** — Server runtime (matches Overstory)
- **SQLite reads** — Direct read from Overstory's `mail.db`, `sessions.json`, merge queue

## Architecture

```
Overstory SQLite DBs ──→ Bun WebSocket server ──→ Browser (Three.js canvas)
     (mail.db, etc.)        (polls + pushes)         (full-screen WebGL)
```

## Data Sources

All data comes from Overstory's own state files in `.overstory/`:

| Source | What it shows |
|--------|--------------|
| `sessions.json` | Active agents, states, hierarchy |
| `mail.db` | Message flow between agents |
| `merge-queue.db` | Merge activity |
| `beads/` | Task tracking |
| Watchdog events | Health status |

## Key Constraints

- Read-only access to Overstory state (never write to its DBs)
- Must handle concurrent SQLite readers (WAL mode)
- Smooth animation even during high agent activity
- Full-screen, responsive, no UI chrome — pure visualization
