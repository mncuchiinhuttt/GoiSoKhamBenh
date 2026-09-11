import { SerialPort } from 'serialport';

const COM_PORT = process.env.LED_COM_PORT ?? 'COM8';
const BAUD_RATE = 9600;

/** @type {SerialPort | null} */
let port = null;

/** @type {boolean} */
let polling = false;

/** Controls the idle scroll loop. Incremented on each new sendIdleToLED() call
 *  so any previous loop exits when it sees its generation no longer matches. */
let idleScrolling = false;
let idleGeneration = 0;

/** "XIN CHAO" scrolled across the 6-position LED (4+2 FF frame).
 *  11 chars = 8 text + 3 trailing spaces for clean wrap-around. */
const IDLE_TEXT = 'XIN CHAO   ';

// Polling frames (sent every ~500ms like scan-led.mjs)
const pollDD01 = Buffer.from([0x02, 0xdd, 0x01, 0x45, 0x03, 0x03]);
const pollDD0F = Buffer.from([0x02, 0xdd, 0x0f, 0x45, 0x03, 0x03]);
const pollCC00 = Buffer.from([0x02, 0xcc, 0x00, 0x45, 0x03, 0x03]);
/** @param {number} ms */
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {number} n
 * @param {number} len
 */
function asciiDigits(n, len) {
	return Buffer.from(String(n).padStart(len, '0'), 'ascii');
}

/**
 * @param {number} addr
 * @param {Buffer} order4
 * @param {Buffer} sign2
 */
function frameFF(addr, order4, sign2) {
	return Buffer.from([0x02, 0xff, addr & 0xff, ...order4, ...sign2, 0x03]);
}

/**
 * @param {number} addr
 * @param {Buffer} order4
 */
function frameDD(addr, order4) {
	return Buffer.from([0x02, 0xdd, addr & 0xff, ...order4, 0x03]);
}

/**
 * @param {number} addr
 * @param {Buffer} order4
 */
function frameEE(addr, order4) {
	return Buffer.from([0x02, 0xee, addr & 0xff, ...order4, 0x03]);
}

/** @param {Buffer} buf */
async function writeAndDrain(buf) {
	const p = port;
	if (!p?.isOpen) return;
	await new Promise((resolve, reject) =>
		p.write(buf, (err) => (err ? reject(err) : resolve(undefined)))
	);
	await new Promise((resolve, reject) =>
		p.drain((err) => (err ? reject(err) : resolve(undefined)))
	);
}

/** Background polling loop — mirrors scan-led.mjs startPolling(). */
async function startPolling() {
	polling = true;
	(async () => {
		while (polling) {
			try {
				await writeAndDrain(pollDD01);
				await sleep(10);
				await writeAndDrain(pollDD0F);
				await sleep(10);
				await writeAndDrain(pollCC00);
			} catch {
				// Ignore polling errors — do not crash server
			}
			await sleep(450);
		}
	})();
}

/**
 * Scroll "XIN CHAO" across the LED when no number is being called.
 * Sends an FF frame every 500ms, sliding a 6-char window over IDLE_TEXT.
 * Stops automatically when sendToLED() is called.
 *
 * @param {{ address?: number }} [opts]
 */
export function sendIdleToLED({ address = 0 } = {}) {
	idleScrolling = true;
	const generation = ++idleGeneration;
	const doubled = IDLE_TEXT + IDLE_TEXT; // pre-compute for wrapping
	let i = 0;
	(async () => {
		while (idleScrolling && idleGeneration === generation) {
			if (!port?.isOpen) {
				await sleep(500);
				continue;
			}
			const chunk = doubled.substring(i, i + 6);
			const order4 = Buffer.from(chunk.substring(0, 4), 'ascii');
			const sign2 = Buffer.from(chunk.substring(4, 6), 'ascii');
			try {
				await writeAndDrain(frameFF(address, order4, sign2));
			} catch {
				// ignore — port may be busy
			}
			await sleep(500);
			i = (i + 1) % IDLE_TEXT.length;
		}
	})();
}

/** Open serial port, set RTS/DTR once, start background polling. */
export function initLED() {
	port = new SerialPort({
		path: COM_PORT,
		baudRate: BAUD_RATE,
		dataBits: 8,
		parity: 'none',
		stopBits: 1,
		rtscts: false,
		autoOpen: false
	});

	port.open((err) => {
		if (err) {
			console.error(`❌ LED: Không mở được ${COM_PORT}: ${err.message}`);
			console.error(`   → Kiểm tra thiết bị LED và đổi port qua env: LED_COM_PORT=COM3`);
			port = null;
			return;
		}

		const p = port;
		if (p) {
			p.set({ rts: true, dtr: false }, (setErr) => {
				if (setErr) {
					console.error(`❌ LED: Không set RTS: ${setErr.message}`);
				}
			});
		}

		// Small delay after RTS then start polling (mirrors scan-led.mjs open())
		setTimeout(() => {
			console.log(`📺 LED: Kết nối ${COM_PORT} @ ${BAUD_RATE} baud OK`);
			startPolling();
			sendIdleToLED(); // show "XIN CHAO" scroll while waiting for first call
		}, 10);
	});

	port.on('close', () => {
		polling = false;
	});

	port.on('error', (err) => {
		console.error('❌ LED error:', err.message);
	});

	// Cleanup on server shutdown
	process.on('SIGINT', () => {
		polling = false;
		if (port?.isOpen) port.close(() => process.exit());
		else process.exit();
	});
}

/**
 * Send number to LED display — FF → sleep 1s → DD → EE (mirrors scan-led.mjs callNumber).
 *
 * @param {{ number: number, counter?: number, address?: number }} opts
 *   number:  1–50  — patient queue number (padded to 4 digits)
 *   counter: 1–99  — counter/desk number, default 1 (padded to 2 digits)
 *   address: 0–15  — display address, default 0
 */
export async function sendToLED({ number, counter = 1, address = 0 }) {
	// Stop idle scroll before sending the number
	idleScrolling = false;

	if (!port?.isOpen) {
		console.warn('⚠️ LED: Port chưa mở — bỏ qua lần gửi này');
		return;
	}

	const order4 = asciiDigits(number, 4);
	const sign2 = asciiDigits(counter, 2);

	try {
		// Step 1: FF frame (main display)
		await writeAndDrain(frameFF(address, order4, sign2));
		await sleep(1000); // matches scan-led.mjs

		// Step 2: DD frame (counter)
		await writeAndDrain(frameDD(address, order4));

		// Step 3: EE frame (counter confirm)
		await writeAndDrain(frameEE(address, order4));

		console.log(
			`📺 LED: Hiển thị số ${String(number).padStart(4, '0')} quầy ${String(counter).padStart(2, '0')} → addr ${address}`
		);
	} catch (/** @type {any} */ err) {
		console.error('❌ LED sendToLED error:', err?.message || err);
	}
}
