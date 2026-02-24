<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { WsClient } from '$lib/ws.svelte.js';
	import type { CalledMessage } from '$lib/types.js';

	const ws = new WsClient('staff');
	onMount(() => ws.connect());
	onDestroy(() => ws.disconnect());

	// ─── Manual input ─────────────────────────────────────────────────────────
	// Use string state + type="text" so Svelte never converts the value to
	// number/null — avoids the null.trim() crash that happens with type="number".
	let manualInput = $state('');
	let manualError = $state('');

	// ─── Reset confirm state ──────────────────────────────────────────────────
	let confirmReset = $state(false);

	// ─── Derived ──────────────────────────────────────────────────────────────
	// Find the smallest number (1–99) that has not been called yet.
	const nextNumber = $derived.by(() => {
		for (let n = 1; n <= 99; n++) {
			if (!ws.calledNumbers.has(n)) return n;
		}
		return null;
	});

	// ─── Actions ──────────────────────────────────────────────────────────────
	function callNumber(n: number): void {
		ws.send({ type: 'CALL', queueId: 'general', room: 'P1', number: n });
	}

	function callNext(): void {
		if (nextNumber !== null) callNumber(nextNumber);
	}

	function skipNext(): void {
		if (nextNumber !== null) {
			ws.send({ type: 'SKIP', queueId: 'general', room: 'P1', number: nextNumber });
		}
	}

	function callManual(): void {
		manualError = '';
		const n = parseInt(manualInput.trim(), 10);
		if (isNaN(n) || n < 1 || n > 99) {
			manualError = 'Nhập số từ 1 đến 99';
			return;
		}
		if (ws.calledNumbers.has(n)) {
			manualError = `Số ${String(n).padStart(2, '0')} đã được gọi`;
			return;
		}
		callNumber(n);
		manualInput = '';
	}

	function recallHistoryItem(item: CalledMessage): void {
		// Send a fresh CALL — triggers speech + animation on display.
		ws.send({ type: 'CALL', queueId: item.queueId, room: item.room, number: item.number });
	}

	function recallCurrent(): void {
		ws.send({ type: 'RECALL_LAST' });
	}

	function handleManualKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter') callManual();
	}

	function resetSession(): void {
		ws.send({ type: 'RESET' });
		confirmReset = false;
	}

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleTimeString('vi-VN', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}
</script>

