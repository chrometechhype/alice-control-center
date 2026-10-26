import fs from 'node:fs';
import { Client } from 'ssh2';
const cfg = JSON.parse(fs.readFileSync('data/config.json','utf8')).connection;
const client = new Client();
client.on('ready', () => {
  const cmd = process.argv[2] ?? 'ls -la /data/quasar';
  client.exec(cmd, (err, stream) => {
    if (err) { console.error(err.message); process.exit(1); }
    let out = '';
    stream.on('data', (d) => { out += d; });
    stream.stderr.on('data', (d) => { out += d; });
    stream.on('close', () => { console.log(out); client.end(); });
  });
});
client.on('error', (e) => { console.error(e.message); process.exit(1); });
client.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, readyTimeout: 12000 });
