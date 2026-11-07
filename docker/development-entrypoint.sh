#!/bin/sh
set -eu

expected_hash=$(sha256sum package-lock.json | cut -d ' ' -f 1)
installed_hash=$(cat node_modules/.mirror-lock-hash 2>/dev/null || true)
if [ "$expected_hash" != "$installed_hash" ]; then
    printf '%s\n' 'Installing dependencies from the updated lockfile.'
    npm ci --no-audit --no-fund
    printf '%s\n' "$expected_hash" > node_modules/.mirror-lock-hash
fi

exec "$@"
