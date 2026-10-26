const ALLOWED_COMMANDS: RegExp[] = [
  /^uname( -[arm]){0,2}$/,
  /^(uptime|id|whoami|date|hostname)$/,
  /^df -[kh]$/,
  /^free$/,
  /^ps( aux)?$/,
  /^top -b -n 1$/,
  /^ls( -[a-zA-Z]+)?( \/[A-Za-z0-9_./@:-]+)*$/,
  /^cat \/proc\/(cpuinfo|meminfo|uptime|loadavg|mounts|mtd|version|partitions|devices)$/,
  /^cat \/proc\/net\/(wireless|dev)$/,
  /^cat \/sys\/class\/thermal\/thermal_zone\d+\/(type|temp)$/,
  /^cat \/system\/vendor\/quasar\/VERSION$/,
  /^cat \/etc\/asound\.conf$/,
  /^cat \/sys\/class\/leds\/[A-Za-z0-9:_-]+\/(brightness|trigger|max_brightness)$/,
  /^ls \/sys\/class\/leds$/,
  /^ls \/sys\/class\/bluetooth$/,
  /^netstat -ln$/,
  /^ss -ln$/,
  /^hciconfig( -a)?$/,
  /^bluetoothctl show$/,
  /^amixer( sget Master| get Master)?$/,
  /^iptables -L -n$/,
  /^iwconfig$/,
  /^ifconfig$/,
  /^ip addr$/,
  /^lsusb$/,
  /^mount$/,
  /^cat \/sys\/class\/aml_info\/reboot_reason$/,
  /^q (version|full-info)$/,
  /^bluetoothctl (show|devices|list)$/,
  /^dmesg$/,
];

const SHELL_META = /[;&|><`$()\n\r]/;

export function isAllowlistedCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 300) return false;
  if (SHELL_META.test(trimmed)) return false;
  return ALLOWED_COMMANDS.some((pattern) => pattern.test(trimmed));
}

export function redactCommand(command: string): string {
  return command
    .replace(/(password|passwd|pass|token|secret)([=: ]+)\S+/gi, '$1$2***')
    .slice(0, 500);
}

export function commandPreview(command: string): string {
  return redactCommand(command.trim());
}
