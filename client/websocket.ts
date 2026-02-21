import type { ServerMessage } from "../shared/types.js";

export type MessageHandler = (msg: ServerMessage) => void;
export type StatusHandler = (connected: boolean) => void;

export interface SwarmWebSocket {
	close(): void;
}

export function createWebSocket(
	url: string,
	onMessage: MessageHandler,
	onStatusChange?: StatusHandler,
): SwarmWebSocket {
	let ws: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	function connect(): void {
		ws = new WebSocket(url);

		ws.addEventListener("open", () => {
			onStatusChange?.(true);
		});

		ws.addEventListener("message", (evt) => {
			try {
				const msg = JSON.parse(evt.data as string) as ServerMessage;
				if (msg.type === "update") {
					const u = (msg as any).data;
					if (u?.type === "tool_event") {
						console.log("[ws] tool_event received:", JSON.stringify(u.data));
					}
				}
				onMessage(msg);
			} catch (err) {
				console.error("[ws] parse error:", err);
			}
		});

		ws.addEventListener("close", () => {
			onStatusChange?.(false);
			if (!closed) {
				reconnectTimer = setTimeout(connect, 3000);
			}
		});

		ws.addEventListener("error", () => {
			ws?.close();
		});
	}

	connect();

	return {
		close(): void {
			closed = true;
			if (reconnectTimer !== null) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			ws?.close();
		},
	};
}
