# Atomic Visualization Mode

## Summary

swarm-viz currently renders agent swarms as a deep-space scene: glowing orbs on a dark background with bloom post-processing, orbiting moons, and activity particles. This design adds an alternate "atomic model" renderer that maps the same real-time data onto a physics-inspired atomic metaphor. Agents become atoms, tool calls become electrons transitioning between orbital shells, and messages become photons traveling along molecular bonds. Users toggle between modes with the `[A]` key. Both modes share the same data pipeline, camera, and HUD overlays; only the rendering layer swaps.

---

## Metaphor Mapping

| Data Concept | Space Mode (current) | Atomic Mode (new) |
|---|---|---|
| Agent | Glowing orb | Atom nucleus |
| Agent capability radius | Fixed per-capability | Same baseline; grows with cumulative tokens |
| Agent color | Bead-hash tint over state color | Same coloring logic |
| Working state indicator | Orbiting moon + pulse scale | Electrons in outer shells + nucleus glow |
| Active tool call | Particle burst at orb | Electron appears in outer shell |
| Tool completion | Particle burst | Electron drops shell, photon burst outward |
| Agent-to-agent message | Bezier arc with packet | Photon travels along bond line |
| Parent-child relationship | Faint edge line | Molecular bond line (styled differently) |
| Token consumption rate | Not visualized | Electron cloud density and radius |
| Cumulative token weight | Not visualized | Nucleus radius (subtle growth, up to 1.3x) |
| Merge queue entries | Diamond shapes at bottom | Unchanged (not part of atomic metaphor) |
| Completed agent | Fade-out + shrink | Same fade-out behavior |

---

## Data Pipeline

### Existing WebSocket events used as-is

| Event | Type | Usage in atomic mode |
|---|---|---|
| `snapshot` | Full state | Initial atom layout, nucleus sizes, bond lines |
| `agent_update` | Incremental | Update nucleus color, state, trigger electron spawn/absorb |
| `message_event` | Incremental | Fire photon along bond line toward recipient |
| `merge_update` | Incremental | Diamond display (unchanged) |
| `metrics_update` | Incremental | Update cost display in HUD |
| `tool_event` (tool_start) | Incremental | Spawn electron in outer shell |

### New server-side requirements

Two additions are needed to support token-driven effects:

**1. `tool_end` event streaming**

Currently `events.db` is queried with filter `event_type IN ('tool_start', 'mail_sent')`. The `tool_end` event type exists in the schema (`OvrstoryEvent.toolDurationMs` is already modeled) but is filtered out before streaming.

Required change in `server/index.ts`, `stmtNewEvents` query:

```
event_type IN ('tool_start', 'tool_end', 'mail_sent')
```

The `ToolEventData` wire type needs `durationMs` added:

```typescript
export interface ToolEventData {
  agentName: string;
  toolName: string | null;
  eventType: string;   // 'tool_start' | 'tool_end' | 'mail_sent'
  durationMs: number | null;  // populated on tool_end; null otherwise
  createdAt: string;
}
```

The `tool_end` event enables two effects: electron shell-drop animation and photon burst size scaled by duration.

**2. `token_snapshot` WebSocket message type**

Token rate (tokens per second) drives the electron cloud density and radius. This requires a periodic server-computed delta between consecutive `metrics.db` snapshot reads.

New server message type:

```typescript
| { type: 'token_snapshot'; data: TokenRateSnapshot[] }
```

```typescript
export interface TokenRateSnapshot {
  agentName: string;
  tokensPerSecond: number;   // (inputTokens + outputTokens) delta / interval
  cumulativeTokens: number;  // total lifetime tokens for nucleus sizing
}
```

The server computes this by caching the previous `queryMetricsSessions()` result and diffing against the current one each poll cycle. The delta divided by `POLL_INTERVAL_MS / 1000` yields tokens per second. This can be computed server-side without a new database query since `queryMetricsSessions()` is already called every poll cycle.

Broadcast cadence: every poll cycle (500ms default), same as other updates. Clients that receive a `token_snapshot` update their per-agent rate map and immediately apply cloud adjustments.

---

## Visual Specifications

### Nucleus

