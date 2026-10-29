#!/bin/sh
# Alice Control Center installer for Linux and macOS.
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/chrometechhype/alice-control-center/main/install.sh | sh
#
# Installs into ~/.local/share/AliceControlCenter (override with ACC_INSTALL_DIR),
# keeps the existing data folder, verifies SHA-256 and starts the panel in the background.
# Set ACC_VERSION to a tag (for example v1.0.0-alpha.13) to install that exact version.

set -eu

repo=chrometechhype/alice-control-center
port=8722
install_dir=${ACC_INSTALL_DIR:-$HOME/.local/share/AliceControlCenter}

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Installation failed: %s\n' "$*" >&2
  printf 'The station was not changed. Fix the problem and run the installer again.\n' >&2
  exit 1
}

say ''
say 'Alice Control Center installer'
say '------------------------------'

command -v curl >/dev/null 2>&1 || fail 'curl is required.'
command -v node >/dev/null 2>&1 || fail 'Node.js 20+ is required. Install it from https://nodejs.org/ and run the installer again.'
command -v npm >/dev/null 2>&1 || fail 'npm is required. Install Node.js 20+ from https://nodejs.org/'
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 20 ] || fail "Node.js $(node -v) is too old. Install Node.js 20 or newer: https://nodejs.org/"

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail 'No SHA-256 tool found (sha256sum or shasum).'
  fi
}

tmp=$(mktemp -d "${TMPDIR:-/tmp}/acc-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

tag=${ACC_VERSION:-}
if [ -z "$tag" ]; then
  json=$(curl -fsSL -A acc-installer -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$repo/releases/latest" 2>/dev/null || true)
  tag=$(printf '%s' "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  if [ -z "$tag" ]; then
    # api.github.com is blocked on some networks while github.com itself still works.
    say 'The GitHub API is not reachable, asking github.com instead...'
    page=$(curl -fsSL -o /dev/null -w '%{url_effective}' \
      "https://github.com/$repo/releases/latest" 2>/dev/null || true)
    tag=$(printf '%s' "$page" | sed -n 's#.*/releases/tag/\([^/?#]*\).*#\1#p')
  fi
  [ -n "$tag" ] || fail 'Could not determine the latest release. Check your internet or VPN and run the installer again.'
fi

version=${tag#v}
zip_name="Alice-Control-Center-$version.zip"
asset_url="https://github.com/$repo/releases/download/$tag/$zip_name"

say "Downloading $zip_name..."
curl -fsSL -A acc-installer -o "$tmp/$zip_name" "$asset_url" || fail "Could not download $zip_name."
curl -fsSL -A acc-installer -o "$tmp/$zip_name.sha256" "$asset_url.sha256" \
  || fail "Could not download the checksum for $zip_name."

expected=$(cut -d' ' -f1 < "$tmp/$zip_name.sha256" | head -n 1 | tr 'A-F' 'a-f')
case "$expected" in
  ''|*[!0-9a-f]*) fail "The SHA-256 file has an unexpected format: $expected" ;;
esac
[ ${#expected} -eq 64 ] || fail "The SHA-256 file has an unexpected format: $expected"
actual=$(checksum "$tmp/$zip_name")
[ "$actual" = "$expected" ] || fail "SHA-256 mismatch. Expected $expected, got $actual."
say "SHA-256 verified: $actual"

command -v unzip >/dev/null 2>&1 || fail 'unzip is required.'
unzip -q "$tmp/$zip_name" -d "$tmp/app" || fail 'Could not unpack the archive.'
source_dir="$tmp/app/alice-control-center"
if [ ! -f "$source_dir/start.sh" ]; then
  source_dir=$(find "$tmp/app" -mindepth 1 -maxdepth 1 -type d | head -n 1)
fi
[ -n "$source_dir" ] && [ -f "$source_dir/start.sh" ] || fail 'The archive does not look like Alice Control Center.'

if [ -f "$install_dir/acc.pid" ]; then
  old_pid=$(cat "$install_dir/acc.pid" 2>/dev/null || true)
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    say 'Stopping the running panel...'
    kill "$old_pid" 2>/dev/null || true
    wait_attempt=0
    while kill -0 "$old_pid" 2>/dev/null && [ "$wait_attempt" -lt 20 ]; do
      sleep 1
      wait_attempt=$((wait_attempt + 1))
    done
  fi
  rm -f "$install_dir/acc.pid"
fi

say "Installing to $install_dir..."
mkdir -p "$install_dir"
cp -R "$source_dir"/. "$install_dir"/
chmod +x "$install_dir/start.sh" "$install_dir/full-debug.sh" 2>/dev/null || true

# Since 1.0.0-alpha.13 tsx is a runtime dependency, so test and build tooling is skipped; older
# archives keep tsx in devDependencies and need the full install.
if node -e 'process.exit(require(process.argv[1]).dependencies.tsx ? 0 : 1)' \
  "$install_dir/package.json" 2>/dev/null; then
  npm_flags='--omit=dev'
else
  npm_flags=''
fi

say 'Installing dependencies...'
dep_attempt=1
while :; do
  # shellcheck disable=SC2086
  if (cd "$install_dir" && npm install --no-audit --no-fund $npm_flags \
    --fetch-retries=5 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=60000 \
    --fetch-timeout=120000); then
    break
  fi
  if [ "$dep_attempt" -ge 3 ]; then
    say ''
    say 'npm could not download the packages. The files are unpacked, but the panel will not start.'
    say 'Check the internet, a proxy or an npm registry mirror, then finish the install with:'
    say "  cd \"$install_dir\" && npm install"
    fail 'npm install failed three times.'
  fi
  dep_attempt=$((dep_attempt + 1))
  say "npm install failed, retrying ($dep_attempt of 3)..."
  sleep 5
done

cat > "$install_dir/acc-start.sh" <<'LAUNCHER'
#!/bin/sh
# Starts the panel in the background and remembers its pid.
cd "$(dirname "$0")" || exit 1
if [ -f acc.pid ] && kill -0 "$(cat acc.pid)" 2>/dev/null; then
  echo "Alice Control Center is already running: http://127.0.0.1:8722"
  exit 0
fi
nohup ./start.sh >> acc.log 2>&1 &
echo $! > acc.pid
LAUNCHER
chmod +x "$install_dir/acc-start.sh"

say 'Starting the panel...'
"$install_dir/acc-start.sh"

attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
    break
  fi
  sleep 1
  attempt=$((attempt + 1))
done

say ''
say "Alice Control Center $version is installed."
say "Folder:  $install_dir"
if [ "$attempt" -lt 30 ]; then
  say "Panel:   http://127.0.0.1:$port"
else
  say "Panel did not answer yet. Check the log: $install_dir/acc.log"
fi
say "Log:     $install_dir/acc.log"
say "Start again: $install_dir/acc-start.sh"
say "Stop:        kill \$(cat $install_dir/acc.pid)"
say 'There is no tray icon on Linux and macOS: the launcher above starts and stops the panel.'
say 'The panel listens on 127.0.0.1 only; phone access is enabled in settings.'
