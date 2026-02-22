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

	// Cached Vietnamese voice — loaded after voiceschanged fires (async on Chrome)
	let viVoice: SpeechSynthesisVoice | null = null;
	// True once a Vietnamese voice is confirmed available — drives the warning banner
	let voiceReady = $state(false);

	// Pending speech timeout ID — cleared before each new call to prevent
	// double-queuing when two CALLED messages arrive within the debounce window.
	let speechTimer: ReturnType<typeof setTimeout> | null = null;

	function loadVoices(): void {
		const voices = speechSynthesis.getVoices();
		viVoice =
			voices.find((v) => v.lang === 'vi-VN') ??
			voices.find((v) => v.lang.startsWith('vi')) ??
			voices.find((v) => v.name.toLowerCase().includes('vietnamese')) ??
			null;
		voiceReady = viVoice !== null;
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
	});

	function enableAudio(): void {
		// Must run from a user-gesture to unlock browser autoplay policy.
		const warmup = new SpeechSynthesisUtterance(' ');
		warmup.volume = 0;
		speechSynthesis.speak(warmup);
		audioEnabled = true;
	}

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

	function announce(called: CalledMessage): void {
		// Cancel any pending debounce timeout — prevents double-queuing when
		// two calls arrive within the debounce window.
		if (speechTimer !== null) {
			clearTimeout(speechTimer);
			speechTimer = null;
		}
		speechSynthesis.cancel();

		// 100ms debounce: Chrome silently no-ops speak() called immediately after
		// cancel(). The extra margin also absorbs rapid back-to-back calls.
		speechTimer = setTimeout(() => {
			speechTimer = null;
			const spokenNumber = numberToVietnamese(called.number);
			// Repeat twice — standard clinic practice; also works around Windows SAPI
			// ignoring the rate property by making the announcement naturally longer.
			// The period between repetitions forces a pause on all SAPI voices.
			const utterance = new SpeechSynthesisUtterance(
				`Mời, số, ${spokenNumber}. Mời, số, ${spokenNumber}.`
			);
			utterance.lang = 'vi-VN';
			if (viVoice) utterance.voice = viVoice;
			utterance.rate = 0.5;
			utterance.pitch = 1.0;
			utterance.volume = 1.0;
			// Chrome bug: after ~15s of silence the synthesizer silently pauses.
			// cancel() does not unpause — must call resume() before speak().
			if (speechSynthesis.paused) speechSynthesis.resume();
			speechSynthesis.speak(utterance);
		}, 100);
	}

	// ─── Reactive: fire speech on new CALLED events ───────────────────────────
	// Read BOTH dependencies unconditionally before any short-circuit so Svelte
	// always registers them — otherwise the short-circuit on the first run
	// (ws.lastCalled is null) prevents audioEnabled from ever being tracked,
	// and clicking "Bật loa" would not re-run the effect.
	$effect(() => {
		const called = ws.lastCalled;
		const enabled = audioEnabled; // read unconditionally — must be a tracked dep
		if (!called || !enabled) return;
		if (lastAnnouncedTs === called.ts) return; // same call, don't replay
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
	<!-- Big number — {#key ts} destroys and recreates the element on each new call
	     (including recalls which have a fresh ts), resetting the CSS animation. -->
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

	<!-- Warning: no Vietnamese TTS voice found -->
	{#if audioEnabled && !voiceReady}
		<div
			class="mt-3 max-w-sm rounded border border-yellow-600/40 bg-yellow-600/10 px-4 py-2
				   text-center text-xs text-yellow-400"
		>
			Không tìm thấy giọng tiếng Việt.<br />
			Dùng <strong class="font-semibold text-yellow-300">Microsoft Edge</strong> để phát tiếng Việt,
			hoặc vào:<br />
			<em>Settings → Time &amp; Language → Speech → Add voices → Vietnamese (Vietnam)</em>
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
