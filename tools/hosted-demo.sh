#!/usr/bin/env bash
# Guarded hosted demo recording. NOT run by ordinary CI.
# Budget: one Browserbase session, <=120s browser lifetime, <=10 actions,
# <=15s live capture, no provider recording request or download, zero model
# calls. This produces README documentation media, not acceptance evidence;
# tools/hosted-acceptance.sh remains the separate correctness run.
set -euo pipefail
test "${EFFECT_AGENT_BROWSERBASE_LIVE:-}" = 1 || {
  echo "Refusing hosted Browserbase allocation without EFFECT_AGENT_BROWSERBASE_LIVE=1" >&2
  exit 2
}
: "${BROWSERBASE_API_KEY:?BROWSERBASE_API_KEY is required}"
: "${BROWSERBASE_PROJECT_ID:?BROWSERBASE_PROJECT_ID is required}"
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TREE="${1:?pass the patched effect-agent worktree}"
OUT="${2:?pass an output directory for the recording}"
for tool in ffmpeg ffprobe node git; do
  command -v "$tool" >/dev/null || { echo "$tool is a caller-owned host tool and is required" >&2; exit 2; }
done
test ! -e "$OUT" || { echo "Refusing existing demo output: $OUT" >&2; exit 1; }
mkdir -p "$OUT"
# The example runs from inside the worktree and resolves its output path against
# the process directory, so a relative destination must be pinned down here.
OUT="$(cd "$OUT" && pwd)"

BUDGET="$SOURCE_ROOT/docs/media/budget.json"
read_budget() { node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]]))' "$BUDGET" "$1"; }
MAX_GIF="$(read_budget maxGifBytes)"
MAX_MP4="$(read_budget maxMp4Bytes)"

# Identify the exact source that produced the media, so a committed recording is
# never mistaken for evidence from some other revision.
git -C "$SOURCE_ROOT" rev-parse HEAD > "$OUT/source-sha.txt"

(
  cd "$TREE/packages/platform-browserbase"
  BROWSERBASE_DEMO_OUTPUT="$OUT/hosted-demo.mp4" \
    ../../node_modules/.bin/vp exec bun examples/hosted-demo.ts
) | tee "$OUT/hosted-demo.jsonl"

test -s "$OUT/hosted-demo.mp4" || { echo 'The demo produced no video' >&2; exit 1; }
MP4_BYTES="$(wc -c < "$OUT/hosted-demo.mp4")"
if [ "$MP4_BYTES" -gt "$MAX_MP4" ]; then
  echo "Demo MP4 is $MP4_BYTES bytes, over the $MAX_MP4 byte commit budget" >&2
  exit 1
fi

# GitHub renders a committed GIF inline in a README; an MP4 needs an upload or a
# release asset. Encode a bounded GIF beside the MP4 and step the size down
# rather than committing an unbounded animation.
encode_gif() {
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/hosted-demo.mp4" \
    -vf "fps=$2,scale=$1:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
    "$OUT/hosted-demo.gif"
}
for step in "960 10" "800 10" "640 8" "480 6"; do
  # shellcheck disable=SC2086
  encode_gif $step
  GIF_BYTES="$(wc -c < "$OUT/hosted-demo.gif")"
  printf 'gif width/fps %s -> %s bytes\n' "$step" "$GIF_BYTES" >> "$OUT/gif-encoding.txt"
  if [ "$GIF_BYTES" -le "$MAX_GIF" ]; then break; fi
done
test "$GIF_BYTES" -le "$MAX_GIF" || {
  echo "Demo GIF is $GIF_BYTES bytes, over the $MAX_GIF byte commit budget" >&2
  exit 1
}

(
  cd "$OUT"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)
printf '\nDemo recording: %s\n' "$OUT"
