// Custom Node.js server: HTTP (SvelteKit app) + WebSocket (ws package).
// Run AFTER building: npm run build && node server.js
// ESM syntax required because package.json has "type": "module".

import { createServer } from 'http';
import { networkInterfaces } from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import { handler } from './build/handler.js';
import { initLED, sendToLED, sendIdleToLED } from './src/lib/server/led-controller.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0'; // 0.0.0.0 makes it reachable over LAN

// ─── Authoritative in-memory state ───────────────────────────────────────────
const state = {
	queues: {
		general: {
			rooms: {
				P1: {
					current: 0, // 0 = no number called this session
					ts: null, // epoch ms of last call
					history: [], // CalledMessage[], newest first, max 30 items
					calledNumbers: new Set() // all numbers called this session
				}
			}
		}
	}
};

// ─── Display client tracking ──────────────────────────────────────────────────
// Each display connection gets a sequential numeric ID so the staff UI can
// show a named list like "Màn hình #1", "Màn hình #2", etc.
let displayIdCounter = 0;
/** @type {Map<import('ws').WebSocket, { id: number, connectedAt: number }>} */
const displayClients = new Map();

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = createServer(handler);

// ─── WebSocket server (noServer mode, same port as HTTP) ─────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
	if (req.url === '/ws') {
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit('connection', ws, req);
		});
	} else {
		socket.destroy();
	}
});

// ─── Per-client metadata ──────────────────────────────────────────────────────
/** @type {Map<import('ws').WebSocket, { role: 'staff' | 'display' | null }>} */
const clients = new Map();

/** Broadcast a message to every open client. */
function broadcast(message) {
	const data = JSON.stringify(message);
	for (const [client] of clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(data);
		}
	}
}

/** Notify all connected staff clients that the display list changed. */
function broadcastDisplaysChanged() {
	const displays = [...displayClients.values()];
	const data = JSON.stringify({ type: 'DISPLAYS_CHANGED', displays });
	for (const [client, meta] of clients) {
		if (meta.role === 'staff' && client.readyState === WebSocket.OPEN) {
			client.send(data);
		}
	}
}

// ─── WebSocket connection handler ─────────────────────────────────────────────
wss.on('connection', (ws) => {
	clients.set(ws, { role: null });

	ws.on('message', (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid JSON' }));
			return;
		}

		switch (msg.type) {
			case 'HELLO': {
				const meta = clients.get(ws);
				if (meta) meta.role = msg.role ?? null;

				// Register display clients so staff can see them in the UI
				if (msg.role === 'display') {
					displayIdCounter++;
					displayClients.set(ws, { id: displayIdCounter, connectedAt: Date.now() });
					broadcastDisplaysChanged();
				}

				const queueId = msg.queueId ?? 'general';
				const room = msg.room ?? 'P1';
				const roomState = state.queues[queueId]?.rooms[room];

				if (!roomState) {
					ws.send(
						JSON.stringify({
							type: 'ERROR',
							message: `Unknown queue/room: ${queueId}/${room}`
						})
					);
					return;
				}

				// Send current state only to this newly connected client
				ws.send(
					JSON.stringify({
						type: 'STATE_SYNC',
						queueId,
						room,
						current: roomState.current,
						ts: roomState.ts,
						history: roomState.history,
						displays: [...displayClients.values()],
						calledNumbers: [...roomState.calledNumbers]
					})
				);
				break;
			}

			case 'CALL': {
				const { queueId, room, number } = msg;

				if (!Number.isInteger(number) || number < 1 || number > 99) {
					ws.send(
						JSON.stringify({
							type: 'ERROR',
							message: `Number must be an integer between 1 and 99, got: ${number}`
						})
					);
					return;
				}

				const roomState = state.queues[queueId]?.rooms[room];
				if (!roomState) {
					ws.send(
						JSON.stringify({
							type: 'ERROR',
							message: `Unknown queue/room: ${queueId}/${room}`
						})
					);
					return;
				}

				roomState.current = number;
				roomState.ts = Date.now();
				roomState.calledNumbers.add(number);

				const calledMsg = {
					type: 'CALLED',
					queueId,
					room,
					number,
					display: String(number).padStart(2, '0'),
					ts: roomState.ts
				};

				// Prepend to history ring buffer (newest first, max 30)
				roomState.history.unshift(calledMsg);
				if (roomState.history.length > 30) roomState.history.pop();

				broadcast(calledMsg);
				sendToLED({ number, counter: 1, address: 0 }); // fire-and-forget
				break;
			}

			case 'RECALL_LAST': {
				const roomState = state.queues['general']?.rooms['P1'];
				if (!roomState || roomState.current === 0) {
					ws.send(
						JSON.stringify({ type: 'ERROR', message: 'No number has been called yet' })
					);
					return;
				}

				// Fresh ts so display clients treat this as a new event (re-triggers $effect + speech)
				broadcast({
					type: 'CALLED',
					queueId: 'general',
					room: 'P1',
					number: roomState.current,
					display: String(roomState.current).padStart(2, '0'),
					ts: Date.now()
				});
				sendToLED({ number: roomState.current, counter: 1, address: 0 }); // fire-and-forget
				break;
			}

			case 'RESET': {
				const roomState = state.queues['general']?.rooms['P1'];
				if (roomState) {
					roomState.current = 0;
					roomState.ts = null;
					roomState.history = [];
					roomState.calledNumbers = new Set();
				}
				// Broadcast to all clients (staff + display) so every screen resets
				broadcast({ type: 'RESETTED' });
				sendIdleToLED({ address: 0 }); // resume idle scroll after reset
				break;
			}

			case 'SKIP': {
				const { queueId, room, number } = msg;
				if (!Number.isInteger(number) || number < 1 || number > 99) break;
				const roomState = state.queues[queueId]?.rooms[room];
				if (!roomState) break;
				roomState.calledNumbers.add(number);
				const skippedTs = Date.now();
				roomState.history.unshift({
					type: 'CALLED',
					queueId,
					room,
					number,
					display: String(number).padStart(2, '0'),
					ts: skippedTs,
					skipped: true
				});
				if (roomState.history.length > 30) roomState.history.pop();
				broadcast({ type: 'SKIPPED', queueId, room, number, ts: skippedTs });
				break;
			}

			default:
				ws.send(
					JSON.stringify({ type: 'ERROR', message: `Unknown message type: ${msg.type}` })
				);
		}
	});

	ws.on('close', () => {
		// If a display client disconnects, update the staff UI
		if (displayClients.has(ws)) {
			displayClients.delete(ws);
			broadcastDisplaysChanged();
		}
		clients.delete(ws);
	});

	ws.on('error', (err) => {
		console.error('[WS] Client error:', err.message);
		if (displayClients.has(ws)) {
			displayClients.delete(ws);
			broadcastDisplaysChanged();
		}
		clients.delete(ws);
	});
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
	const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;

	// Find the first non-loopback IPv4 address for LAN access hint
	const lanIP = Object.values(networkInterfaces())
		.flat()
		.find((iface) => iface && iface.family === 'IPv4' && !iface.internal)?.address;

	console.log(`\nGoiSoKhamBenh running on port ${PORT}`);
	console.log(`  Local:   http://${displayHost}:${PORT}`);
	if (lanIP) {
		console.log(`  LAN:     http://${lanIP}:${PORT}`);
	}
	console.log();
	initLED();
});
