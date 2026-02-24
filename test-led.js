// test-led.js — Test script để tìm đúng địa chỉ màn hình LED
// Gửi số 123, quầy 1 lần lượt từ address 1→15, chờ 2 giây mỗi lần.
// Chạy: node test-led.js
// Tuỳ chọn: LED_COM_PORT=COM3 node test-led.js

import { initLED, sendToLED } from './src/lib/server/led-controller.js';

console.log('🔍 LED Address Finder — kiểm tra từng địa chỉ 1–15');
console.log('   Màn hình nào sáng lên với số 0123 là địa chỉ đúng\n');

initLED();

// Chờ serial port mở xong
await new Promise((r) => setTimeout(r, 800));

for (let addr = 1; addr <= 15; addr++) {
	console.log(`\n🔍 Test address ${addr}...`);
	await sendToLED({ number: 123, counter: 1, address: addr });
	await new Promise((r) => setTimeout(r, 2000));
}

console.log('\n✅ Hoàn tất. Nhớ ghi lại địa chỉ đúng và đặt trong server.js.');
process.exit(0);
