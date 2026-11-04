import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.chrometechhype.alicecontrolcenter',
  appName: 'Alice Control Center',
  webDir: 'www',
  // The panel is served by the node process on 127.0.0.1:8722, so the WebView has to leave the app's
  // own origin to reach it. androidScheme http because the loader page probes that loopback server
  // before the panel exists; an https origin would block the probe as mixed content.
  server: {
    androidScheme: 'http',
    allowNavigation: ['127.0.0.1'],
  },
  plugins: {
    Nodejs: { nodeDir: 'nodejs', startMode: 'auto' },
  },
};

export default config;
