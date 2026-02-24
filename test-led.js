// test-led.js — Test xác nhận LED hoạt động với address=0 (confirmed từ serial capture)
// Chạy: node test-led.js
// Tuỳ chọn: LED_COM_PORT=COM3 node test-led.js

import { initLED, sendToLED } from './src/lib/server/led-controller.js';

console.log('📺 LED Test — address=0 (confirmed từ serial capture)');

initLED();

// Chờ serial port mở xong
await new Promise((r) => setTimeout(r, 800));

const testNumbers = [1, 5, 12, 23, 99];

for (const num of testNumbers) {
	console.log(`\n--- Gọi số ${num} ---`);
	await sendToLED({ number: num, counter: 1, address: 0 });
	await new Promise((r) => setTimeout(r, 3000));
}

console.log('\n✅ Test hoàn tất.');
process.exit(0);
