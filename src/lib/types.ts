// Shared WebSocket message protocol types used by both server.js (JSDoc) and client code.

export type ClientRole = 'staff' | 'display';

// ─── Client → Server ─────────────────────────────────────────────────────────

export interface HelloMessage {
	type: 'HELLO';
	role: ClientRole;
	queueId: string; // 'general'
	room: string; // 'P1'
}

export interface CallMessage {
	type: 'CALL';
	queueId: string;
	room: string;
	number: number; // integer 1–99
}

export interface RecallLastMessage {
	type: 'RECALL_LAST';
}

export interface ResetMessage {
	type: 'RESET';
}

// ─── Server → Client ─────────────────────────────────────────────────────────

export interface DisplayInfo {
	id: number; // server-assigned sequential ID (1, 2, 3…)
	connectedAt: number; // epoch ms
}

export interface StateSyncMessage {
	type: 'STATE_SYNC';
	queueId: string;
	room: string;
	current: number; // 0 = nothing called yet this session
	ts: number | null; // epoch ms of last call, null if never called
	history: CalledMessage[]; // last 30 calls, newest first
	displays: DisplayInfo[]; // currently connected display clients
	calledNumbers: number[]; // all numbers called this session (for next-number logic)
}

export interface CalledMessage {
	type: 'CALLED';
	queueId: string;
	room: string;
	number: number;
	display: string; // zero-padded: "01"–"99"
	ts: number; // epoch ms
}

export interface ErrorMessage {
	type: 'ERROR';
	message: string;
}

export interface DisplaysChangedMessage {
	type: 'DISPLAYS_CHANGED';
	displays: DisplayInfo[]; // full current list of connected display clients
}

export interface ResettedMessage {
	type: 'RESETTED';
}

// ─── Union types ──────────────────────────────────────────────────────────────

export type ClientToServerMessage = HelloMessage | CallMessage | RecallLastMessage | ResetMessage;
export type ServerToClientMessage =
	| StateSyncMessage
	| CalledMessage
	| ErrorMessage
	| DisplaysChangedMessage
	| ResettedMessage;
export type AnyMessage = ClientToServerMessage | ServerToClientMessage;
