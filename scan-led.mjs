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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function asciiDigits(num, len) {
  return Buffer.from(String(num).padStart(len, "0"), "ascii");
}

function frameFF(mainAddr, order4, sign2) {
  return Buffer.from([0x02, 0xFF, mainAddr & 0xff, ...order4, ...sign2, 0x03]);
}
function frameDD(counterAddr, order4) {
  return Buffer.from([0x02, 0xDD, counterAddr & 0xff, ...order4, 0x03]);
}
function frameEE(counterAddr, order4) {
  return Buffer.from([0x02, 0xEE, counterAddr & 0xff, ...order4, 0x03]);
}

async function open() {
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  // giữ RTS=true giống Java
  await new Promise((res, rej) => port.set({ rts: true, dtr: false }, (e) => (e ? rej(e) : res())));
  await sleep(10);
}

async function writeBytesLikeJava(buf) {
  // Java write từng byte + flush; bên Node dùng write + drain để đảm bảo phát ra hết [web:214]
  await new Promise((res, rej) => port.write(buf, (e) => (e ? rej(e) : res())));
  await new Promise((res, rej) => port.drain((e) => (e ? rej(e) : res())));
}

async function sendSequence({ mainAddr, counterAddr, order, sign }) {
  const order4 = asciiDigits(order, 4);
  const sign2 = asciiDigits(sign, 2);

  // Nhịp giống thread Java (có các sleep lớn) [conversation_history:1]
  await writeBytesLikeJava(frameFF(mainAddr, order4, sign2));
  await sleep(1000);
  await writeBytesLikeJava(frameDD(counterAddr, order4));
  await writeBytesLikeJava(frameEE(counterAddr, order4));
  await sleep(4000);
}

(async () => {
  await open();

  // Bạn sửa 2 giá trị này theo hệ thống của bạn:
  const mainAddr = 0x00;     // nhìn trong monitoring Java: byte thứ 3 của frame FF [conversation_history:1]
  const counterAddr = 0x01;  // thường quầy 01 là address 0x01 (nếu không đúng sẽ brute-force ở phần dưới)

  console.log("Gửi số 0007, quầy 01...");
  for (let i = 0; i < 3; i++) {
    await sendSequence({ mainAddr, counterAddr, order: 7, sign: 1 });
    console.log(`Done ${i + 1}/3`);
  }

  port.close();
})();
