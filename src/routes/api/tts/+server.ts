import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { Client } from '@gradio/client';
import { getCachedAudio, setCachedAudio } from '$lib/server/audio-cache.js';
import type { RequestHandler } from './$types';
interface GradioParam {
	parameter_name?: string;
	parameter_default?: string;
	python_type?: {
		type?: string;
	};
}

interface GradioEndpoint {
	parameters?: GradioParam[];
}

interface GradioApiInfo {
	named_endpoints?: Record<string, GradioEndpoint>;
}

interface FilePayload {
	url?: string;
	path?: string;
}

interface PredictResult {
	data?: Array<FilePayload | string | unknown>;
}

// Reuse client instance to avoid repeated connection latency
let clientInstance: Client | null = null;
let clientPromise: Promise<Client> | null = null;

async function getGradioClient(space: string, hfToken?: string): Promise<Client> {
	if (clientInstance) return clientInstance;
	if (clientPromise) return clientPromise;

	const connectOptions = hfToken
		? { token: hfToken as `hf_${string}`, hf_token: hfToken as `hf_${string}` }
		: undefined;
	clientPromise = Client.connect(space, connectOptions)
		.then((c) => {
			clientInstance = c;
			return c;
		})
		.catch((err: unknown) => {
			clientInstance = null;
			throw err;
		})
		.finally(() => {
			clientPromise = null;
		});

	return clientPromise;
}

function resolveEndpoint(api: GradioApiInfo, preferred?: string): string {
	if (preferred && api?.named_endpoints?.[preferred]) return preferred;
	const candidates = ['/generate', '/synthesize', '/predict'];
	for (const endpoint of candidates) {
		if (api?.named_endpoints?.[endpoint]) return endpoint;
	}
	const all = Object.keys(api?.named_endpoints ?? {});
	return preferred || all[0] || '/generate';
}

function resolveVoice(api: GradioApiInfo, endpoint: string, requestedVoice: string): string {
	const voiceParam = api?.named_endpoints?.[endpoint]?.parameters?.find(
		(p) => p.parameter_name === 'voice'
	);
	if (!voiceParam) return requestedVoice;

	const match = voiceParam.python_type?.type?.match(/Literal\[(.*)\]/);
	if (!match) return requestedVoice;

	const choices: string[] = match[1]
		.split(',')
		.map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''));
	if (choices.includes(requestedVoice)) return requestedVoice;

	const lower = requestedVoice.toLowerCase();
	if (lower.includes('male') && !lower.includes('female')) {
		if (choices.includes('hung_thinh')) return 'hung_thinh';
		if (choices.includes('manh_dung')) return 'manh_dung';
	}
	if (lower.includes('female') || lower.includes('nu')) {
		if (choices.includes('diem_trinh')) return 'diem_trinh';
		if (choices.includes('mai_linh')) return 'mai_linh';
	}

	return voiceParam.parameter_default || choices[0] || requestedVoice;
}

export const POST: RequestHandler = async ({ request }) => {
	const { text } = (await request.json()) as { text: string };
	if (!text?.trim()) error(400, 'text is required');

	const normalizedText = text.trim();

	// Return cached audio if already synthesized
	const cached = getCachedAudio(normalizedText);
	if (cached) {
		return new Response(cached.buffer.buffer as ArrayBuffer, {
			headers: { 'Content-Type': cached.contentType, 'Cache-Control': 'public, max-age=86400' }
		});
	}

	const space =
		process.env.KOKORO_TTS_SPACE || env.KOKORO_TTS_SPACE || 'hugging-apps/kokoro-vietnamese';
	const requestedVoice = process.env.KOKORO_TTS_VOICE || env.KOKORO_TTS_VOICE || 'diem_trinh';
	const speed = parseFloat(process.env.KOKORO_TTS_SPEED || env.KOKORO_TTS_SPEED || '1') || 1;
	const hfToken = process.env.HF_TOKEN || env.HF_TOKEN;
	const customEndpoint = process.env.KOKORO_TTS_ENDPOINT || env.KOKORO_TTS_ENDPOINT;

	try {
		const client = await getGradioClient(space, hfToken);
		const api = (await client.view_api()) as GradioApiInfo;
		const endpoint = resolveEndpoint(api, customEndpoint);
		const voice = resolveVoice(api, endpoint, requestedVoice);

		let result: PredictResult;
		try {
			result = (await client.predict(endpoint, {
				text: normalizedText,
				voice,
				speed
			})) as PredictResult;
		} catch {
			// Fallback to positional arguments if named parameters fail
			result = (await client.predict(endpoint, [normalizedText, voice, speed])) as PredictResult;
		}

		const fileData = result?.data?.[0];
		const fileUrl =
			typeof fileData === 'string'
				? fileData
				: typeof fileData === 'object' && fileData !== null && 'url' in fileData
					? (fileData as FilePayload).url
					: undefined;

		if (!fileUrl) {
			throw new Error('Kokoro TTS returned empty audio data');
		}

		const audioResp = await fetch(fileUrl);
		if (!audioResp.ok) {
			throw new Error(`Failed to download audio: HTTP ${audioResp.status}`);
		}
		const contentType = 'audio/wav';
		const arrayBuffer = await audioResp.arrayBuffer();
		const buffer = new Uint8Array(arrayBuffer);

		setCachedAudio(normalizedText, buffer, contentType);
		return new Response(buffer.buffer as ArrayBuffer, {
			headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' }
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[Kokoro TTS]', message);
		// Reset client instance on failure to ensure clean reconnection next time
		clientInstance = null;
		error(503, `Kokoro TTS error: ${message}`);
	}
};
