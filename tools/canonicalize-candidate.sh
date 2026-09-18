#!/usr/bin/env bash
# One-shot recovery helper for PR #3. It applies only failures observed in the
# pinned unpaid Actions logs, then delegates formatting/lint fixes to upstream's
# exact Vite+/Oxfmt/Oxlint configuration. The workflow removes this helper once
# its canonical output has been committed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${RUNNER_TEMP:?}/browserbase-canonicalize"
TREE="$WORK/tree"

bash "$ROOT/tools/bootstrap.sh" "$WORK"

python3 - "$TREE" <<'PY'
from pathlib import Path
import sys

tree = Path(sys.argv[1])

# Node 24's native TypeScript strip-only mode does not support parameter
# properties. Keep the helper ordinary erasable TypeScript.
p = tree / "packages/platform-browserbase/src/internal/CallbackTasks.ts"
s = p.read_text()
old = '''export class CallbackTasks {\n  private readonly pending = new Set<Promise<void>>();\n  private stopped = false;\n  private faulted = false;\n\n  constructor(private readonly capacity: number, private readonly onFault: () => void) {\n    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Invalid callback capacity");\n  }\n'''
new = '''export class CallbackTasks {\n  private readonly pending = new Set<Promise<void>>();\n  private readonly capacity: number;\n  private readonly onFault: () => void;\n  private stopped = false;\n  private faulted = false;\n\n  constructor(capacity: number, onFault: () => void) {\n    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Invalid callback capacity");\n    this.capacity = capacity;\n    this.onFault = onFault;\n  }\n'''
if old in s:
    p.write_text(s.replace(old, new))
elif new not in s:
    raise SystemExit("CallbackTasks source no longer matches the diagnosed boundary failure")

# The driver already uses CDPSession; import its public Playwright 1.63 type.
p = tree / "packages/platform-browserbase/src/internal/Playwright.ts"
s = p.read_text()
old = 'import type { Browser, BrowserContext, Dialog, Download, ElementHandle, Frame, JSHandle, Page } from "playwright-core";'
new = 'import type { Browser, BrowserContext, CDPSession, Dialog, Download, ElementHandle, Frame, JSHandle, Page } from "playwright-core";'
if old in s:
    p.write_text(s.replace(old, new))
elif new not in s:
    raise SystemExit("Playwright import no longer matches the diagnosed typecheck failure")

# maxFrames is the bounded in-memory frame queue, not the intended total video
# length. The implementation deliberately caps it at 64 while the stream is
# consumed concurrently.
p = tree / "packages/platform-browserbase/examples/record-video.ts"
s = p.read_text()
if "maxFrames: 600," in s:
    p.write_text(s.replace("maxFrames: 600,", "maxFrames: 64,"))
elif "maxFrames: 64," not in s:
    raise SystemExit("record-video example no longer matches the diagnosed capture failure")
PY

cd "$TREE"
# Use the exact formatter/linter versions and configuration from pinned upstream.
./node_modules/.bin/vp check --fix

python3 - "$ROOT" "$TREE" <<'PY'
from pathlib import Path
import shutil, sys
root, tree = map(Path, sys.argv[1:])
src = tree / "packages/platform-browserbase"
dst = root / "packages/platform-browserbase"
shutil.rmtree(dst)
shutil.copytree(src, dst, ignore=shutil.ignore_patterns("node_modules", "dist", "downloads"))
PY

# Integration-only changes live as a patch because this repository intentionally
# stores only the owned package plus its pinned upstream integration delta.
git -C "$TREE" diff --binary -- \
  .changeset/browserbase-interactive.md \
  .changeset/config.json \
  package.json \
  docs/guide/browser.md \
  bun.lock > "$ROOT/upstream.patch"

# Refuse accidental mutation outside the owned candidate and integration patch.
cd "$ROOT"
git diff --exit-code -- checkpoints >/dev/null
git status --short
