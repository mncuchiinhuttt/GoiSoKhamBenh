import { SerialPort } from "serialport";

const port = new SerialPort({
  path: "COM8",
  baudRate: 9600,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  autoOpen: false,
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildFrame(code, addr, number, counter) {
  const order = String(number).padStart(4, "0");
  const cnt = String(counter).padStart(2, "0");
  return Buffer.from([
    0x02, code & 0xFF, addr & 0xFF,
    ...Buffer.from(order, "ascii"),
    ...Buffer.from(cnt, "ascii"),
    0x03,
  ]);
}

async function open() {
  await new Promise((res, rej) => port.open(err => err ? rej(err) : res()));
}

async function setSignals(rts=true, dtr=false) {
  await new Promise((res, rej) => port.set({ rts, dtr }, err => err ? rej(err) : res()));
}

async function drain() {
  await new Promise((res, rej) => port.drain(err => err ? rej(err) : res()));
}

async function send(buf) {
  // giống Java: RTS true, đợi chút, write, drain (Java flush)
  await setSignals(true, false);
  await sleep(10);
  await new Promise((res, rej) => port.write(buf, err => err ? rej(err) : res()));
  await drain();
}

(async () => {
  await open();

  const number = 7, counter = 1;
  const codes = [0xFE, 0xFF];

  console.log("Quét code FE/FF, address 0..15 — nhìn LED và Ctrl+C khi thấy đổi");

  while (true) {
    for (const code of codes) {
      for (let addr = 0; addr <= 15; addr++) {
        const buf = buildFrame(code, addr, number, counter);
        console.log(`Send code=${code.toString(16)} addr=${addr.toString(16)} frame=${buf.toString("hex")}`);
        await send(buf);
        await sleep(400);
      }
    }
  }
})();
