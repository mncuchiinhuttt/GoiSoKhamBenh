import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface CachedAudio {
	buffer: Uint8Array;
	contentType: string;
}

const memoryCache = new Map<string, CachedAudio>();
const CACHE_DIR = join(process.cwd(), '.cache', 'audio');

function getCachePath(key: string): string {
	const hash = createHash('md5').update(key).digest('hex');
	return join(CACHE_DIR, `${hash}.wav`);
}

export function getCachedAudio(key: string): CachedAudio | null {
	const mem = memoryCache.get(key);
	if (mem) return mem;

	const filePath = getCachePath(key);
	if (existsSync(filePath)) {
		try {
			const fileBuffer = readFileSync(filePath);
			const uint8 = new Uint8Array(fileBuffer);
			const entry: CachedAudio = { buffer: uint8, contentType: 'audio/wav' };
			memoryCache.set(key, entry);
			return entry;
		} catch {
			return null;
		}
	}

	return null;
}

export function setCachedAudio(key: string, buffer: Uint8Array, contentType = 'audio/wav'): void {
	memoryCache.set(key, { buffer, contentType });
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		const filePath = getCachePath(key);
		writeFileSync(filePath, buffer);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn('[AudioCache] Failed to write persistent disk cache:', message);
	}
}