The nucleus is rendered the same way as the current orb: `THREE.SphereGeometry` with `THREE.MeshBasicMaterial`. Differences:

- Baseline radius uses the existing `CAPABILITY_RADIUS` table.
- A `tokenScale` multiplier is applied on top, ranging from 1.0 (no tokens) to 1.3 (heaviest agent). Computed as `1.0 + 0.3 * (cumulativeTokens / maxCumulativeTokensAcrossSwarm)`. Recalculated when `token_snapshot` arrives.
- The nucleus does not pulse-scale the way current orbs do. Instead, the bloom strength increases with excitation level (see Excited State Glow below).

### Electron Cloud

A point cloud of tiny semi-transparent dots orbiting at varying radii around the nucleus. Implemented as `THREE.Points` with `THREE.PointsMaterial` for GPU-efficient rendering.

Properties per agent:

- Point count: scales from 80 (idle) to 400 (high activity) based on `tokensPerSecond`.
- Cloud radius: inner edge at `nucleusRadius * 2.0`, outer edge extending outward by `tokensPerSecond * 0.15` world units, capped at `nucleusRadius * 5.0`.
- Individual point opacity: 0.12 to 0.25. Cumulative effect creates the probability-cloud mist.
- Point size: 0.04 world units.
- Color: same hue as nucleus but desaturated (HSL saturation * 0.4, lightness 0.65).
- Animation: each point moves along a randomized elliptical path. On each frame, add a small angular increment (randomized per point, seeded at creation) plus Gaussian noise. No need to simulate orbits precisely; the effect is statistical.

When `token_snapshot` arrives with an updated rate, the cloud geometry is not rebuilt. Instead, a `cloudTargetCount` and `cloudTargetRadius` are set, and the actual geometry lerps toward them over 1.5 seconds by adjusting the positions of visible points (showing/hiding via material opacity on individual points using a typed attribute, or by rebuilding the geometry at a capped frequency of once per 500ms).

### Orbital Shells

Three concentric torus geometries centered on the nucleus:

- Shell 1: radius `nucleusRadius * 1.5`, tube radius 0.01
- Shell 2: radius `nucleusRadius * 2.5`, tube radius 0.01
- Shell 3: radius `nucleusRadius * 3.5`, tube radius 0.01

Default opacity: 0.05 (nearly invisible). When an electron occupies a shell, that shell's opacity increases to 0.35, lerping up over 0.2 seconds and back down when the electron leaves.

Shells use `THREE.MeshBasicMaterial` with `transparent: true`. They rotate slowly around the Y-axis (0.3 rad/s) to give a three-dimensional impression. Shell color is a cooler, lighter tint of the nucleus color.

### Electrons

Electrons replace moons. Each active tool call creates one electron. At any moment an agent may have 0-N electrons where N equals the number of concurrent tool calls in flight.

State machine per electron:

1. `tool_start` received: electron spawns at shell 3 (outermost), radius `nucleusRadius * 3.5`. Initial position is random on that shell's circumference.
2. While active: orbits shell 3. Angular speed 2.0 rad/s. Same tilted-plane math as current moons (`tiltX`, `tiltZ`). Size: `nucleusRadius * 0.15`.
3. `tool_end` received (matched by agentName + toolName): electron transitions to shell 1 (innermost). Animate position interpolation over 0.35 seconds along a curved path inward (lerp through shells 2 then 1). During transition, emit photon burst.
4. After 0.8 seconds resting in shell 1: electron fades out (not re-emitted; it "relaxed" to ground state).

If no `tool_end` is received within 30 seconds of `tool_start`, the electron self-destructs (absorbed like a moon, no photon). This handles dropped events gracefully.

When no tool calls are active, any lingering electrons are already in shell 1 (resting) and will fade naturally. A completely idle agent has no electrons.

### Photon Emission

On electron shell-drop (`tool_end`), a radial burst of particles emits outward from the shell-drop position. This reuses the existing `ActivityParticle` system with these parameters:

- Count: 3 + floor(durationMs / 1000), capped at 12. Longer tool calls = bigger burst.
- Color: same `toolColor(toolName)` function as existing mode.
- Velocity: outward from nucleus center, not random. Magnitude 1.5 + random * 1.0.
- Max life: 1.8 seconds.
- The burst origin is the electron's current shell position, not the nucleus center.

