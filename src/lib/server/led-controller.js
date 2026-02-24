// LED RS485 Display Controller
// Protocol confirmed from scan-led.mjs (working):
//
// Init: setRTS(true), setDTR(false) once on open — never change afterwards
//
// Background polling (~500ms cycle, async while loop):
//   DD01 → sleep 10ms → DD0F → sleep 10ms → CC00 → sleep 450ms → repeat
//
// callNumber sequence:
//   1. FF frame:  02 FF [addr] [4 ASCII digits order] [2 ASCII digits sign] 03
//   2. sleep 1000ms
//   3. DD frame:  02 DD [addr] [4 ASCII digits order] 03
//   4. EE frame:  02 EE [addr] [4 ASCII digits order] 03

import { SerialPort } from 'serialport';

const COM_PORT = process.env.LED_COM_PORT ?? 'COM8';
const BAUD_RATE = 9600;

/** @type {SerialPort | null} */
let port = null;

/** @type {boolean} */
let polling = false;

// Polling frames (sent every ~500ms like scan-led.mjs)
const pollDD01 = Buffer.from([0x02, 0xdd, 0x01, 0x45, 0x03, 0x03]);
const pollDD0F = Buffer.from([0x02, 0xdd, 0x0f, 0x45, 0x03, 0x03]);
const pollCC00 = Buffer.from([0x02, 0xcc, 0x00, 0x45, 0x03, 0x03]);

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function asciiDigits(n, len) {
	return Buffer.from(String(n).padStart(len, '0'), 'ascii');
}

/** Build main display frame: 02 FF [addr] [4 digits order] [2 digits sign] 03 */
function frameFF(addr, order4, sign2) {
	return Buffer.from([0x02, 0xff, addr & 0xff, ...order4, ...sign2, 0x03]);
}

/** Build counter DD frame: 02 DD [addr] [4 digits order] 03 */
function frameDD(addr, order4) {
	return Buffer.from([0x02, 0xdd, addr & 0xff, ...order4, 0x03]);
}

/** Build counter EE frame: 02 EE [addr] [4 digits order] 03 */
function frameEE(addr, order4) {
	return Buffer.from([0x02, 0xee, addr & 0xff, ...order4, 0x03]);
}

/** Write full buffer then wait for drain. */
async function writeAndDrain(buf) {
	if (!port?.isOpen) return;
	await new Promise((resolve, reject) =>
		port.write(buf, (err) => (err ? reject(err) : resolve()))
	);
	await new Promise((resolve, reject) =>
		port.drain((err) => (err ? reject(err) : resolve()))
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

		// Set RTS=true, DTR=false once — never change afterwards (mirrors Java + scan-led.mjs)
		port.set({ rts: true, dtr: false }, (setErr) => {
			if (setErr) {
				console.error(`❌ LED: Không set RTS: ${setErr.message}`);
			}
		});

		// Small delay after RTS then start polling (mirrors scan-led.mjs open())
		setTimeout(() => {
			console.log(`📺 LED: Kết nối ${COM_PORT} @ ${BAUD_RATE} baud OK`);
			startPolling();
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
 *   number:  1–99  — patient queue number (padded to 4 digits)
 *   counter: 1–99  — counter/desk number, default 1 (padded to 2 digits)
 *   address: 0–15  — display address, default 0
 */
export async function sendToLED({ number, counter = 1, address = 0 }) {
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
	} catch (err) {
		console.error('❌ LED sendToLED error:', err.message);
	}
}
