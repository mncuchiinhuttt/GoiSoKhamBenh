import { SerialPort } from "serialport";

const port = new SerialPort({
  path: "COM8",
  baudRate: 9600,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  rtscts: false,
  autoOpen: false,
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function asciiDigits(n, len) {
  return Buffer.from(String(n).padStart(len, "0"), "ascii");
}

// MainDisplay (FF)
function frameFF(mainAddr, order4, sign2) {
  return Buffer.from([0x02, 0xFF, mainAddr & 0xff, ...order4, ...sign2, 0x03]);
}

// Polling frames seen in monitoring Java: 02 DD 01 45 03 03 etc. [file:137]
const pollDD01 = Buffer.from([0x02, 0xDD, 0x01, 0x45, 0x03, 0x03]);
const pollDD0F = Buffer.from([0x02, 0xDD, 0x0F, 0x45, 0x03, 0x03]);
const pollCC00 = Buffer.from([0x02, 0xCC, 0x00, 0x45, 0x03, 0x03]);

// Counter frames: DD + digits, EE + digits
function frameDD(counterAddr, order4) {
  return Buffer.from([0x02, 0xDD, counterAddr & 0xff, ...order4, 0x03]);
}
function frameEE(counterAddr, order4) {
  return Buffer.from([0x02, 0xEE, counterAddr & 0xff, ...order4, 0x03]);
}

async function open() {
  await new Promise((res, rej) => port.open(e => e ? rej(e) : res()));
  // giống Java: RTS=true và giữ nguyên [conversation_history:1]
  await new Promise((res, rej) => port.set({ rts: true, dtr: false }, e => e ? rej(e) : res()));
  await sleep(10);
}

// Java writeByte loop + flush; Node nên dùng write + drain để đảm bảo transmit xong [page:0]
async function writeAndDrain(buf) {
  await new Promise((res, rej) => port.write(buf, e => e ? rej(e) : res()));
  await new Promise((res, rej) => port.drain(e => e ? rej(e) : res()));
}

let polling = true;

async function startPolling() {
  // Polling mỗi ~500ms như log Java (thấy dày đặc) [file:137]
  (async () => {
    while (polling) {
      try {
        await writeAndDrain(pollDD01);
        await sleep(10);
        await writeAndDrain(pollDD0F);
        await sleep(10);
        await writeAndDrain(pollCC00);
      } catch {}
      await sleep(450);
    }
  })();
}

async function callNumber({ mainAddr, counterAddr, order, sign }) {
  const order4 = asciiDigits(order, 4);
  const sign2  = asciiDigits(sign, 2);

  await writeAndDrain(frameFF(mainAddr, order4, sign2));
  await sleep(1000);               // giống SendDataToDevice.run [conversation_history:1]
  await writeAndDrain(frameDD(counterAddr, order4));
  await writeAndDrain(frameEE(counterAddr, order4));
}

(async () => {
  await open();
  await startPolling();

  console.log("Polling đã chạy. Đợi 2s rồi gọi số...");
  await sleep(2000);

  // Bạn chỉnh đúng theo hệ thống của bạn
  const mainAddr = 0x00;     // từ monitoring Java trước đây bạn thấy 00 [file:138]
  const counterAddr = 0x01;  // nếu không chắc, thử 0..15

  console.log("Gọi số 0007 quầy 01");
  await callNumber({ mainAddr, counterAddr, order: 7, sign: 1 });

  console.log("Giữ polling thêm 10s để LED kịp update...");
  await sleep(10000);

  polling = false;
  port.close();
})();
