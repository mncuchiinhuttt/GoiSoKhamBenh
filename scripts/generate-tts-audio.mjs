import 'dotenv/config';

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const VOICE = process.env.MACOS_TTS_VOICE || 'Linh';
const RATE = process.env.MACOS_TTS_RATE || '170';
const AUDIO_DIR = join(process.cwd(), 'static', 'audio');
const units = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

function numberToVietnamese(number) {
	if (number <= 9) return units[number];
	if (number === 10) return 'mười';
	const tens = Math.floor(number / 10);
	const unit = number % 10;
	const tensWord = tens === 1 ? 'mười' : `${units[tens]} mươi`;
	if (unit === 0) return tensWord;
	if (unit === 1 && tens > 1) return `${tensWord} mốt`;
	if (unit === 5 && tens >= 1) return `${tensWord} lăm`;
	return `${tensWord} ${units[unit]}`;
}

if (process.platform !== 'darwin') {
	throw new Error('Bộ tạo audio macOS cần chạy trên macOS với lệnh say và afconvert.');
}

console.log(`macOS TTS: giọng ${VOICE} | tốc độ ${RATE} | 50 số`);
mkdirSync(AUDIO_DIR, { recursive: true });
const temporaryDir = mkdtempSync(join(tmpdir(), 'goiso-tts-'));

try {
	for (let number = 1; number <= 50; number += 1) {
		const text = `Mời số, ${numberToVietnamese(number)}.`;
		const source = join(temporaryDir, `queue-${String(number).padStart(2, '0')}.aiff`);
		const target = join(AUDIO_DIR, `queue-${String(number).padStart(2, '0')}.wav`);

		console.log(`[${number}/50] ${text}`);
		execFileSync('/usr/bin/say', ['-v', VOICE, '-r', RATE, '-o', source, text], {
			stdio: 'ignore'
		});
		execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', source, target]);
	}
} finally {
	rmSync(temporaryDir, { recursive: true, force: true });
}

console.log(`Đã tạo 50 file WAV tại ${AUDIO_DIR}.`);
