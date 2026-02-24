// test-led-with-prepare.mjs (FINAL VERSION)
import { SerialPort } from 'serialport';

const port = new SerialPort({
  path: 'COM8',
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  rtscts: false,
  autoOpen: false,
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildLedFrame(number, counter = 1, address = 0) {
  const order = String(number).padStart(4, '0');
  const cnt = String(counter).padStart(2, '0');
  return Buffer.from([
    0x02, 0xFF, address & 0xFF,
    ...Buffer.from(order, 'ascii'),
    ...Buffer.from(cnt, 'ascii'),
    0x03,
  ]);
}

function buildPrepareFrame() {
  // Frame "prepare" từ Java: 02 DD 00 53 30 39 34 03
  return Buffer.from([0x02, 0xDD, 0x00, 0x53, 0x30, 0x39, 0x34, 0x03]);
}

async function open() {
  await new Promise((res, rej) => port.open(err => err ? rej(err) : res()));
}

async function setSignals(rts, dtr) {
  await new Promise((res, rej) => port.set({ rts, dtr }, err => err ? rej(err) : res()));
}

async function writeByte(b) {
  await new Promise((res, rej) =>
    port.write(Buffer.from([b & 0xFF]), err => err ? rej(err) : res())
  );
}

async function drain() {
  await new Promise((res, rej) => port.drain(err => err ? rej(err) : res()));
}

async function sendFrame(bytes, rts, dtr) {
  await setSignals(rts, dtr);
  await sleep(10);
  for (const b of bytes) await writeByte(b);
  await drain();
}

async function sendToLED(number, counter = 1, { rts = true, dtr = false } = {}) {
  const prepare = buildPrepareFrame();
  const ledFrame = buildLedFrame(number, counter, 0);

  // Bước 1: Gửi prepare
  await sendFrame(prepare, rts, dtr);
  await sleep(10);

  // Bước 2: Gửi LED frame
  await sendFrame(ledFrame, rts, dtr);
  await sleep(10);

  // Bước 3: Gửi prepare lại
  await sendFrame(prepare, rts, dtr);
}

(async () => {
  await open();

  console.log('🧪 Test với sequence 3 bước (prepare → LED → prepare)');
  
  const modes = [
    { name: 'Mode A: RTS=true, DTR=false', rts: true, dtr: false },
    { name: 'Mode B: RTS=false, DTR=true', rts: false, dtr: true },
    { name: 'Mode C: RTS=true, DTR=true', rts: true, dtr: true },
  ];

  for (const mode of modes) {
    console.log(`\n=== ${mode.name} ===`);
    console.log('Gửi số 0007 quầy 01...');
    
    await sendToLED(7, 1, { rts: mode.rts, dtr: mode.dtr });
    
    console.log('✅ Đã gửi - Quan sát LED trong 5 giây');
    await sleep(5000);
  }

  port.close();
  console.log('\n🏁 Test xong!');
})();
