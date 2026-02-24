<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { WsClient } from '$lib/ws.svelte.js';
	import type { CalledMessage } from '$lib/types.js';

	const ws = new WsClient('display');
	onMount(() => ws.connect());
	onDestroy(() => ws.disconnect());

	// ─── Audio state ──────────────────────────────────────────────────────────
	let audioEnabled = $state(false);

	// Plain variable (NOT $state) — tracks the last ts we announced.
	// Prevents replaying the current number when the user clicks "Bật loa"
	// while a number is already on screen.
	let lastAnnouncedTs: number | null = null;

	// Google TTS mode indicator
	let ttsMode = $state<'google' | 'browser' | 'unknown'>('unknown');
	// Last Google TTS error (for debugging)
	let ttsError = $state<string | null>(null);
	// Active Google TTS audio element — cancelled when a new number is called
	let currentAudio: HTMLAudioElement | null = null;

	// All voices available on this device/browser
	let allVoices = $state<SpeechSynthesisVoice[]>([]);
	// URI of the user-selected voice — persisted to localStorage
	let selectedVoiceURI = $state<string>(
		browser ? (localStorage.getItem('display-voice-uri') ?? '') : ''
	);
	// Resolved voice object from the current selection
	const activeVoice = $derived(
		allVoices.find((v) => v.voiceURI === selectedVoiceURI) ?? null
	);
	// True when voices are loaded AND a valid voice is selected
	const voiceReady = $derived(allVoices.length > 0 && activeVoice !== null);

	// Pending speech timeout ID — cleared before each new call to prevent
	// double-queuing when two CALLED messages arrive within the debounce window.
	let speechTimer: ReturnType<typeof setTimeout> | null = null;

	function loadVoices(): void {
		const voices = speechSynthesis.getVoices();
		if (voices.length === 0) return; // not ready yet — wait for voiceschanged
		allVoices = voices;

		// Auto-select the best Vietnamese voice if nothing saved yet,
		// or if the saved voice no longer exists (e.g. different browser/machine).
		if (!selectedVoiceURI || !voices.some((v) => v.voiceURI === selectedVoiceURI)) {
			const best =
				voices.find((v) => v.lang === 'vi-VN') ??
				voices.find((v) => v.lang.startsWith('vi')) ??
				voices.find((v) => v.name.toLowerCase().includes('vietnamese')) ??
				null;
			if (best) {
				selectedVoiceURI = best.voiceURI;
				localStorage.setItem('display-voice-uri', best.voiceURI);
			}
		}
	}

	function selectVoice(uri: string): void {
		selectedVoiceURI = uri;
		localStorage.setItem('display-voice-uri', uri);
	}

	onMount(() => {
		loadVoices();
		speechSynthesis.addEventListener('voiceschanged', loadVoices);
	});

	onDestroy(() => {
		if (!browser) return; // speechSynthesis is not available in SSR (Node.js)
		speechSynthesis.removeEventListener('voiceschanged', loadVoices);
		if (speechTimer !== null) clearTimeout(speechTimer);
		speechSynthesis.cancel();
		if (currentAudio) {
			currentAudio.pause();
			currentAudio = null;
		}
	});

	function enableAudio(): void {
		// Must run from a user-gesture to unlock browser autoplay policy.
		const warmup = new SpeechSynthesisUtterance(' ');
		warmup.volume = 0;
		speechSynthesis.speak(warmup);
		audioEnabled = true;
	}

	// Connect to Google TTS immediately when "Bật loa" is clicked.
	// This pre-warms the connection, populates the cache, and confirms the speaker works
	// before the first number is called — so there's no delay on first announcement.
	$effect(() => {
		if (!audioEnabled) return;
		announceWithGoogleTTS('Loa đã sẵn sàng').catch((err: unknown) => {
			ttsError = err instanceof Error ? err.message : String(err);
			announceWithBrowserTTS('Loa đã sẵn sàng');
		});
	});

	// Convert 1–99 to Vietnamese words so TTS reads naturally and slowly.
	// Reading "hai mươi mốt" is inherently slower + clearer than reading "21".
	function numberToVietnamese(n: number): string {
		const units = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
		if (n <= 9) return units[n];
		if (n === 10) return 'mười';
		const tens = Math.floor(n / 10);
		const unit = n % 10;
		const tensWord = tens === 1 ? 'mười' : `${units[tens]} mươi`;
		if (unit === 0) return tensWord;
		if (unit === 1 && tens > 1) return `${tensWord} mốt`;
		if (unit === 5 && tens >= 1) return `${tensWord} lăm`;
		return `${tensWord} ${units[unit]}`;
	}

	function buildUtterance(text: string): SpeechSynthesisUtterance {
		const u = new SpeechSynthesisUtterance(text);
		u.lang = activeVoice?.lang ?? 'vi-VN';
		if (activeVoice) u.voice = activeVoice;
		u.rate = 0.85;
		u.pitch = 1.0;
		u.volume = 1.0;
		return u;
	}

	function announce(called: CalledMessage): void {
		// Cancel any pending debounce
		if (speechTimer !== null) {
			clearTimeout(speechTimer);
			speechTimer = null;
		}
		// Cancel any playing Google TTS audio
		if (currentAudio) {
			currentAudio.pause();
			currentAudio = null;
		}
		speechSynthesis.cancel();

		// 100ms debounce: Chrome silently no-ops speak() called immediately after cancel().
		speechTimer = setTimeout(() => {
			speechTimer = null;
			const text = `Mời số, ${numberToVietnamese(called.number)}.`;
			announceWithGoogleTTS(text).catch((err: unknown) => {
				ttsError = err instanceof Error ? err.message : String(err);
				announceWithBrowserTTS(text);
			});
		}, 100);
	}

	async function announceWithGoogleTTS(text: string): Promise<void> {
		const resp = await fetch('/api/tts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text })
		});
		if (!resp.ok) {
			const body = await resp.text().catch(() => '');
			throw new Error(`HTTP ${resp.status}: ${body}`);
		}
		const blob = await resp.blob();
		const url = URL.createObjectURL(blob);
		const audio = new Audio(url);
		currentAudio = audio;
		audio.onended = () => {
			URL.revokeObjectURL(url);
			if (currentAudio === audio) currentAudio = null;
		};
		ttsError = null;
		ttsMode = 'google';
		await audio.play();
	}

	function announceWithBrowserTTS(text: string): void {
		ttsMode = 'browser';
		if (speechSynthesis.paused) speechSynthesis.resume();
		speechSynthesis.speak(buildUtterance(text));
	}

	function testVoice(): void {
		speechSynthesis.cancel();
		if (speechSynthesis.paused) speechSynthesis.resume();
		speechSynthesis.speak(buildUtterance('Mời số, hai mươi mốt.'));
	}

	// Voices sorted: vi-VN first, then vi-*, then rest alphabetically by lang+name
	const sortedVoices = $derived(
		[...allVoices].sort((a, b) => {
			const aVi = a.lang.startsWith('vi') ? 0 : 1;
			const bVi = b.lang.startsWith('vi') ? 0 : 1;
			if (aVi !== bVi) return aVi - bVi;
			return a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
		})
	);

	// ─── Reactive: fire speech on new CALLED events ───────────────────────────
	$effect(() => {
		const called = ws.lastCalled;
		const enabled = audioEnabled; // read unconditionally — must be a tracked dep
		if (!called || !enabled) return;
		if (lastAnnouncedTs === called.ts) return;
		lastAnnouncedTs = called.ts;
		announce(called);
	});

	function displayNumber(): string {
		return ws.currentNumber === 0 ? '--' : String(ws.currentNumber).padStart(2, '0');
	}
