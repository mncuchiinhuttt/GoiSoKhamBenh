// test-led-exact-java.mjs — Mô phỏng chính xác Java app:
//   - setRTS(true) một lần trước khi gửi
//   - Gửi từng byte riêng lẻ (giống output.write(int) của Java)
//   - drain() sau mỗi frame
//   - KHÔNG setRTS(false) sau khi gửi
//
// Chạy:
//   node test-led-exact-java.mjs                    → gửi số 1 (default)
//   node test-led-exact-java.mjs default 7          → gửi số 7
//   node test-led-exact-java.mjs variants 7         → thử 3 biến thể RTS/DTR với số 7
//   LED_COM_PORT=COM3 node test-led-exact-java.mjs  → dùng port khác

import { SerialPort } from 'serialport';

const COM_PORT = process.env.LED_COM_PORT ?? 'COM8';

const port = new SerialPort({
	path: COM_PORT,
	baudRate: 9600,
	dataBits: 8,
	parity: 'none',
	stopBits: 1,
	rtscts: false,
	autoOpen: false
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFrame(number, counter = 1, address = 0) {
	const order = String(number).padStart(4, '0');
	const cnt = String(counter).padStart(2, '0');
	return [
		0x02,
		0xff,
		address & 0xff,
		...Buffer.from(order, 'ascii'),
		...Buffer.from(cnt, 'ascii'),
		0x03
	];
}

function hexStr(bytes) {
	return bytes.map((b) => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

async function open() {
	await new Promise((res, rej) => port.open((err) => (err ? rej(err) : res())));
}

async function setSignals(signals) {
	await new Promise((res, rej) =>
		port.set(signals, (err) => (err ? rej(err) : res()))
	);
}

async function writeByte(b) {
	await new Promise((res, rej) =>
		port.write(Buffer.from([b & 0xff]), (err) => (err ? rej(err) : res()))
	);
}

async function drain() {
	await new Promise((res, rej) => port.drain((err) => (err ? rej(err) : res())));
}

/**
 * Gửi bytes giống Java:
 *   setRTS(true) → sleep 10ms → byte-by-byte → drain()
 *   KHÔNG setRTS(false) — Java không làm vậy
 */
async function sendFrame(bytes) {
	await setSignals({ rts: true });
	await sleep(10); // 10ms debug delay (Java code dùng 1ms — giảm lại nếu hoạt động)
	for (const b of bytes) {
		await writeByte(b);
	}
	await drain();
	// Không tắt RTS ở đây
}

/**
 * Thử biến thể RTS/DTR — dùng khi adapter RS485 dùng DTR thay RTS để control DE/RE.
 *   A: rts=true  dtr=false  (chuẩn)
 *   B: rts=false dtr=true   (adapter dùng DTR)
 *   C: rts=true  dtr=true   (cả hai)
 */
async function sendFrameVariant(bytes, variant) {
	const signalMap = {
		A: { rts: true, dtr: false },
		B: { rts: false, dtr: true },
		C: { rts: true, dtr: true }
	};
	await setSignals(signalMap[variant]);
	await sleep(10);
	for (const b of bytes) {
		await writeByte(b);
	}
	await drain();
}

// ─── Main ────────────────────────────────────────────────────────────────────

const MODE = process.argv[2] ?? 'default'; // 'default' | 'variants'
const NUM = parseInt(process.argv[3] ?? '1', 10);

console.log(`\n📡 LED Exact-Java Test — ${COM_PORT}`);
console.log(`   mode: ${MODE}  |  số: ${NUM}`);

try {
	await open();
	console.log(`✅ Port mở OK`);
} catch (err) {
	console.error(`❌ Không mở được port: ${err.message}`);
	console.error(`   → Kiểm tra thiết bị và đổi port: LED_COM_PORT=COM3 node test-led-exact-java.mjs`);
	process.exit(1);
}

const bytes = makeFrame(NUM, 1, 0);
console.log(`   Frame: ${hexStr(bytes)}\n`);

if (MODE === 'variants') {
	// Test 3 biến thể RTS/DTR — mỗi variant gửi 5 lần, chờ 3s để quan sát LED
	const labels = {
		A: 'rts=true  dtr=false (chuẩn)',
		B: 'rts=false dtr=true  (adapter dùng DTR)',
		C: 'rts=true  dtr=true  (cả hai)'
	};

	for (const v of ['A', 'B', 'C']) {
		console.log(`[Variant ${v}] ${labels[v]}`);
		console.log(`             Gửi 5 lần × 200ms — quan sát LED trong 3s...`);
		for (let i = 1; i <= 5; i++) {
			process.stdout.write(`  Lần ${i}/5... `);
			try {
				await sendFrameVariant(bytes, v);
				console.log('OK');
			} catch (err) {
				console.log(`LỖI: ${err.message}`);
			}
			await sleep(200);
		}
		console.log();
		await sleep(3000);
	}
} else {
	// Default: gửi 10 lần × 200ms giống Java polling rate
	console.log(`Gửi 10 lần × 200ms — KHÔNG tắt RTS sau mỗi lần gửi`);
	console.log(`(Quan sát LED — nếu nhận được sẽ hiển thị số ${String(NUM).padStart(4, '0')})\n`);

	for (let i = 1; i <= 10; i++) {
		process.stdout.write(`  Lần ${i}/10... `);
		try {
			await sendFrame(bytes);
			console.log('OK');
		} catch (err) {
			console.log(`LỖI: ${err.message}`);
		}
		await sleep(200);
	}
	console.log(`\n✅ Xong.`);
}

port.close();