This reuses the existing particle infrastructure unchanged.

### Photon Exchange (Messages)

Mail message arcs are unchanged mechanically (same Bezier arc, same packet sphere). Visual adjustments for atomic mode:

- Packet color: white (0xffffff) regardless of message type. Type color is shown on the arc line instead.
- Arc line color: `msgTypeColor(msg.type)` at opacity 0.4 (slightly more visible than space mode's 0.25).
- Packet size: 0.10 (slightly smaller than current 0.13 to suit the tighter atomic aesthetic).

### Excited State Glow

The nucleus bloom intensity increases with the number of electrons in outer shells (shells 2 and 3). This is implemented by adjusting the nucleus material's emissive color (or simply its brightness, since `MeshBasicMaterial` does not have an emissive property).

Approach: maintain a per-atom `excitationLevel` (0.0 to 1.0) computed as `min(1.0, electronsInOuterShells / 3)`. On each frame, lerp the nucleus material color toward a brighter version of its base color: `baseColor.clone().lerp(new THREE.Color(1,1,1), excitationLevel * 0.4)`. When excitation drops to 0, color returns to base.

This makes the bloom pass naturally produce stronger glow on excited atoms without needing per-object bloom control (which Three.js's UnrealBloomPass does not support at the object level).

### Atomic Weight (Nucleus Scaling)

Nucleus radius = `CAPABILITY_RADIUS[capability] * tokenScale`.

`tokenScale` is updated whenever a `token_snapshot` arrives:

```
tokenScale = 1.0 + 0.3 * saturate(cumulativeTokens / maxCumulativeAcrossSwarm)
```

Where `saturate(x)` = `Math.min(1, Math.max(0, x))`.

The scale change animates over 2 seconds using a lerp in the frame loop, so nucleus growth is gradual and readable. The cloud radius and shell radii are derived from nucleus radius and update automatically.

### Bond Lines

Parent-child edges use the same `THREE.Line` infrastructure as the current mode. In atomic mode:

- Line color: 0x2a5a8a (slightly warmer blue than space mode's 0x1a4a6a).
- Opacity: 0.5.
- Line width: 1 (unchanged; Three.js WebGL line width is always 1 on most platforms).

No dashed-line treatment; simplicity is preferred.

### Background and Bloom

In atomic mode:

- Background color: 0x010306 (slightly darker, cooler than space mode's 0x020408).
- Bloom pass parameters: strength 0.5 (vs 0.6), radius 0.5 (vs 0.7), threshold 0.3 (unchanged). Tighter bloom suits the atom geometry.

The starfield is hidden in atomic mode (the random scattered points are semantically inconsistent and visually noisy with point-cloud electron clouds present).

---

## Implementation Plan

### Phase 1: Token pulse (no new geometry)

Make existing space-mode orbs "breathe" based on token rate. No new server changes yet.

- Add `tokenRates: Map<string, number>` to `scene.ts`.
- In `animatePulse()`, blend the pulse amplitude with `tokenRates.get(agentName) ?? 0`. High token rate = larger pulse scale range (e.g., 1.0 + 0.18 rather than 0.12).
- Expose `updateTokenRates(rates: TokenRateSnapshot[])` on the `SceneController` interface.
- Add `token_snapshot` WebSocket message type to `shared/types.ts` and wire it in `main.ts`.
- Server: compute token deltas in `computeUpdates()` and emit `token_snapshot` as a new `ServerMessage` type.

Verification: open the viz during a live swarm and observe orbs breathing faster for active agents.

### Phase 2: Tool completion flash (both modes)

Stream `tool_end` events so completions trigger a visual response.

- Update `stmtNewEvents` filter in `server/index.ts` to include `tool_end`.
- Add `durationMs` to `ToolEventData` in `shared/types.ts`.
- Update `server/mappers.ts` to populate `durationMs` from `OvrstoryEvent.toolDurationMs`.
- In `main.ts` `tool_event` handler, distinguish `tool_start` vs `tool_end`. On `tool_end`, call a new `emitToolCompletion(agentName, toolName, durationMs)` method.
- In `scene.ts`, implement `emitToolCompletion`: burst of particles sized by duration, direction outward from the orb.

Verification: trigger a tool completion in a live swarm and see the flash. Confirm `durationMs` propagates correctly.

### Phase 3: Atomic renderer

Create `client/atomic-scene.ts` exporting `createAtomicScene(canvas: HTMLCanvasElement): SceneController`.

The atomic scene implements the same `SceneController` interface as `scene.ts`:

```typescript
export interface SceneController {
  applySnapshot(snapshot: StateSnapshot): void;
  addMessage(msg: AgentMessage): void;
  emitActivityParticle(agentName: string, toolName: string | null): void;
  emitToolCompletion(agentName: string, toolName: string | null, durationMs: number | null): void;
  updateTokenRates(rates: TokenRateSnapshot[]): void;
  setLabelsVisible(visible: boolean): void;
  setMsgLabelsVisible(visible: boolean): void;
  setClusteringEnabled(enabled: boolean): void;
  dispose(): void;
}
```

The atomic scene creates and manages:

- `AtomState` (analogous to `NodeState`): nucleus mesh, electron cloud Points object, shell tori, active electrons array, `tokenScale`, `excitationLevel`.
- `ElectronState`: position (on a shell), angle, angular speed, `shellIndex` (1-3), `absorbing` flag, matched `toolName` for pairing with `tool_end`.

The toggle in `main.ts`:

```typescript
let vizMode: 'space' | 'atomic' = 'space';
let activeScene: SceneController = spaceScene;

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'a') {
    const snapshot = getCurrentSnapshot();
    activeScene.dispose();
    vizMode = vizMode === 'space' ? 'atomic' : 'space';
    activeScene = vizMode === 'space'
      ? createScene(canvas)
      : createAtomicScene(canvas);
    activeScene.applySnapshot(snapshot);
    // Re-apply current toggle states
    activeScene.setLabelsVisible(toggles.labels);
    activeScene.setClusteringEnabled(toggles.clustering);
    updateToggles();
  }
});
```

The `dispose()` call on the outgoing scene cleans up its renderer, composer, geometry, and labels. The incoming scene initializes fresh from the current snapshot. No transition animation in phase 3 (instant swap).

Shared: camera position is NOT shared between scenes because each scene owns its own renderer and composer. Both scenes start at `camera.position.set(0, 0, 22)`.

### Phase 4: Polish

- Nucleus scale animation (lerp toward `tokenScale` over 2 seconds).
- Shell brightening when electrons occupy them.
- Electron cloud geometry update throttling (rebuild at most once per 500ms).
- Bond line styling (color and opacity adjustments for atomic mode).
- Background color change to 0x010306.
- Bloom parameter adjustment (strength 0.5, radius 0.5).
- Starfield hide/show on mode toggle.
- HUD: add `[A] mode ●/○` to the toggles display.
- Adjust `CAPABILITY_RADIUS` multipliers if needed now that nucleus also scales with tokens (ensure even a zero-token coordinator is visibly larger than a builder).

---

## Open Questions

1. **Bloom settings**: should atomic mode use tighter, cooler-toned bloom (proposal: strength 0.5, radius 0.5) or keep space-mode settings? The cooler tone would reinforce the physics aesthetic but may look less dramatic with sparse swarms.

2. **Background**: proposal is 0x010306 (very slightly cooler and darker than space mode's 0x020408). Should there be a more distinct visual shift, e.g., a subtle dark-blue gradient or a faint radial vignette?

3. **Mode transition**: phase 3 uses an instant swap (dispose old scene, create new one from current snapshot). An alternative is a 0.5-second cross-fade using a second canvas layer at lower opacity. Worth the complexity?

4. **Electron pairing**: `tool_end` events are matched to in-flight electrons by `(agentName, toolName)`. When an agent runs the same tool concurrently (e.g., two parallel `Bash` calls), the first matching electron is selected. Is this acceptable, or should overstory's event IDs be surfaced to allow exact pairing?

5. **Cloud rebuild cost**: rebuilding `THREE.Points` geometry for a large swarm (100+ agents) at 500ms intervals could be measurable. Is the visual benefit of adaptive cloud density worth profiling, or should the cloud be a fixed-point-count object that only adjusts individual point positions?
