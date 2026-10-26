#!/bin/sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js 20 or newer: https://nodejs.org/" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

if [ ! -d dist ]; then
  echo "Building frontend..."
  npm run build
fi

echo "Starting Alice Control Center on http://127.0.0.1:8722"
exec npm start
