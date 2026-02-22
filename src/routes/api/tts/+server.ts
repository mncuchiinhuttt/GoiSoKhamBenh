import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

// Module-level cache: text → MP3 Buffer (persists for lifetime of Node process)
const cache = new Map<string, Buffer>();

export const POST: RequestHandler = async ({ request }) => {
	const apiKey = env.GOOGLE_TTS_API_KEY ?? '';
	if (!apiKey) error(503, 'GOOGLE_TTS_API_KEY not set');

	const { text } = (await request.json()) as { text: string };
	if (!text?.trim()) error(400, 'text is required');

	// Return cached audio if available
	if (cache.has(text)) {
		return new Response(cache.get(text)!, {
			headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' }
		});
	}

	const voice = env.GOOGLE_TTS_VOICE ?? 'vi-VN-Wavenet-A';
	const resp = await fetch(
		`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				input: { text },
				voice: { languageCode: 'vi-VN', name: voice },
				audioConfig: { audioEncoding: 'MP3', speakingRate: 0.9 }
			})
		}
	);

	if (!resp.ok) error(resp.status, `Google TTS: ${await resp.text()}`);

	const { audioContent } = (await resp.json()) as { audioContent: string };
	const buf = Buffer.from(audioContent, 'base64');
	cache.set(text, buf);

	return new Response(buf, {
		headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' }
	});
};
