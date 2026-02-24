// LED RS485 Display Controller
// Giao tiếp với màn hình LED 4-digit qua serial port RS485 half-duplex.
//
// Frame format:
//   [0x02] [0xFF] [address] [d1][d2][d3][d4] [c1][c2] [0x03]
//   STX     device  addr    order (4 ASCII)   counter(2) ETX
//
// Timing RS485 (half-duplex): RTS=true → sleep 1ms → write → drain → RTS=false

import { SerialPort } from 'serialport';

const COM_PORT = process.env.LED_COM_PORT ?? 'COM8';
const BAUD_RATE = 9600;

/** @type {SerialPort | null} */
let port = null;

/** Mở serial port và đăng ký cleanup khi tắt server. */
export function initLED() {
	port = new SerialPort({ path: COM_PORT, baudRate: BAUD_RATE, autoOpen: false });

	port.open((err) => {
		if (err) {
			console.error(`❌ LED: Không mở được ${COM_PORT}: ${err.message}`);
			console.error('   → Kiểm tra thiết bị LED có được cắm vào chưa, và COM port đúng chưa');
			console.error(`   → Có thể đổi port qua env: LED_COM_PORT=COM3 node server.js`);
			port = null;
			return;
		}
		console.log(`📺 LED: Kết nối ${COM_PORT} @ ${BAUD_RATE} baud OK`);
	});

	port.on('error', (err) => {
		console.error('❌ LED error:', err.message);
	});

	// Đóng port khi server shutdown
	process.on('SIGINT', () => {
		if (port?.isOpen) port.close(() => process.exit());
		else process.exit();
	});
}

/**
 * Gửi số ra màn hình LED.
 *
 * @param {{ number: number, counter?: number, address?: number }} opts
 *   number:  1–99  — số thứ tự bệnh nhân (pad thành 4 digits, ví dụ 23 → "0023")
 *   counter: 1–99  — số quầy (pad thành 2 digits, ví dụ 1 → "01"), mặc định 1
 *   address: 0–15  — địa chỉ màn hình LED, mặc định 0 (confirmed từ serial capture)
 */
export async function sendToLED({ number, counter = 1, address = 0 }) {
	if (!port?.isOpen) {
		console.warn('⚠️ LED: Port chưa mở — bỏ qua lần gửi này');
		return;
	}

	const orderStr = String(number).padStart(4, '0'); // "0023"
	const counterStr = String(counter).padStart(2, '0'); // "01"

	// Xây dựng frame binary
	const frame = Buffer.concat([
		Buffer.from([0x02, 0xff, address]), // STX + device code + address
		Buffer.from(orderStr, 'ascii'), //  4 bytes ASCII: order
		Buffer.from(counterStr, 'ascii'), //  2 bytes ASCII: counter
		Buffer.from([0x03]) //  ETX
	]);

	try {
		// Timing RS485 half-duplex: assert RTS trước khi write
		await new Promise((resolve, reject) =>
			port.set({ rts: true }, (err) => (err ? reject(err) : resolve()))
		);
		await new Promise((r) => setTimeout(r, 1)); // 1ms setup time

		await new Promise((resolve, reject) =>
			port.write(frame, (err) => (err ? reject(err) : resolve()))
		);

		// Chờ buffer gửi hết trước khi hạ RTS
		await new Promise((resolve, reject) =>
			port.drain((err) => (err ? reject(err) : resolve()))
		);

		await new Promise((resolve, reject) =>
			port.set({ rts: false }, (err) => (err ? reject(err) : resolve()))
		);

		console.log(`📺 LED: Gửi OK — số ${orderStr} quầy ${counterStr} → addr ${address}`);
	} catch (err) {
		console.error('❌ LED sendToLED error:', err.message);
		// Đảm bảo RTS về false dù có lỗi
		port.set({ rts: false }).catch(() => {});
	}
}
