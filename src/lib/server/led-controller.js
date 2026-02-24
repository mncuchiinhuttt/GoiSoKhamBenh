// LED RS485 Display Controller
// Protocol discovered from Java app serial capture:
//   - Background polling mỗi 500ms (giữ counter device sống)
//   - Khi gọi số: prepare → LED frame → prepare (3-step sequence)
//
// Polling frames:
//   02 DD 01 45 03 03  → poll counter addr 1
//   02 DD 0F 45 03 03  → poll counter addr 15
//   02 CC 00 45 03 03  → poll device CC addr 0
//
// LED frame:
//   02 FF 00 [4 ASCII digits order] [2 ASCII digits counter] 03

import { SerialPort } from 'serialport';

const COM_PORT = process.env.LED_COM_PORT ?? 'COM8';
const BAUD_RATE = 9600;
const POLL_INTERVAL_MS = 500;

/** @type {SerialPort | null} */
let port = null;

/** @type {ReturnType<typeof setInterval> | null} */
let pollingInterval = null;

// Polling frames (sent every 500ms like Java app)
const POLL_FRAMES = [
	Buffer.from([0x02, 0xdd, 0x01, 0x45, 0x03, 0x03]), // poll counter addr 1
	Buffer.from([0x02, 0xdd, 0x0f, 0x45, 0x03, 0x03]), // poll counter addr 15
	Buffer.from([0x02, 0xcc, 0x00, 0x45, 0x03, 0x03])  // poll device CC addr 0
];

// "Prepare" frame — sent before AND after the LED display frame
const PREPARE_FRAME = Buffer.from([0x02, 0xdd, 0x00, 0x53, 0x30, 0x39, 0x34, 0x03]);

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Gửi frame ra port rồi đợi drain xong. */
async function writeFrame(frame) {
	if (!port?.isOpen) return;
	await new Promise((resolve, reject) =>
		port.write(frame, (err) => (err ? reject(err) : resolve()))
	);
	await new Promise((resolve, reject) =>
		port.drain((err) => (err ? reject(err) : resolve()))
	);
}

/** Mở serial port, start background polling, đăng ký cleanup khi tắt server. */
export function initLED() {
	port = new SerialPort({ path: COM_PORT, baudRate: BAUD_RATE, autoOpen: false });

	port.open((err) => {
		if (err) {
			console.error(`❌ LED: Không mở được ${COM_PORT}: ${err.message}`);
			console.error(`   → Kiểm tra thiết bị LED và đổi port qua env: LED_COM_PORT=COM3`);
			port = null;
			return;
		}
		console.log(`📺 LED: Kết nối ${COM_PORT} @ ${BAUD_RATE} baud OK`);

		// Background polling mỗi 500ms — giống Java app
		pollingInterval = setInterval(async () => {
			try {
				for (const frame of POLL_FRAMES) {
					await writeFrame(frame);
					await sleep(10);
				}
			} catch {
				// Bỏ qua lỗi polling — không crash server
			}
		}, POLL_INTERVAL_MS);
	});

	port.on('close', () => {
		if (pollingInterval) {
			clearInterval(pollingInterval);
			pollingInterval = null;
		}
	});

	port.on('error', (err) => {
		console.error('❌ LED error:', err.message);
	});

	// Cleanup khi server shutdown
	process.on('SIGINT', () => {
		if (pollingInterval) clearInterval(pollingInterval);
		if (port?.isOpen) port.close(() => process.exit());
		else process.exit();
	});
}

/**
 * Gửi số mới ra màn hình LED theo đúng 3-step sequence của Java app.
 *
 * @param {{ number: number, counter?: number, address?: number }} opts
 *   number:  1–99  — số thứ tự bệnh nhân (pad thành 4 digits)
 *   counter: 1–99  — số quầy, mặc định 1
 *   address: 0–15  — địa chỉ màn hình, mặc định 0
 */
export async function sendToLED({ number, counter = 1, address = 0 }) {
	if (!port?.isOpen) {
		console.warn('⚠️ LED: Port chưa mở — bỏ qua lần gửi này');
		return;
	}

	const orderStr = String(number).padStart(4, '0');
	const counterStr = String(counter).padStart(2, '0');

	const ledFrame = Buffer.concat([
		Buffer.from([0x02, 0xff, address & 0xff]),
		Buffer.from(orderStr, 'ascii'),
		Buffer.from(counterStr, 'ascii'),
		Buffer.from([0x03])
	]);

	try {
		// Bước 1: Prepare (đánh thức counter device)
		await writeFrame(PREPARE_FRAME);
		await sleep(10);

		// Bước 2: Gửi LED display frame
		await writeFrame(ledFrame);
		await sleep(10);

		// Bước 3: Prepare lại (confirm)
		await writeFrame(PREPARE_FRAME);

		console.log(`📺 LED: Hiển thị số ${orderStr} quầy ${counterStr} → addr ${address}`);
	} catch (err) {
		console.error('❌ LED sendToLED error:', err.message);
	}
}
