import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import {
	CSS2DObject,
	CSS2DRenderer,
} from "three/addons/renderers/CSS2DRenderer.js";
import type {
	Agent,
	AgentCapability,
	AgentMessage,
	AgentState,
	MergeQueueEntry,
	StateSnapshot,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface NodeState {
	mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
	/** Soft-body layout position used by the force simulation */
	lx: number;
	ly: number;
	vx: number;
	vy: number;
	agentName: string;
	parentAgent: string | null;
	beadId: string | null;
	state: AgentState;
	/** Unique phase offset for pulse animation */
	phase: number;
	/** Spawn animation: scale from 0 → 1 over 0.5s */
	spawnT: number;
	/** Completion fadeout: opacity from 1 → 0 over 2s (only when completed) */
	fadeT: number;
	completing: boolean;
	label: CSS2DObject;
}

interface EdgeState {
	line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
	positions: Float32Array;
	fromName: string;
	toName: string;
}

interface FlightState {
	packet: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
	arcLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
	curve: THREE.QuadraticBezierCurve3;
	/** Progress along the arc, 0 → 1 */
	t: number;
	msgLabel: CSS2DObject;
}

interface DiamondState {
	mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
	branchName: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SceneController {
	applySnapshot(snapshot: StateSnapshot): void;
	addMessage(msg: AgentMessage): void;
	setLabelsVisible(visible: boolean): void;
	setMsgLabelsVisible(visible: boolean): void;
	setClusteringEnabled(enabled: boolean): void;
	dispose(): void;
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

const STATE_COLORS: Record<AgentState, number> = {
	working: 0x00ff88,
	booting: 0xffcc00,
	completed: 0x4488ff,
	stalled: 0xff8800,
	zombie: 0xff0000,
};

function stateColor(state: AgentState): THREE.Color {
	return new THREE.Color(STATE_COLORS[state]);
}

const CAPABILITY_RADIUS: Record<AgentCapability, number> = {
	coordinator: 0.6,
	lead: 0.45,
	scout: 0.3,
	builder: 0.3,
	reviewer: 0.3,
	merger: 0.3,
};

const MSG_TYPE_COLORS: Record<string, number> = {
	dispatch: 0x00ccff,
	status: 0x4488ff,
	result: 0x00ff88,
	worker_done: 0x00ff88,
	error: 0xff3333,
	merge_ready: 0xff6600,
	question: 0xcc66ff,
};

function msgTypeColor(type: string): number {
	return MSG_TYPE_COLORS[type] ?? 0x666666;
}

const MERGE_STATUS_COLORS: Record<string, number> = {
	pending: 0xffffff,
	merging: 0xffcc00,
	merged: 0x00ff88,
	conflict: 0xff0000,
	failed: 0x882222,
};

// ---------------------------------------------------------------------------
// Cluster color helper: hash beadId → hue for visual grouping tint
// ---------------------------------------------------------------------------

function beadGroupColor(beadId: string): THREE.Color {
	let h = 0;
	for (let i = 0; i < beadId.length; i++) {
		h = ((h << 5) - h + beadId.charCodeAt(i)) | 0;
	}
	const hue = (Math.abs(h) % 360) / 360;
	return new THREE.Color().setHSL(hue, 0.7, 0.55);
}

function effectiveNodeColor(
	state: AgentState,
	beadId: string | null,
	withCluster: boolean,
): THREE.Color {
	const base = stateColor(state);
	if (withCluster && beadId) {
		return base.clone().lerp(beadGroupColor(beadId), 0.3);
	}
	return base;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScene(canvas: HTMLCanvasElement): SceneController {
	// -------------------------------------------------------------------------
	// Renderer
	// -------------------------------------------------------------------------
	const renderer = new THREE.WebGLRenderer({
		canvas,
		antialias: true,
		alpha: false,
	});
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.toneMapping = THREE.NoToneMapping;

	// -------------------------------------------------------------------------
	// CSS2D overlay renderer (text labels)
	// -------------------------------------------------------------------------
	const labelRenderer = new CSS2DRenderer();
	labelRenderer.setSize(window.innerWidth, window.innerHeight);
	const labelEl = labelRenderer.domElement;
	labelEl.style.position = "absolute";
	labelEl.style.top = "0";
	labelEl.style.left = "0";
	labelEl.style.width = "100%";
	labelEl.style.height = "100%";
	labelEl.style.pointerEvents = "none";
	labelEl.style.zIndex = "1";
	document.body.appendChild(labelEl);

	// -------------------------------------------------------------------------
	// Scene + camera
	// -------------------------------------------------------------------------
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x020408);

	const camera = new THREE.PerspectiveCamera(
		55,
		window.innerWidth / window.innerHeight,
		0.1,
		500,
	);
	camera.position.set(0, 0, 22);
	camera.lookAt(0, 0, 0);

	// Dim ambient to let emissive/bloom carry the look
	scene.add(new THREE.AmbientLight(0x08101a, 1.0));

	// -------------------------------------------------------------------------
	// Background starfield (static, created once)
	// -------------------------------------------------------------------------
	(function addStarfield() {
		const count = 600;
		const positions = new Float32Array(count * 3);
		for (let i = 0; i < count; i++) {
			positions[i * 3] = (Math.random() - 0.5) * 80;
			positions[i * 3 + 1] = (Math.random() - 0.5) * 80;
			positions[i * 3 + 2] = (Math.random() - 0.5) * 30 - 5;
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		const mat = new THREE.PointsMaterial({
			color: 0x334455,
			size: 0.08,
			sizeAttenuation: true,
		});
		scene.add(new THREE.Points(geo, mat));
	})();

	// -------------------------------------------------------------------------
	// Post-processing: bloom + output
	// -------------------------------------------------------------------------
	const composer = new EffectComposer(renderer);
	composer.addPass(new RenderPass(scene, camera));

	const bloomPass = new UnrealBloomPass(
		new THREE.Vector2(window.innerWidth, window.innerHeight),
		0.8, // strength
		0.4, // radius
		0.3, // threshold — most emissive colours will bloom
	);
	composer.addPass(bloomPass);
	composer.addPass(new OutputPass());

	// -------------------------------------------------------------------------
	// Node, edge, flight, and diamond maps
	// -------------------------------------------------------------------------
	const nodes = new Map<string, NodeState>();
	const edges = new Map<string, EdgeState>(); // key: `${parentName}-${childName}`
	const flights = new Map<string, FlightState>(); // key: AgentMessage.id
	const diamonds = new Map<string, DiamondState>(); // key: branchName

	// Track all message IDs that have ever been launched to prevent re-flight
	const flownMessages = new Set<string>();

	// Track agents that have fully faded out to prevent re-adding from stale snapshots
	const completedRemoved = new Set<string>();

	// -------------------------------------------------------------------------
	// Toggle state (all off by default)
	// -------------------------------------------------------------------------
	let labelsVisible = false;
	let msgLabelsVisible = false;
	let clusteringEnabled = false;

	// -------------------------------------------------------------------------
	// Label helpers
	// -------------------------------------------------------------------------
	function createNodeLabelObj(agent: Agent): CSS2DObject {
		const el = document.createElement("div");
		el.className = "node-label";
		el.textContent = agent.name;
		const obj = new CSS2DObject(el);
		// Position below the node sphere
		const r = CAPABILITY_RADIUS[agent.capability] ?? 0.3;
		obj.position.set(0, -(r + 0.25), 0);
		return obj;
	}

	function createMsgLabelObj(type: string): CSS2DObject {
		const el = document.createElement("div");
		el.className = "msg-label";
		el.textContent = type;
		const obj = new CSS2DObject(el);
		// Position slightly above the packet sphere
		obj.position.set(0, 0.22, 0);
		return obj;
	}

	// -------------------------------------------------------------------------
	// Node management
	// -------------------------------------------------------------------------
	function addNode(agent: Agent): void {
		const radius = CAPABILITY_RADIUS[agent.capability] ?? 0.3;
		const geo = new THREE.SphereGeometry(radius, 16, 12);
		const mat = new THREE.MeshBasicMaterial({
			color: effectiveNodeColor(agent.state, agent.beadId, clusteringEnabled),
		});
		const mesh = new THREE.Mesh(geo, mat);

		// Scatter near origin; force sim will arrange them
		const angle = Math.random() * Math.PI * 2;
		const r = 1 + Math.random() * 3;
		mesh.position.set(Math.cos(angle) * r, Math.sin(angle) * r, 0);
		// Start at scale 0 for spawn animation
		mesh.scale.setScalar(0);

		const label = createNodeLabelObj(agent);
		label.visible = labelsVisible;
		mesh.add(label);
		scene.add(mesh);

		nodes.set(agent.name, {
			mesh,
			lx: mesh.position.x,
			ly: mesh.position.y,
			vx: 0,
			vy: 0,
			agentName: agent.name,
			parentAgent: agent.parentAgent,
			beadId: agent.beadId,
			state: agent.state,
			phase: Math.random() * Math.PI * 2,
			spawnT: 0,
			fadeT: 0,
			completing: false,
			label,
		});
	}

	function updateNode(agent: Agent): void {
		const node = nodes.get(agent.name);
		if (!node) {
			// If this agent already faded out, skip re-adding unless it restarted
			if (completedRemoved.has(agent.name)) {
				if (agent.state === "completed") return;
				// Agent restarted with a non-completed state — allow re-add
				completedRemoved.delete(agent.name);
			}
			addNode(agent);
			return;
		}
		node.state = agent.state;
		node.parentAgent = agent.parentAgent;
		node.beadId = agent.beadId;
		node.mesh.material.color.set(
			effectiveNodeColor(agent.state, agent.beadId, clusteringEnabled),
		);
		node.label.element.textContent = agent.name;

		// Trigger completion fadeout
		if (agent.state === "completed" && !node.completing) {
			node.completing = true;
			node.fadeT = 0;
			node.label.visible = false; // hide label as orb fades out
		}
	}

	function removeNode(name: string): void {
		const node = nodes.get(name);
		if (!node) return;
		node.label.removeFromParent();
		node.label.element.remove();
		scene.remove(node.mesh);
		node.mesh.geometry.dispose();
		node.mesh.material.dispose();
		nodes.delete(name);
	}

	// -------------------------------------------------------------------------
	// Edge management (parent → child connection lines)
	// -------------------------------------------------------------------------
	function buildEdges(agents: Agent[]): void {
		// Clear existing
		for (const e of edges.values()) {
			scene.remove(e.line);
			e.line.geometry.dispose();
			e.line.material.dispose();
		}
		edges.clear();

		for (const agent of agents) {
			if (!agent.parentAgent) continue;
			if (!nodes.has(agent.parentAgent) || !nodes.has(agent.name)) continue;
			const key = `${agent.parentAgent}-${agent.name}`;
			const positions = new Float32Array(6);
			const geo = new THREE.BufferGeometry();
			geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
			const mat = new THREE.LineBasicMaterial({
				color: 0x1a4a6a,
				transparent: true,
				opacity: 0.6,
			});
			const line = new THREE.Line(geo, mat);
			scene.add(line);
			edges.set(key, {
				line,
				positions,
				fromName: agent.parentAgent,
				toName: agent.name,
			});
		}
	}

	function updateEdgePositions(): void {
		for (const e of edges.values()) {
			const from = nodes.get(e.fromName);
			const to = nodes.get(e.toName);
			if (!from || !to) continue;
			e.positions[0] = from.mesh.position.x;
			e.positions[1] = from.mesh.position.y;
			e.positions[2] = 0;
			e.positions[3] = to.mesh.position.x;
			e.positions[4] = to.mesh.position.y;
			e.positions[5] = 0;
			const attr = e.line.geometry.getAttribute(
				"position",
			) as THREE.BufferAttribute;
			attr.needsUpdate = true;
		}
	}

	// -------------------------------------------------------------------------
	// Merge queue diamonds
	// -------------------------------------------------------------------------
	function buildDiamondGeometry(): THREE.BufferGeometry {
		const geo = new THREE.BufferGeometry();
		const s = 0.18;
		const verts = new Float32Array([0, s, 0, -s, 0, 0, 0, -s, 0, s, 0, 0]);
		const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
		geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
		geo.setIndex(new THREE.BufferAttribute(idx, 1));
		return geo;
	}

	function syncDiamonds(entries: MergeQueueEntry[]): void {
		// Remove diamonds no longer in queue
		const activeBranches = new Set(entries.map((e) => e.branchName));
		for (const [branch, d] of diamonds) {
			if (!activeBranches.has(branch)) {
				scene.remove(d.mesh);
				d.mesh.geometry.dispose();
				d.mesh.material.dispose();
				diamonds.delete(branch);
			}
		}

		// Add/update
		entries.forEach((entry, i) => {
			const color = MERGE_STATUS_COLORS[entry.status] ?? 0xffffff;
			const x = (i - (entries.length - 1) / 2) * 0.6;
			const y = -8;

			const existing = diamonds.get(entry.branchName);
			if (existing) {
				existing.mesh.material.color.setHex(color);
				existing.mesh.position.set(x, y, 0.2);
			} else {
				const geo = buildDiamondGeometry();
				const mat = new THREE.MeshBasicMaterial({
					color,
					side: THREE.DoubleSide,
				});
				const mesh = new THREE.Mesh(geo, mat);
				mesh.position.set(x, y, 0.2);
				scene.add(mesh);
				diamonds.set(entry.branchName, { mesh, branchName: entry.branchName });
			}
		});
	}

	// -------------------------------------------------------------------------
	// Force-directed layout
	// -------------------------------------------------------------------------
	function stepForces(dt: number): void {
		const list = [...nodes.values()];

		for (let i = 0; i < list.length; i++) {
			const ni = list[i];
			if (!ni) continue;

			// Repulsion from every other node
			for (let j = i + 1; j < list.length; j++) {
				const nj = list[j];
				if (!nj) continue;

				const dx = ni.lx - nj.lx;
				const dy = ni.ly - nj.ly;
				const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
				const force = 20 / (dist * dist);
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;

				ni.vx += fx * dt;
				ni.vy += fy * dt;
				nj.vx -= fx * dt;
				nj.vy -= fy * dt;

				// Clustering: extra spring attraction for same-beadId nodes
				if (
					clusteringEnabled &&
					ni.beadId !== null &&
					ni.beadId === nj.beadId
				) {
					const restCluster = 2.5;
					const excess = dist - restCluster;
					if (excess > 0) {
						const clusterSpring = 3.0 * excess;
						// Pull ni toward nj (dx is ni - nj, so negate for attraction)
						const cfx = (-dx / dist) * clusterSpring;
						const cfy = (-dy / dist) * clusterSpring;
						ni.vx += cfx * dt;
						ni.vy += cfy * dt;
						nj.vx -= cfx * dt;
						nj.vy -= cfy * dt;
					}
				}
			}

			// Spring attraction to parent
			if (ni.parentAgent) {
				const parent = nodes.get(ni.parentAgent);
				if (parent) {
					const dx = parent.lx - ni.lx;
					const dy = parent.ly - ni.ly;
					const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
					const rest = 6.0;
					const spring = 2.0 * (dist - rest);
					ni.vx += (dx / dist) * spring * dt;
					ni.vy += (dy / dist) * spring * dt;
				}
			}

			// Gentle pull toward origin (prevents drift)
			ni.vx -= ni.lx * 0.4 * dt;
			ni.vy -= ni.ly * 0.4 * dt;

			// Damping
			const damp = Math.exp(-3 * dt);
			ni.vx *= damp;
			ni.vy *= damp;

			// Integrate
			ni.lx += ni.vx * dt;
			ni.ly += ni.vy * dt;

			// Lerp mesh toward layout position
			const lerpK = Math.min(1, 5 * dt);
			ni.mesh.position.x += (ni.lx - ni.mesh.position.x) * lerpK;
			ni.mesh.position.y += (ni.ly - ni.mesh.position.y) * lerpK;
		}
	}

	// -------------------------------------------------------------------------
	// Spawn animation (scale 0 → 1, ease-out, over 0.5s)
	// -------------------------------------------------------------------------
	function animateSpawn(dt: number): void {
		for (const node of nodes.values()) {
			if (node.spawnT < 1) {
				node.spawnT = Math.min(1, node.spawnT + dt / 0.5);
				// ease-out: 1 - (1-t)^2
				const scale = 1 - (1 - node.spawnT) ** 2;
				if (!node.completing) {
					node.mesh.scale.setScalar(scale);
				}
			}
		}
	}

	// -------------------------------------------------------------------------
	// Completion fadeout (opacity 1 → 0 over 2s, then remove)
	// -------------------------------------------------------------------------
	const completedToRemove: string[] = [];

	function animateCompletions(dt: number): void {
		completedToRemove.length = 0;
		for (const [name, node] of nodes) {
			if (!node.completing) continue;
			node.fadeT = Math.min(1, node.fadeT + dt / 2.0);
			const opacity = 1 - node.fadeT;
			node.mesh.material.transparent = true;
			node.mesh.material.opacity = opacity;
			// Also shrink slightly as it fades
			const scale = 1 - node.fadeT * 0.3;
			node.mesh.scale.setScalar(scale);
			if (node.fadeT >= 1) {
				completedToRemove.push(name);
			}
		}
		for (const name of completedToRemove) {
			completedRemoved.add(name);
			removeNode(name);
		}
	}

	// -------------------------------------------------------------------------
	// Pulse / breathe animation for working nodes
	// -------------------------------------------------------------------------
	function animatePulse(t: number): void {
		for (const node of nodes.values()) {
			if (node.completing) continue;
			if (node.spawnT < 1) continue;

			if (node.state === "working") {
				const scale = 1 + 0.12 * Math.sin(t * 2.8 + node.phase);
				node.mesh.scale.setScalar(scale);
			} else {
				const s = node.mesh.scale.x;
				if (Math.abs(s - 1) > 0.001) {
					node.mesh.scale.setScalar(s + (1 - s) * 0.1);
				}
			}
		}
	}

	// -------------------------------------------------------------------------
	// Message flight (particle arc)
	// -------------------------------------------------------------------------
	function startFlight(msg: AgentMessage): void {
		// Guard: skip if already in-flight or already completed
		if (flights.has(msg.id) || flownMessages.has(msg.id)) return;
		flownMessages.add(msg.id);

		const fromNode = nodes.get(msg.from);
		const toNode = nodes.get(msg.to);

		const start = fromNode
			? fromNode.mesh.position.clone()
			: new THREE.Vector3(
					(Math.random() - 0.5) * 8,
					(Math.random() - 0.5) * 8,
					0,
				);
		const end = toNode
			? toNode.mesh.position.clone()
			: new THREE.Vector3(
					(Math.random() - 0.5) * 8,
					(Math.random() - 0.5) * 8,
					0,
				);

		// Arc control point: perpendicular offset from midpoint
		const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
		const chord = new THREE.Vector3().subVectors(end, start);
		const perp = new THREE.Vector3(-chord.y, chord.x, 0).normalize();
		const arcH = Math.max(chord.length() * 0.35, 1.0);
		const control = mid.clone().addScaledVector(perp, arcH);
		control.z = 0.5;

		const curve = new THREE.QuadraticBezierCurve3(start, control, end);

		// Dim arc line showing trajectory
		const arcPoints = curve.getPoints(40);
		const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPoints);
		const arcMat = new THREE.LineBasicMaterial({
			color: 0x004466,
			transparent: true,
			opacity: 0.25,
		});
		const arcLine = new THREE.Line(arcGeo, arcMat);
		scene.add(arcLine);

		// Bright packet sphere — colored by message type
		const pkGeo = new THREE.SphereGeometry(0.13, 8, 6);
		const pkMat = new THREE.MeshBasicMaterial({
			color: msgTypeColor(msg.type),
		});
		const packet = new THREE.Mesh(pkGeo, pkMat);
		const p0 = curve.getPoint(0);
		packet.position.copy(p0);
		packet.position.z = 0.6;
		scene.add(packet);

		// Message type label — attached to packet, follows it automatically
		const msgLabel = createMsgLabelObj(msg.type);
		msgLabel.visible = msgLabelsVisible;
		packet.add(msgLabel);

		flights.set(msg.id, { packet, arcLine, curve, t: 0, msgLabel });
	}

	function stepFlights(dt: number): void {
		const done: string[] = [];

		for (const [id, flight] of flights) {
			flight.t += dt * 0.55; // full arc in ~1.8 s

			if (flight.t >= 1.0) {
				flight.msgLabel.removeFromParent();
				flight.msgLabel.element.remove();
				scene.remove(flight.packet);
				scene.remove(flight.arcLine);
				flight.packet.geometry.dispose();
				flight.packet.material.dispose();
				flight.arcLine.geometry.dispose();
				flight.arcLine.material.dispose();
				done.push(id);
				continue;
			}

			// Move packet
			const pos = flight.curve.getPoint(flight.t);
			flight.packet.position.copy(pos);
			flight.packet.position.z = 0.6;

			// Fade arc as packet nears destination
			flight.arcLine.material.opacity = 0.25 * (1 - flight.t);
		}

		for (const id of done) flights.delete(id);
	}

	// -------------------------------------------------------------------------
	// Animation loop
	// -------------------------------------------------------------------------
	let animId = 0;
	let lastMs = 0;

	function animate(ms: number): void {
		animId = requestAnimationFrame(animate);
		const dt = Math.min((ms - lastMs) / 1000, 0.1);
		lastMs = ms;

		if (dt > 0) {
			stepForces(dt);
			stepFlights(dt);
			updateEdgePositions();
			animateSpawn(dt);
			animateCompletions(dt);
			animatePulse(ms / 1000);
		}

		composer.render();
		labelRenderer.render(scene, camera);
	}

	animId = requestAnimationFrame(animate);

	// -------------------------------------------------------------------------
	// Resize handling
	// -------------------------------------------------------------------------
	function onResize(): void {
		const w = window.innerWidth;
		const h = window.innerHeight;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setSize(w, h);
		composer.setSize(w, h);
		bloomPass.setSize(w, h);
		labelRenderer.setSize(w, h);
	}

	window.addEventListener("resize", onResize);

	// -------------------------------------------------------------------------
	// Public controller
	// -------------------------------------------------------------------------
	return {
		applySnapshot(snapshot: StateSnapshot): void {
			// Remove stale nodes
			const live = new Set(snapshot.agents.map((a) => a.name));
			for (const name of nodes.keys()) {
				if (!live.has(name)) removeNode(name);
			}
			// Prune completedRemoved for agents no longer in snapshot (allows future reuse)
			for (const name of completedRemoved) {
				if (!live.has(name)) completedRemoved.delete(name);
			}

			// Add / update
			for (const agent of snapshot.agents) {
				updateNode(agent);
			}

			// Rebuild edges to reflect current hierarchy
			buildEdges(snapshot.agents);

			// Start flights for messages not already in-flight or already flown
			for (const msg of snapshot.messages) {
				startFlight(msg);
			}

			// Sync merge queue diamonds
			syncDiamonds(snapshot.mergeQueue);
		},

		addMessage(msg: AgentMessage): void {
			startFlight(msg);
		},

		setLabelsVisible(visible: boolean): void {
			labelsVisible = visible;
			for (const node of nodes.values()) {
				node.label.visible = visible;
			}
		},

		setMsgLabelsVisible(visible: boolean): void {
			msgLabelsVisible = visible;
			for (const flight of flights.values()) {
				flight.msgLabel.visible = visible;
			}
		},

		setClusteringEnabled(enabled: boolean): void {
			clusteringEnabled = enabled;
			// Refresh all node colors to apply/remove cluster tint
			for (const node of nodes.values()) {
				node.mesh.material.color.set(
					effectiveNodeColor(node.state, node.beadId, enabled),
				);
			}
		},

		dispose(): void {
			cancelAnimationFrame(animId);
			window.removeEventListener("resize", onResize);

			for (const name of [...nodes.keys()]) removeNode(name);

			for (const e of edges.values()) {
				scene.remove(e.line);
				e.line.geometry.dispose();
				e.line.material.dispose();
			}
			edges.clear();

			for (const f of flights.values()) {
				f.msgLabel.removeFromParent();
				f.msgLabel.element.remove();
				scene.remove(f.packet);
				scene.remove(f.arcLine);
				f.packet.geometry.dispose();
				f.packet.material.dispose();
				f.arcLine.geometry.dispose();
				f.arcLine.material.dispose();
			}
			flights.clear();
			flownMessages.clear();
			completedRemoved.clear();

			for (const d of diamonds.values()) {
				scene.remove(d.mesh);
				d.mesh.geometry.dispose();
				d.mesh.material.dispose();
			}
			diamonds.clear();

			composer.dispose();
			renderer.dispose();
			if (document.body.contains(labelEl)) {
				document.body.removeChild(labelEl);
			}
		},
	};
}