</script>

<!-- Autoplay gate: fullscreen overlay until user taps "Bật loa" -->
{#if !audioEnabled}
	<div
		class="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/80 backdrop-blur-sm"
	>
		<p class="text-sm font-medium text-white/60">Nhấn để bật thông báo âm thanh</p>
		<button
			onclick={enableAudio}
			class="rounded-lg bg-white px-12 py-4 text-2xl font-semibold text-gray-900
				   shadow-lg transition-transform hover:bg-gray-50 active:scale-95"
		>
			Bật loa
		</button>
	</div>
{/if}

<!-- Main display -->
<div class="flex h-screen select-none flex-col items-center justify-center bg-gray-950">
	<!-- Big number -->
	{#key ws.lastCalled?.ts}
		<div class="animate-number-flash text-[14rem] font-black leading-none tabular-nums text-white">
			{displayNumber()}
		</div>
	{/key}

	<!-- Timestamp of last call -->
	{#if ws.lastCalled}
		<p class="mt-6 text-sm text-gray-600">
			{new Date(ws.lastCalled.ts).toLocaleTimeString('vi-VN')}
		</p>
	{/if}

	<!-- Connection status -->
	<div class="mt-4 flex items-center gap-2">
		<span
			class="h-1.5 w-1.5 rounded-full"
			class:bg-green-500={ws.status === 'connected'}
			class:bg-yellow-400={ws.status === 'connecting'}
			class:bg-red-500={ws.status !== 'connected' && ws.status !== 'connecting'}
		></span>
		<span class="text-xs text-gray-600">
			{ws.status === 'connected' ? 'Đang kết nối' : 'Đang kết nối lại…'}
		</span>
	</div>

	<!-- TTS mode indicator (shown after first announcement) -->
	{#if audioEnabled && ttsMode !== 'unknown'}
		<p class="mt-3 text-xs {ttsMode === 'google' ? 'text-green-600' : 'text-yellow-500'}">
			{ttsMode === 'google' ? '● Google Cloud TTS' : '● Browser TTS (fallback)'}
		</p>
	{/if}

	<!-- Google TTS error (debug) -->
	{#if ttsError}
		<p class="mt-2 max-w-xs break-all text-center text-xs text-red-400">
			Google TTS error: {ttsError}
		</p>
	{/if}

	<!-- Voice selector — shown in browser fallback mode -->
	{#if audioEnabled && ttsMode !== 'google' && allVoices.length > 0}
		<div class="mt-4 flex flex-col items-center gap-2">
			<p class="text-xs font-medium tracking-widest text-gray-600 uppercase">Giọng đọc</p>
			<div class="flex items-center gap-2">
				<select
					value={selectedVoiceURI}
					onchange={(e) => selectVoice((e.target as HTMLSelectElement).value)}
					class="max-w-65 rounded border border-gray-700 bg-gray-900 px-3 py-1.5
						   text-xs text-gray-300 focus:border-gray-500 focus:outline-none"
				>
					{#if !selectedVoiceURI}
						<option value="">— Chọn giọng —</option>
					{/if}
					{#each sortedVoices as voice (voice.voiceURI)}
						<option value={voice.voiceURI}>
							{voice.name} ({voice.lang})
						</option>
					{/each}
				</select>
				<button
					onclick={testVoice}
					disabled={!activeVoice}
					class="rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs
						   text-gray-400 transition-colors hover:border-gray-500 hover:text-gray-200
						   disabled:cursor-not-allowed disabled:opacity-40"
				>
					Thử
				</button>
			</div>
			{#if !voiceReady}
				<p class="text-xs text-yellow-500">Chưa chọn giọng — chọn một giọng tiếng Việt bên trên</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	@keyframes number-flash {
		0% {
			transform: scale(1.12);
			color: #fbbf24;
		}
		50% {
			transform: scale(1.04);
			color: #fbbf24;
		}
		100% {
			transform: scale(1);
			color: white;
		}
	}
	.animate-number-flash {
		animation: number-flash 0.7s ease-out forwards;
	}
</style>
