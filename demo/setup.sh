#!/usr/bin/env bash
#
# demo/setup.sh — make a throwaway git repository with a FAILING `node --test`
# suite for the worktree-test-demo, and print the path to paste as its `repo`
# input.
#
#   ./demo/setup.sh            # creates it under $TMPDIR (or /tmp)
#   ./demo/setup.sh <dir>      # or at <dir> (must not exist)
#
set -euo pipefail

DIR="${1:-${TMPDIR:-/tmp}/sammy-demo-repo}"
DIR="${DIR%/}"
if [ -e "$DIR" ]; then
  echo "✗ $DIR already exists — remove it or pass another path" >&2
  exit 1
fi

mkdir -p "$DIR/test"
cat >"$DIR/sum.js" <<'JS'
// A deliberately wrong implementation, so the demo has a failure to capture.
exports.sum = (a, b) => a - b;
JS
cat >"$DIR/test/sum.test.js" <<'JS'
const test = require('node:test');
const assert = require('node:assert');
const { sum } = require('../sum');

test('adds two numbers', () => {
  assert.strictEqual(sum(2, 3), 5);
});

test('adds a negative number', () => {
  assert.strictEqual(sum(2, -3), -1);
});
JS
cat >"$DIR/package.json" <<'JSON'
{ "name": "sammy-demo-repo", "private": true, "scripts": { "test": "node --test" } }
JSON

git -C "$DIR" init -q -b main
git -C "$DIR" add .
git -C "$DIR" -c user.email=demo@example.test -c user.name=demo commit -q -m "demo: sum with a bug"

echo "✓ demo repository: $DIR"
echo "  use it as the \`repo\` input of worktree-test-demo"
