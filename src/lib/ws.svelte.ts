// Svelte 5 rune-based WebSocket client.
// Instantiate once per page component (in <script>), not as a module singleton.
// Use onMount(() => ws.connect()) and onDestroy(() => ws.disconnect()).

import type {
	AnyMessage,
	CalledMessage,
	ClientRole,
	DisplayInfo,
	DisplaysChangedMessage,
	ResettedMessage,
	SkippedMessage,
	StateSyncMessage
} from './types.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export class WsClient {
	// ─── Reactive state (Svelte 5 class-field runes) ──────────────────────────
	status = $state<ConnectionStatus>('disconnected');
	lastCalled = $state<CalledMessage | null>(null);
	currentNumber = $state<number>(0);
	error = $state<string | null>(null);
	history = $state<CalledMessage[]>([]);
	displays = $state<DisplayInfo[]>([]);
	calledNumbers = $state<Set<number>>(new Set());

	// ─── Private fields ───────────────────────────────────────────────────────
	#ws: WebSocket | null = null;
	#role: ClientRole;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#reconnectAttempts = 0;
	#destroyed = false;

	constructor(role: ClientRole) {
		this.#role = role;
	}

	connect(): void {
		this.#destroyed = false;
		if (
			this.#ws &&
			(this.#ws.readyState === WebSocket.CONNECTING || this.#ws.readyState === WebSocket.OPEN)
		) {
			return;
		}

		// Derive WS URL from current page origin — works on any IP/port
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const url = `${protocol}//${location.host}/ws`;

		this.status = 'connecting';
		this.error = null;

		try {
			this.#ws = new WebSocket(url);
		} catch (e) {
			this.status = 'error';
			this.error = String(e);
			this.#scheduleReconnect();
			return;
		}

		this.#ws.onopen = () => {
			this.status = 'connected';
			this.#reconnectAttempts = 0;
			console.log(`[WsClient:${this.#role}] Connected to ${url}`);
			// Declare role → server replies with STATE_SYNC
			this.#send({ type: 'HELLO', role: this.#role, queueId: 'general', room: 'P1' });
		};

		this.#ws.onmessage = (event: MessageEvent) => {
			let msg: AnyMessage;
			try {
				msg = JSON.parse(event.data as string) as AnyMessage;
			} catch {
				console.error('[WsClient] Failed to parse message:', event.data);
				return;
			}
			const num = 'number' in msg && typeof msg.number === 'number' ? msg.number : '';
			console.log(`[WsClient:${this.#role}] Received:`, msg.type, num);
			this.#handleIncoming(msg);
		};

		this.#ws.onerror = (err) => {
			console.warn(`[WsClient:${this.#role}] Error event:`, err);
			this.status = 'error';
		};

		this.#ws.onclose = (ev) => {
			console.log(`[WsClient:${this.#role}] Closed (code=${ev.code}, reason=${ev.reason})`);
			this.status = 'disconnected';
			this.#ws = null;
			if (!this.#destroyed) {
				this.#scheduleReconnect();
			}
		};
	}

	disconnect(): void {
		this.#destroyed = true;
		this.#clearReconnectTimer();
		this.#ws?.close();
		this.#ws = null;
	}

	send(msg: AnyMessage): boolean {
		return this.#send(msg);
	}

	// ─── Private methods ──────────────────────────────────────────────────────

	#send(msg: AnyMessage): boolean {
		if (this.#ws?.readyState === WebSocket.OPEN) {
			this.#ws.send(JSON.stringify(msg));
			return true;
		}
		return false;
	}

	#handleIncoming(msg: AnyMessage): void {
		switch (msg.type) {
			case 'STATE_SYNC': {
				const sync = msg as StateSyncMessage;
				// Restore state but do NOT set lastCalled — prevents speech replay on reload
				this.currentNumber = sync.current;
				this.history = sync.history;
				this.displays = sync.displays;
				this.calledNumbers = new Set(sync.calledNumbers);
				break;
			}
			case 'CALLED': {
				const called = msg as CalledMessage;
				this.currentNumber = called.number;
				// Setting lastCalled triggers $effect in the display page → speech
				this.lastCalled = called;
				// Prepend to local history, keep max 30
				this.history = [called, ...this.history].slice(0, 30);
				this.calledNumbers = new Set([...this.calledNumbers, called.number]);
				break;
			}
			case 'DISPLAYS_CHANGED': {
				const changed = msg as DisplaysChangedMessage;
				this.displays = changed.displays;
				break;
			}
			case 'RESETTED': {
				// Server cleared all state — reset client to initial state
				this.currentNumber = 0;
				this.lastCalled = null;
				this.history = [];
				this.calledNumbers = new Set();
				break;
			}
			case 'SKIPPED': {
				const skipped = msg as SkippedMessage;
				this.calledNumbers = new Set([...this.calledNumbers, skipped.number]);
				const historyEntry: CalledMessage = {
					type: 'CALLED',
					queueId: skipped.queueId,
					room: skipped.room,
					number: skipped.number,
					display: String(skipped.number).padStart(2, '0'),
					ts: skipped.ts,
					skipped: true
				};
				this.history = [historyEntry, ...this.history].slice(0, 30);
				// Do NOT set lastCalled — skipped numbers must not trigger TTS
				break;
			}
			case 'ERROR': {
				this.error = msg.message;
				console.warn('[WsClient] Server error:', msg.message);
				break;
			}
		}
	}

	#scheduleReconnect(): void {
		this.#clearReconnectTimer();
		// Exponential backoff: 1s, 2s, 4s, 8s… capped at 30s
		const delay = Math.min(1000 * 2 ** this.#reconnectAttempts, 30_000);
		this.#reconnectAttempts++;
		this.#reconnectTimer = setTimeout(() => {
			if (!this.#destroyed) this.connect();
		}, delay);
	}

	#clearReconnectTimer(): void {
		if (this.#reconnectTimer !== null) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}
	}
}
