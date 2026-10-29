#!/bin/sh
# Полная отладка станции: ./full-debug.sh [--full-debug]
# Отчёт пишется в data/reports/full-debug-*.txt, пароли Wi-Fi в нём замаскированы.
set -e
cd "$(dirname "$0")"

if [ "$1" != "--full-debug" ]; then
  echo "Полная отладка запускается только с флагом --full-debug." >&2
  echo "Например: ./full-debug.sh --full-debug" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите Node.js 20 или новее: https://nodejs.org/" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Устанавливаю зависимости…" >&2
  npm install --no-audit --no-fund
fi

exec npm run debug:full