<div class="min-h-screen bg-gray-50">
	<!-- Header -->
	<header class="sticky top-0 z-10 border-b border-gray-200 bg-white">
		<div class="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
			<h1 class="text-sm font-semibold text-gray-900">Gọi số</h1>
			<div class="flex items-center gap-2">
				<span
					class="inline-block h-2 w-2 rounded-full"
					class:bg-green-500={ws.status === 'connected'}
					class:bg-yellow-400={ws.status === 'connecting'}
					class:bg-red-500={ws.status === 'disconnected' || ws.status === 'error'}
				></span>
				<span class="text-sm text-gray-500">
					{ws.status === 'connected' ? 'Đã kết nối' : 'Mất kết nối…'}
				</span>
			</div>
		</div>
	</header>

	<main class="mx-auto max-w-3xl space-y-3 p-4">
		<!-- Error display -->
		{#if ws.error}
			<div class="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-600">
				{ws.error}
			</div>
		{/if}

		<!-- Top row: Current number + Display devices -->
		<div class="grid grid-cols-2 gap-3">
			<!-- Current number card -->
			<div
				class="flex flex-col items-center justify-center rounded-lg border border-gray-200 bg-white p-6"
			>
				<p class="mb-1 text-xs font-medium tracking-widest text-gray-400 uppercase">Số hiện tại</p>
				<p class="text-[5rem] font-black leading-none tabular-nums text-gray-900">
					{ws.currentNumber === 0 ? '--' : String(ws.currentNumber).padStart(2, '0')}
				</p>
				{#if ws.currentNumber > 0}
					<button
						onclick={recallCurrent}
						disabled={ws.status !== 'connected'}
						class="mt-3 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold
							   text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50
							   disabled:cursor-not-allowed disabled:opacity-40"
					>
						Gọi lại
					</button>
				{/if}
			</div>

			<!-- Display devices card -->
			<div class="rounded-lg border border-gray-200 bg-white p-4">
				<p class="mb-3 text-xs font-medium tracking-widest text-gray-400 uppercase">
					Màn hình output
				</p>

				{#if ws.displays.length === 0}
					<div class="flex flex-col items-center gap-1.5 py-2 text-center">
						<span class="text-2xl">⚠️</span>
						<p class="text-xs font-medium text-amber-600">Chưa có thiết bị output</p>
						<p class="text-xs text-gray-400">Mở /display trên màn hình hiển thị</p>
					</div>
				{:else}
					<ul class="space-y-2">
						{#each ws.displays as d (d.id)}
							<li class="flex items-center gap-2">
								<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"></span>
								<span class="text-sm text-gray-700">Màn hình #{d.id}</span>
								<span class="ml-auto text-xs text-gray-400">{formatTime(d.connectedAt)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>

		<!-- Call next number -->
		<button
			onclick={callNext}
			disabled={ws.status !== 'connected' || nextNumber === null}
			class="w-full rounded-md bg-gray-900 py-4 text-xl font-semibold text-white
				   transition-colors hover:bg-gray-800 active:scale-[0.99]
				   disabled:cursor-not-allowed disabled:opacity-40"
		>
			{#if nextNumber === null}
				Đã gọi tới số tối đa (99)
			{:else}
				Gọi số tiếp theo: {String(nextNumber).padStart(2, '0')}
			{/if}
		</button>

		<!-- Skip next number -->
		<button
			onclick={skipNext}
			disabled={ws.status !== 'connected' || nextNumber === null}
			class="w-full rounded-md border border-gray-200 bg-white py-2.5 text-sm font-semibold
				   text-gray-500 transition-colors hover:border-gray-300 hover:bg-gray-50
				   disabled:cursor-not-allowed disabled:opacity-40"
		>
			Bỏ qua số {nextNumber !== null ? String(nextNumber).padStart(2, '0') : '—'}
		</button>

		<!-- Manual input -->
		<div class="rounded-lg border border-gray-200 bg-white p-4">
			<p class="mb-3 text-xs font-medium tracking-widest text-gray-400 uppercase">Gọi số cụ thể</p>
			<div class="flex gap-2">
				<!-- type="text" + inputmode="numeric" keeps the value as a string,
				     avoiding the null.trim() crash that type="number" causes in Svelte 5 -->
				<input
					type="text"
					inputmode="numeric"
					pattern="[0-9]*"
					placeholder="1 – 99"
					bind:value={manualInput}
					onkeydown={handleManualKeydown}
					disabled={ws.status !== 'connected'}
					class="w-32 rounded-md border border-gray-200 px-4 py-2.5 text-center text-xl
						   font-bold tabular-nums text-gray-900 outline-none
						   focus:border-gray-400 focus:ring-1 focus:ring-gray-400
						   disabled:cursor-not-allowed disabled:opacity-50"
				/>
				<button
					onclick={callManual}
					disabled={ws.status !== 'connected' || manualInput.trim() === ''}
					class="flex-1 rounded-md bg-gray-900 px-6 py-2.5 text-sm font-semibold text-white
						   transition-colors hover:bg-gray-800 active:scale-[0.99]
						   disabled:cursor-not-allowed disabled:opacity-40"
				>
					Gọi ngay
				</button>
			</div>
			{#if manualError}
				<p class="mt-1.5 text-xs text-red-500">{manualError}</p>
			{/if}
		</div>

		<!-- Call history + Reset -->
		<div class="rounded-lg border border-gray-200 bg-white">
			<div class="flex items-center justify-between border-b border-gray-100 px-4 py-3">
				<p class="text-xs font-medium tracking-widest text-gray-400 uppercase">
					Lịch sử gọi
					{#if ws.history.length > 0}
						<span class="ml-1 font-normal normal-case text-gray-300">({ws.history.length})</span>
					{/if}
				</p>

				<!-- Reset button / confirm row -->
				{#if confirmReset}
					<div class="flex items-center gap-2">
						<span class="text-xs text-gray-500">Xác nhận reset?</span>
						<button
							onclick={resetSession}
							disabled={ws.status !== 'connected'}
							class="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white
								   hover:bg-red-700 disabled:opacity-40"
						>
							Xác nhận
						</button>
						<button
							onclick={() => (confirmReset = false)}
							class="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs
								   font-semibold text-gray-600 hover:bg-gray-50"
						>
							Huỷ
						</button>
					</div>
				{:else}
					<button
						onclick={() => (confirmReset = true)}
						disabled={ws.status !== 'connected'}
						class="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold
							   text-red-500 transition-colors hover:border-red-200 hover:bg-red-50
							   disabled:cursor-not-allowed disabled:opacity-40"
					>
						Reset về đầu
					</button>
				{/if}
			</div>

			{#if ws.history.length === 0}
				<p class="px-4 py-6 text-center text-sm text-gray-400">Chưa có lịch sử gọi số</p>
			{:else}
				<ul class="divide-y divide-gray-50">
					{#each ws.history as item, i (item.ts)}
						<li
							class="flex items-center gap-3 px-4 py-3"
							class:opacity-50={item.skipped}
						>
							<!-- Index -->
							<span class="w-5 text-right text-xs text-gray-300">{i + 1}</span>

							<!-- Number — highlight the most recently displayed one, strikethrough if skipped -->
							<span
								class="text-2xl font-black tabular-nums"
								class:text-gray-900={item.ts === ws.lastCalled?.ts}
								class:text-gray-400={item.ts !== ws.lastCalled?.ts}
								class:line-through={item.skipped}
							>
								{item.display}
							</span>

							<!-- Timestamp + skipped label -->
							<span class="flex-1 text-xs text-gray-400">
								{formatTime(item.ts)}
								{#if item.skipped}
									<span class="ml-1 text-orange-400">đã bỏ</span>
								{/if}
							</span>

							<!-- Recall (hidden for skipped items) -->
							{#if !item.skipped}
								<button
									onclick={() => recallHistoryItem(item)}
									disabled={ws.status !== 'connected'}
									class="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs
										   font-semibold text-gray-600 transition-colors
										   hover:border-gray-300 hover:bg-gray-50
										   disabled:cursor-not-allowed disabled:opacity-40"
								>
									Gọi lại
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</main>
</div>
