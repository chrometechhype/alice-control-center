import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const outDir = 'public/devices';
fs.mkdirSync(outDir, { recursive: true });

const base =
  'https://avatars.mds.yandex.net/get-lpc';
const ids = {
  clock: {
    violet: `${base}/12373972/e4abb6b6-0d19-4f04-bad2-6fb7ecdd1c45/orig?width=1400&height=1400`,
    pink: `${base}/10116223/f7d0b6bf-70c0-4b6c-a886-52c15e8ff72e/orig?width=1400&height=1400`,
    blue: `${base}/1635340/f176967c-d0a0-49dd-b51c-94ecb9c7c317/orig?width=1400&height=1400`,
    coral: `${base}/1635340/40bdf8b1-e8cd-4ed6-a76b-5560894ff969/orig?width=1400&height=1400`,
    green: `${base}/12602567/25667b8a-9e69-4cbd-8f64-1c7a23fdbe6b/orig?width=1400&height=1400`,
    gray: `${base}/12373972/6e497acf-7c33-4c3b-91f1-45b2f7be6e1a/orig?width=1400&height=1400`,
  },
  plain: {
    violet: `${base}/12602567/72c433b0-a609-4cfb-9928-efdf42fdbeb0/orig?width=1400&height=1400`,
    pink: `${base}/12373972/d5ddad54-f32b-4366-b75b-59661a4593e9/orig?width=1400&height=1400`,
    blue: `${base}/9736426/4fc6f81a-52b6-4ea5-a3f0-f4890e9145e5/orig?width=1400&height=1400`,
    coral: `${base}/9736426/323835d0-9ae3-46c5-8491-070c983de20b/orig?width=1400&height=1400`,
    green: `${base}/12373972/301264c7-2aa0-49c5-a23f-4a8957ae67e3/orig?width=1400&height=1400`,
    gray: `${base}/14837328/06c32c15-9373-4ce5-a62f-415b3b04b886/orig?width=1400&height=1400`,
  },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-lite2-'));
for (const [variant, colors] of Object.entries(ids)) {
  for (const [color, url] of Object.entries(colors)) {
    const raw = path.join(tmp, `${variant}-${color}.img`);
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155 Safari/537.36' },
    });
    if (!res.ok) throw new Error(`${variant}-${color}: HTTP ${res.status}`);
    fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
    const target = path.join(outDir, `lite2-${color}${variant === 'clock' ? '-clock' : ''}.webp`);
    execFileSync('python', ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA')
im.thumbnail((640, 640), Image.LANCZOS)
im.save(sys.argv[2], 'WEBP', quality=90, method=6)
print(sys.argv[2], im.size)
`, raw, target], { stdio: 'inherit' });
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
