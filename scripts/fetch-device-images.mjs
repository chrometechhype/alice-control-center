import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const outDir = 'public/devices';
fs.mkdirSync(outDir, { recursive: true });

const picks = {
  lite2: 'https://avatars.mds.yandex.net/get-lpc/12373972/e4abb6b6-0d19-4f04-bad2-6fb7ecdd1c45/orig?width=1400&height=1400',
  lite: 'https://avatars.mds.yandex.net/get-lpc/10704932/ee3a2d82-56b2-4309-bb1d-252e70d6ca18/orig',
  mini: 'https://avatars.mds.yandex.net/get-lpc/1635340/a5ee5bf6-e79b-4183-be86-db8043ecee01/orig',
  'mini-pro': 'https://avatars.mds.yandex.net/get-lpc/12602567/1e9074b0-b0f4-42db-805b-9e5ee7ca56ef/orig?width=560&height=560',
  'mini-clock': 'https://avatars.mds.yandex.net/get-lpc/10116223/2cebc7a1-81d0-4a64-bfa4-a954a9c53a7e/orig',
  'mini-old': 'https://avatars.mds.yandex.net/get-lpc/10116223/6bc6ccbd-f2f1-407b-848d-3de14a440ddb/orig',
  max: 'https://avatars.mds.yandex.net/get-lpc/10116223/d96c10c7-727f-401d-8043-534e3f6e36df/orig',
  station2: 'https://avatars.mds.yandex.net/get-lpc/10704932/b41343b6-603e-4edb-9762-d57b33c28ef8/orig',
  station3: 'https://avatars.mds.yandex.net/get-lpc/16405748/13c14214-c7bc-4333-bb6b-38e5e1625326/orig?width=571&height=571',
  'duo-max': 'https://avatars.mds.yandex.net/get-lpc/10116223/d2401f2c-e3ee-49b4-853c-1e6f300af675/orig?width=840&height=840',
  midi: 'https://avatars.mds.yandex.net/get-lpc/10704932/0cbab93c-00a9-43fa-8000-807a3fdadefe/orig',
  street: 'https://avatars.mds.yandex.net/get-lpc/14837328/a71d89e4-b128-4869-8811-6710b3b5734d/orig?width=572&height=571',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-devices-'));
for (const [name, url] of Object.entries(picks)) {
  const raw = path.join(tmp, `${name}.img`);
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155 Safari/537.36' },
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
  const target = path.join(outDir, `${name}.webp`);
  execFileSync('python', ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA')
im.thumbnail((640, 640), Image.LANCZOS)
im.save(sys.argv[2], 'WEBP', quality=90, method=6)
print(sys.argv[2], im.size)
`, raw, target], { stdio: 'inherit' });
}
fs.rmSync(tmp, { recursive: true, force: true });
