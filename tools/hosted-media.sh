#!/usr/bin/env bash
# Encode and bound the documentation media a hosted `demo` check produced. Called by
# tools/hosted-run.sh; allocates nothing itself. The recording is README documentation, not
# acceptance evidence.
set -euo pipefail
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:?pass the output directory of the demo check}"
for tool in ffmpeg ffprobe node; do
  command -v "$tool" >/dev/null || { echo "$tool is a caller-owned host tool and is required" >&2; exit 2; }
done

BUDGET="$SOURCE_ROOT/docs/media/budget.json"
read_budget() { node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]]))' "$BUDGET" "$1"; }
MAX_GIF="$(read_budget maxGifBytes)"
MAX_MP4="$(read_budget maxMp4Bytes)"

test -s "$DIR/hosted-demo.mp4" || { echo 'The demo produced no video' >&2; exit 1; }
MP4_BYTES="$(wc -c < "$DIR/hosted-demo.mp4")"
if [ "$MP4_BYTES" -gt "$MAX_MP4" ]; then
  echo "Demo MP4 is $MP4_BYTES bytes, over the $MAX_MP4 byte commit budget" >&2
  exit 1
fi

# GitHub renders a committed GIF inline in a README; an MP4 needs an upload or a
# release asset. Encode a bounded GIF beside the MP4 and step the size down
# rather than committing an unbounded animation.
encode_gif() {
  ffmpeg -hide_banner -loglevel error -y -i "$DIR/hosted-demo.mp4" \
    -vf "fps=$2,scale=$1:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
    "$DIR/hosted-demo.gif"
}
for step in "960 10" "800 10" "640 8" "480 6"; do
  # shellcheck disable=SC2086
  encode_gif $step
  GIF_BYTES="$(wc -c < "$DIR/hosted-demo.gif")"
  printf 'gif width/fps %s -> %s bytes\n' "$step" "$GIF_BYTES" >> "$DIR/gif-encoding.txt"
  if [ "$GIF_BYTES" -le "$MAX_GIF" ]; then break; fi
done
test "$GIF_BYTES" -le "$MAX_GIF" || {
  echo "Demo GIF is $GIF_BYTES bytes, over the $MAX_GIF byte commit budget" >&2
  exit 1
}
