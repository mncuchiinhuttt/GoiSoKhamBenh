// test-led-formats.js — Test tất cả frame formats + baudrates để tìm protocol đúng
// Chạy: node test-led-formats.js
// Tuỳ chọn: LED_COM_PORT=COM3 node test-led-formats.js

import { SerialPort } from 'serialport';

const COM_PORT = process.env.LED_COM_PORT ?? 'COM8';
const WAIT_PER_TEST = 3000; // ms chờ giữa mỗi test — đủ thời gian để nhìn LED

// ── Helpers ────────────────────────────────────────────────────────────────────

function hexStr(buf) {
	return [...buf].map((b) => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function makePort(baudRate) {
	return new SerialPort({
		path: COM_PORT,
		baudRate,
		dataBits: 8,
		parity: 'none',
		stopBits: 1,
		autoOpen: false
	});
}

async function openPort(port) {
	return new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
}

async function closePort(port) {
	return new Promise((resolve) => port.close(() => resolve()));
}

async function sendFrame(port, frame, rtsDelay = 1) {
	await new Promise((res, rej) => port.set({ rts: true }, (e) => (e ? rej(e) : res())));
	await sleep(rtsDelay);
	await new Promise((res, rej) => port.write(frame, (e) => (e ? rej(e) : res())));
	await new Promise((res, rej) => port.drain((e) => (e ? rej(e) : res())));
	await new Promise((res, rej) => port.set({ rts: false }, (e) => (e ? rej(e) : res())));
}

// ── Frame definitions ──────────────────────────────────────────────────────────
// Số test: 0123 (dễ nhận ra trên LED 4 chữ số)
// Counter : 01

const NUM = '0123'; // 4 digits
const CTR = '01'; // 2 digits
const numBytes = [...Buffer.from(NUM, 'ascii')]; // [0x30,0x31,0x32,0x33]
const ctrBytes = [...Buffer.from(CTR, 'ascii')]; // [0x30,0x31]

const FRAMES = [
	{
		label: 'Full protocol (0xFF device, addr=1, 4+2 digits)',
		buf: Buffer.from([0x02, 0xff, 0x01, ...numBytes, ...ctrBytes, 0x03])
	},
	{
		label: 'No counter (0xFF device, addr=1, 4 digits only)',
		buf: Buffer.from([0x02, 0xff, 0x01, ...numBytes, 0x03])
	},
	{
		label: 'No device code (addr=1, 4+2 digits)',
		buf: Buffer.from([0x02, 0x01, ...numBytes, ...ctrBytes, 0x03])
	},
	{
		label: 'No device code, no counter (addr=1, 4 digits)',
		buf: Buffer.from([0x02, 0x01, ...numBytes, 0x03])
	},
	{
		label: 'Just digits in STX/ETX (no addr, 4 digits)',
		buf: Buffer.from([0x02, ...numBytes, 0x03])
	},
	{
		label: 'Pure ASCII + CRLF (no control bytes)',
		buf: Buffer.from(NUM + '\r\n', 'ascii')
	},
	{
		label: 'Device code 0xDD (addr=1, 4+2 digits)',
		buf: Buffer.from([0x02, 0xdd, 0x01, ...numBytes, ...ctrBytes, 0x03])
	},
	{
		label: 'Device code 0xAA (addr=1, 4+2 digits)',
		buf: Buffer.from([0x02, 0xaa, 0x01, ...numBytes, ...ctrBytes, 0x03])
	},
	{
		label: 'Addr=1 (full, RTS delay=10ms thay vì 1ms)',
		buf: Buffer.from([0x02, 0xff, 0x01, ...numBytes, ...ctrBytes, 0x03]),
		rtsDelay: 10
	},
	{
		label: 'Addr=1 (full, không dùng RTS)',
		buf: Buffer.from([0x02, 0xff, 0x01, ...numBytes, ...ctrBytes, 0x03]),
		skipRts: true
	}
];

// ── Test một baudrate với tất cả frames ───────────────────────────────────────

async function testBaud(baudRate) {
	console.log(`\n${'═'.repeat(60)}`);
	console.log(`📡 Baudrate: ${baudRate}`);
	console.log(`${'═'.repeat(60)}`);

	let port;
	try {
		port = makePort(baudRate);
		await openPort(port);
		console.log(`✅ Port mở OK (${COM_PORT} @ ${baudRate})`);
	} catch (err) {
		console.error(`❌ Không mở được port: ${err.message}`);
		return;
	}

	for (let i = 0; i < FRAMES.length; i++) {
		const { label, buf, rtsDelay = 1, skipRts = false } = FRAMES[i];
		console.log(`\n[${i + 1}/${FRAMES.length}] ${label}`);
		console.log(`     Bytes: ${hexStr(buf)}`);

		try {
			if (skipRts) {
				await new Promise((res, rej) => port.write(buf, (e) => (e ? rej(e) : res())));
				await new Promise((res, rej) => port.drain((e) => (e ? rej(e) : res())));
			} else {
				await sendFrame(port, buf, rtsDelay);
			}
			console.log(`     ✅ Gửi xong — kiểm tra LED trong ${WAIT_PER_TEST / 1000}s...`);
		} catch (err) {
			console.error(`     ❌ Lỗi gửi: ${err.message}`);
		}

		await sleep(WAIT_PER_TEST);
	}

	await closePort(port);
}

// ── Continuous send test ───────────────────────────────────────────────────────

async function testContinuous(baudRate, frameIndex = 0) {
	const { label, buf } = FRAMES[frameIndex];
	console.log(`\n${'═'.repeat(60)}`);
	console.log(`🔄 Continuous test — ${baudRate} baud — ${label}`);
	console.log(`   Bytes: ${hexStr(buf)}`);
	console.log(`   Gửi 20 lần × 500ms — nếu LED chớp tức thì protocol đúng`);
	console.log(`   (Ctrl+C để dừng)`);
	console.log(`${'═'.repeat(60)}`);

	let port;
	try {
		port = makePort(baudRate);
		await openPort(port);
	} catch (err) {
		console.error(`❌ Không mở được port: ${err.message}`);
		return;
	}

	for (let i = 1; i <= 20; i++) {
		console.log(`  Lần ${i}/20...`);
		try {
			await sendFrame(port, buf);
		} catch (err) {
			console.error(`  ❌ ${err.message}`);
		}
		await sleep(500);
	}

	await closePort(port);
}

// ── Main ───────────────────────────────────────────────────────────────────────

const MODE = process.argv[2] ?? 'frames'; // 'frames' | 'baud' | 'continuous'
const BAUD = parseInt(process.argv[3] ?? '9600', 10);

console.log(`\n🔍 LED Format Tester — ${COM_PORT}`);
console.log(`   mode: ${MODE}  |  baud: ${BAUD}`);
console.log(`   Số test: ${NUM}  |  Counter: ${CTR}`);
console.log(
	`\n📌 Cách sử dụng:
   node test-led-formats.js                    → test tất cả frames @ 9600
   node test-led-formats.js frames 19200       → test tất cả frames @ 19200
   node test-led-formats.js baud               → test 9600/19200/4800/38400
   node test-led-formats.js continuous         → gửi liên tục frame 1 @ 9600
   node test-led-formats.js continuous 9600 2  → gửi liên tục frame 2 @ 9600\n`
);

if (MODE === 'baud') {
	// Test tất cả baudrates phổ biến với frame đầu tiên
	const BAUDS = [9600, 19200, 4800, 38400, 2400];
	for (const baud of BAUDS) {
		const port = makePort(baud);
		try {
			await openPort(port);
			console.log(`\n📡 Baud ${baud}: port mở OK`);
			const { buf } = FRAMES[0];
			console.log(`   Gửi: ${hexStr(buf)}`);
			await sendFrame(port, buf);
			console.log(`   ✅ Gửi xong — kiểm tra LED ${WAIT_PER_TEST / 1000}s...`);
			await sleep(WAIT_PER_TEST);
		} catch (err) {
			console.error(`   ❌ Baud ${baud}: ${err.message}`);
		} finally {
			await closePort(port);
		}
	}
} else if (MODE === 'continuous') {
	const frameIdx = parseInt(process.argv[4] ?? '1', 10) - 1;
	await testContinuous(BAUD, Math.max(0, frameIdx));
} else {
	// Default: test tất cả frames ở baudrate đã chọn
	await testBaud(BAUD);
}

console.log('\n✅ Test hoàn tất.');
process.exit(0);
