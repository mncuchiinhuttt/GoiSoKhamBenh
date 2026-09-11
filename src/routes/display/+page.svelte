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

	// Native macOS TTS audio-file mode
	let ttsMode = $state<'macos' | 'browser' | 'unknown'>('unknown');
	// Last local audio error (for debugging)
	let ttsError = $state<string | null>(null);
	// Active local audio element — cancelled when a new number is called
	let currentAudio: HTMLAudioElement | null = null;
	let currentSource: AudioBufferSourceNode | null = null;

	// All voices available on this device/browser
	let allVoices = $state<SpeechSynthesisVoice[]>([]);
	// URI of the user-selected voice — persisted to localStorage
	let selectedVoiceURI = $state<string>(
		browser ? (localStorage.getItem('display-voice-uri') ?? '') : ''
	);
	// Resolved voice object from the current selection
	const activeVoice = $derived(allVoices.find((v) => v.voiceURI === selectedVoiceURI) ?? null);
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

	let audioCtx: AudioContext | null = null;
	let prewarmedAudio: HTMLAudioElement | null = null;

	function enableAudio(): void {
		// 1. Unlock Web Audio API AudioContext during user click gesture
		try {
			const AudioContextClass =
				window.AudioContext ||
				(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			if (AudioContextClass) {
				audioCtx = new AudioContextClass();
				if (audioCtx.state === 'suspended') {
					audioCtx.resume();
				}
			}
		} catch (e) {
			console.warn('[Audio] Failed to init AudioContext:', e);
		}

		// 2. Pre-unlock HTML5 Audio during user click gesture
		try {
			prewarmedAudio = new Audio();
			prewarmedAudio.src =
				'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
			prewarmedAudio
				.play()
				.then(() => prewarmedAudio?.pause())
				.catch(() => {});
		} catch (e) {
			console.warn('[Audio] Failed to pre-warm HTML5 Audio:', e);
		}

		// 3. Unlock browser Web Speech API
		try {
			const warmup = new SpeechSynthesisUtterance(' ');
			warmup.volume = 0;
			speechSynthesis.speak(warmup);
		} catch {}

		audioEnabled = true;
		announceWithBrowserTTS('Loa đã sẵn sàng');
	}

	// Convert 1–50 to Vietnamese words so TTS reads naturally and slowly.
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
		// Cancel any playing local audio
		if (currentSource) {
			try {
				currentSource.stop();
			} catch {}
			currentSource.disconnect();
			currentSource = null;
		}
		if (currentAudio) {
			currentAudio.pause();
			currentAudio = null;
		}
		speechSynthesis.cancel();

		// 100ms debounce: Chrome silently no-ops speak() called immediately after cancel().
		speechTimer = setTimeout(() => {
			speechTimer = null;
			const text = `Mời số, ${numberToVietnamese(called.number)}.`;
			announceWithLocalAudio(called.number).catch((err: unknown) => {
				ttsError = err instanceof Error ? err.message : String(err);
				announceWithBrowserTTS(text);
			});
		}, 100);
	}

	async function announceWithLocalAudio(number: number): Promise<void> {
		const filename = `/audio/queue-${String(number).padStart(2, '0')}.wav`;
		const resp = await fetch(filename);
		if (!resp.ok) {
			throw new Error(`Không tìm thấy file audio số ${String(number).padStart(2, '0')}`);
		}
		const arrayBuf = await resp.arrayBuffer();

		// Decode and play the macOS-generated WAV through the unlocked AudioContext.
		if (audioCtx && audioCtx.state !== 'closed') {
			if (audioCtx.state === 'suspended') await audioCtx.resume();
			const decodedBuffer = await audioCtx.decodeAudioData(arrayBuf.slice(0));
			const source = audioCtx.createBufferSource();
			source.buffer = decodedBuffer;
			source.connect(audioCtx.destination);
			currentSource = source;
			source.onended = () => {
				source.disconnect();
				if (currentSource === source) currentSource = null;
			};
			ttsError = null;
			ttsMode = 'macos';
			source.start(0);
			return;
		}

		// Fallback when Web Audio is unavailable.
		const blob = new Blob([arrayBuf], { type: 'audio/wav' });
		const url = URL.createObjectURL(blob);
		const audio = new Audio(url);
		currentAudio = audio;
		audio.volume = 1;
		audio.onended = () => {
			URL.revokeObjectURL(url);
			if (currentAudio === audio) currentAudio = null;
		};
		ttsError = null;
		ttsMode = 'macos';
		await audio.play();
	}
	function testAudio(): void {
		const testNumber = ws.currentNumber > 0 ? ws.currentNumber : 21;
		const text = `Mời số, ${numberToVietnamese(testNumber)}.`;
		announceWithLocalAudio(testNumber).catch((err: unknown) => {
			ttsError = err instanceof Error ? err.message : String(err);
			announceWithBrowserTTS(text);
		});
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
<div class="flex h-screen flex-col items-center justify-center bg-gray-950 select-none">
	<!-- Big number -->
	{#key ws.lastCalled?.ts}
		<div class="animate-number-flash text-[14rem] leading-none font-black text-white tabular-nums">
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
			{ws.status === 'connected'
				? 'Đã kết nối'
				: ws.status === 'connecting'
					? 'Đang kết nối…'
					: 'Đang kết nối lại…'}
		</span>
	</div>

	<!-- Local macOS audio indicator and test button -->
	{#if audioEnabled}
		<div class="mt-3 flex items-center gap-3">
			{#if ttsMode !== 'unknown'}
				<p class="text-xs {ttsMode === 'macos' ? 'text-green-500' : 'text-yellow-500'}">
					{ttsMode === 'macos' ? '● Audio macOS' : '● Browser TTS (fallback)'}
				</p>
			{/if}
			<button
				onclick={testAudio}
				class="rounded border border-gray-800 bg-gray-900/80 px-2.5 py-1 text-[11px] font-medium text-gray-400
					   transition-colors hover:border-gray-700 hover:text-gray-200"
			>
				Thử file audio
			</button>
		</div>
	{/if}

	<!-- Local audio error (debug) -->
	{#if ttsError}
		<p class="mt-2 max-w-xs text-center text-xs break-all text-red-400">
			Lỗi file audio: {ttsError}
		</p>
	{/if}

	<!-- Voice selector — shown in browser fallback mode -->
	{#if audioEnabled && ttsMode !== 'macos' && allVoices.length > 0}
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
