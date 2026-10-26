const api = 'http://127.0.0.1:8722/api';
const frames = Array.from({ length: 24 }, (_, i) =>
  Array.from({ length: 3 }, (_, z) => [ (i * 10 + z * 30) % 256, 200, 60 ]),
);
const res = await fetch(`${api}/led/animation`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ frames, fps: 60, repeat: 25 }),
});
console.log('start', res.status, await res.text());
const started = Date.now();
let last = null;
for (let i = 0; i < 6; i += 1) {
  await new Promise((r) => setTimeout(r, 2500));
  const snapshot = await (await fetch(`${api}/device`)).json();
  const led = await (await fetch(`${api}/led/status`)).json();
  last = { t: Date.now() - started, state: snapshot.data.status.state, animation: led.data.animation };
  console.log(JSON.stringify(last));
}
const stop = await fetch(`${api}/led/restore`, { method: 'POST' });
console.log('restore', stop.status, await stop.text());
