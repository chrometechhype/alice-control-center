import { describe, expect, it } from 'vitest';
import {
  maskWpaConfig,
  parseScanResults,
  parseWifiRead,
  parseWpaNetworks,
  parseWpaStatus,
  removeWpaNetwork,
  upsertWpaNetwork,
  validateWifiInput,
} from '../server/wifi.ts';

const CONFIG = [
  'ctrl_interface=/var/run/wpa_supplicant',
  'update_config=1',
  '',
  'network={',
  '    ssid="Дом"',
  '    psk="home-pass-1"',
  '    key_mgmt=WPA-PSK',
  '    priority=5',
  '}',
  '',
  'network={',
  '    ssid=Guest',
  '    psk=guestpass',
  '    key_mgmt=WPA-PSK',
  '}',
  '',
].join('\n');

describe('wpa_supplicant.conf parsing', () => {
  it('reads the SSID and the real password of every network', () => {
    const networks = parseWpaNetworks(CONFIG);
    expect(networks).toHaveLength(2);
    expect(networks[0]).toMatchObject({ ssid: 'Дом', psk: 'home-pass-1', priority: 5 });
    expect(networks[1]).toMatchObject({ ssid: 'Guest', psk: 'guestpass' });
  });

  it('unquotes escaped quotes without eating the password', () => {
    const text = 'network={\n    ssid="Cafe \\"Best\\""\n    psk="a\\\\b\\"c"\n}\n';
    expect(parseWpaNetworks(text)[0]).toMatchObject({ ssid: 'Cafe "Best"', psk: 'a\\b"c' });
  });

  it('masks passwords for logs and the debug bundle', () => {
    const masked = maskWpaConfig(CONFIG);
    expect(masked).not.toContain('home-pass-1');
    expect(masked).not.toContain('guestpass');
    expect(masked.match(/psk="\*\*\*"/g)).toHaveLength(2);
  });
});

describe('editing the config', () => {
  it('adds a new network and keeps the existing ones byte for byte', () => {
    const next = upsertWpaNetwork(CONFIG, { ssid: 'Новая', password: 'new-pass-1', security: 'wpa2' });
    expect(next).toContain('ssid="Дом"');
    expect(next).toContain('ssid=Guest');
    expect(next).toContain('ssid="Новая"');
    expect(next).toContain('psk="new-pass-1"');
    expect(next.startsWith('ctrl_interface=/var/run/wpa_supplicant')).toBe(true);
  });

  it('replaces the password of the same SSID instead of adding a duplicate', () => {
    const next = upsertWpaNetwork(CONFIG, { ssid: 'Дом', password: 'home-pass-2', security: 'wpa2' });
    expect(next).toContain('psk="home-pass-2"');
    expect(next).not.toContain('home-pass-1');
    expect(parseWpaNetworks(next)).toHaveLength(2);
  });

  it('writes an open network without a password', () => {
    const next = upsertWpaNetwork(CONFIG, { ssid: 'Гостевая', security: 'open' });
    const block = next.slice(next.lastIndexOf('network={'));
    expect(block).toContain('key_mgmt=NONE');
    expect(block).not.toContain('psk=');
  });

  it('removes only the named network', () => {
    const next = removeWpaNetwork(CONFIG, 'Дом');
    expect(next).not.toContain('Дом');
    expect(next).toContain('ssid=Guest');
  });

  it('creates a header when the file had none', () => {
    const next = upsertWpaNetwork('', { ssid: 'Home', password: '12345678', security: 'wpa2' });
    expect(next).toContain('ctrl_interface=/var/run/wpa_supplicant');
    expect(next).toContain('ssid="Home"');
  });
});

describe('password validation', () => {
  it('accepts a normal WPA passphrase and a 64-digit hex key', () => {
    expect(() => validateWifiInput({ ssid: 'Home', password: 'password1' })).not.toThrow();
    expect(() => validateWifiInput({ ssid: 'Home', password: 'a'.repeat(64) })).not.toThrow();
  });

  it('rejects a short password and a password for an open network', () => {
    expect(() => validateWifiInput({ ssid: 'Home', password: 'short' })).toThrow();
    expect(() => validateWifiInput({ ssid: 'Cafe', password: 'password1', security: 'open' })).toThrow();
  });

  it('rejects an empty or over-long SSID', () => {
    expect(() => validateWifiInput({ ssid: '', password: 'password1' })).toThrow();
    expect(() => validateWifiInput({ ssid: 'x'.repeat(33), password: 'password1' })).toThrow();
  });
});

describe('wpa_cli output', () => {
  it('keeps spaces inside the SSID', () => {
    expect(parseWpaStatus('wpa_state=COMPLETED\nssid=Моя сеть\nip_address=192.0.2.5')).toMatchObject({
      wpa_state: 'COMPLETED',
      ssid: 'Моя сеть',
      ip_address: '192.0.2.5',
    });
  });

  it('deduplicates scan results by SSID and keeps the strongest signal', () => {
    const text = [
      'Selected interface \'wlan0\'',
      'bssid / frequency / signal level / flags / ssid',
      'aa:bb:cc:dd:ee:01\t2412\t-70\t[WPA2-PSK-CCMP][ESS]\tHome',
      'aa:bb:cc:dd:ee:02\t2412\t-40\t[WPA2-PSK-CCMP][ESS]\tHome',
      'aa:bb:cc:dd:ee:03\t5180\t-55\t[WPA3-SAE-CCMP][ESS]\tOffice',
      'aa:bb:cc:dd:ee:04\t2437\t-60\t[ESS]\tCafe',
    ].join('\n');
    const networks = parseScanResults(text);
    expect(networks).toHaveLength(3);
    expect(networks[0]).toMatchObject({ ssid: 'Home', signal: -40, security: 'wpa2' });
    expect(networks.find((item) => item.ssid === 'Office')?.security).toBe('wpa3');
    expect(networks.find((item) => item.ssid === 'Cafe')?.security).toBe('open');
  });

  it('reads the connected SSID and its password from one station round-trip', () => {
    const output = [
      '@@ACC_IFACE',
      'wlan0',
      '@@ACC_CONF',
      '/bkupgrade/data/wpa_supplicant.conf',
      '@@ACC_CLI',
      '/usr/sbin/wpa_cli',
      '@@ACC_STATUS',
      'bssid=aa:bb:cc:dd:ee:02',
      'freq=2412',
      'ssid=Дом',
      'id=0',
      'wpa_state=COMPLETED',
      'ip_address=192.0.2.33',
      'key_mgmt=WPA2-PSK',
      '@@ACC_NETWORKS',
      'network id / ssid / bssid / flags',
      '0\tДом\tany\t[CURRENT]',
      '@@ACC_FILE',
      CONFIG,
      '@@ACC_END',
    ].join('\n');
    const { status } = parseWifiRead(output);
    expect(status.available).toBe(true);
    expect(status.interface).toBe('wlan0');
    expect(status.configPath).toBe('/bkupgrade/data/wpa_supplicant.conf');
    expect(status.connected).toMatchObject({ ssid: 'Дом', psk: 'home-pass-1', ip: '192.0.2.33' });
    expect(status.networks).toHaveLength(2);
  });

  it('reports no connection instead of pretending one when wpa_state is not COMPLETED', () => {
    const output = ['@@ACC_IFACE', 'wlan0', '@@ACC_CLI', '/usr/sbin/wpa_cli', '@@ACC_STATUS', 'wpa_state=SCANNING', '@@ACC_FILE', CONFIG, '@@ACC_END'].join('\n');
    expect(parseWifiRead(output).status.connected).toBeNull();
  });
});
