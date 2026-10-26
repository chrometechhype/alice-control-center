const api = 'http://127.0.0.1:8722/api';
const frames = Array.from({ length: 6 }, (_, i) => Array.from({ length: 3 }, (_, z) => [(i * 40 + z * 60) % 256, 180, 90]));
const res = await fetch(`${api}/led/animation`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ frames, fps: 20, loop: true }),
});
console.log('start', res.status, await res.text());
for (let i = 0; i < 4; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const led = await (await fetch(`${api}/led/status`)).json();
  const dev = await (await fetch(`${api}/device`)).json();
  console.log(JSON.stringify({ t: (i + 1) * 2, state: dev.data.status.state, animation: led.data.animation }));
}
const stop = await fetch(`${api}/led/restore`, { method: 'POST' });
console.log('restore', stop.status, await stop.text());
await new Promise((r) => setTimeout(r, 1500));
const after = await (await fetch(`${api}/led/status`)).json();
console.log('after', JSON.stringify(after.data.animation));
