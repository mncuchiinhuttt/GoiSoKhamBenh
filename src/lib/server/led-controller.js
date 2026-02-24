// LED RS485 Display Controller
// Frame: [0x02] [0xFF] [address] [4 ASCII digits order] [2 ASCII digits counter] [0x03]
// LED cần nhận frame liên tục mỗi 2s để giữ hiển thị, nếu không tự reset về "HELLO".

import { SerialPort } from 'serialport';

const COM_PORT = process.env.LED_COM_PORT ?? 'COM8';
const BAUD_RATE = 9600;
const REFRESH_INTERVAL_MS = 2000;

/** @type {SerialPort | null} */
let port = null;

// Số đang hiển thị trên LED — refresh interval gửi lại liên tục
let currentDisplay = { number: 0, counter: 1, address: 0 };

/** @type {ReturnType<typeof setInterval> | null} */
let refreshInterval = null;

/** Tạo frame binary từ params. */
function buildFrame(number, counter, address) {
	const orderStr = String(number).padStart(4, '0');
	const counterStr = String(counter).padStart(2, '0');
	return Buffer.concat([
		Buffer.from([0x02, 0xff, address & 0xff]),
		Buffer.from(orderStr, 'ascii'),
		Buffer.from(counterStr, 'ascii'),
		Buffer.from([0x03])
	]);
}

/** Gửi frame ra port (không async, fire-and-forget dùng cho refresh). */
function writeFrame(frame) {
	if (!port?.isOpen) return;
	port.write(frame, (err) => {
		if (err) console.error('❌ LED write error:', err.message);
	});
}

/** Mở serial port, start refresh interval, đăng ký cleanup khi tắt server. */
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

		// Gửi lại frame hiện tại mỗi 2 giây để LED không reset về "HELLO"
		refreshInterval = setInterval(() => {
			const frame = buildFrame(
				currentDisplay.number,
				currentDisplay.counter,
				currentDisplay.address
			);
			writeFrame(frame);
		}, REFRESH_INTERVAL_MS);
	});

	port.on('close', () => {
		if (refreshInterval) {
			clearInterval(refreshInterval);
			refreshInterval = null;
		}
	});

	port.on('error', (err) => {
		console.error('❌ LED error:', err.message);
	});

	// Cleanup khi server shutdown
	process.on('SIGINT', () => {
		if (refreshInterval) clearInterval(refreshInterval);
		if (port?.isOpen) port.close(() => process.exit());
		else process.exit();
	});
}

/**
 * Gửi số mới ra màn hình LED và cập nhật refresh state.
 *
 * @param {{ number: number, counter?: number, address?: number }} opts
 *   number:  1–99  — số thứ tự bệnh nhân (pad thành 4 digits)
 *   counter: 1–99  — số quầy, mặc định 1
 *   address: 0–15  — địa chỉ màn hình, mặc định 0 (confirmed từ serial capture)
 */
export async function sendToLED({ number, counter = 1, address = 0 }) {
	if (!port?.isOpen) {
		console.warn('⚠️ LED: Port chưa mở — bỏ qua lần gửi này');
		return;
	}

	// Cập nhật state để refresh interval tiếp tục gửi số mới
	currentDisplay = { number, counter, address };

	const frame = buildFrame(number, counter, address);
	const orderStr = String(number).padStart(4, '0');
	const counterStr = String(counter).padStart(2, '0');

	try {
		// Timing RS485 half-duplex
		await new Promise((resolve, reject) =>
			port.set({ rts: true }, (err) => (err ? reject(err) : resolve()))
		);
		await new Promise((r) => setTimeout(r, 1));

		await new Promise((resolve, reject) =>
			port.write(frame, (err) => (err ? reject(err) : resolve()))
		);

		await new Promise((resolve, reject) =>
			port.drain((err) => (err ? reject(err) : resolve()))
		);

		await new Promise((resolve, reject) =>
			port.set({ rts: false }, (err) => (err ? reject(err) : resolve()))
		);

		console.log(`📺 LED: Hiển thị số ${orderStr} quầy ${counterStr} → addr ${address}`);
	} catch (err) {
		console.error('❌ LED sendToLED error:', err.message);
		port.set({ rts: false }).catch(() => {});
	}
}
