# Demos

A static site that replays recorded bench runs. Each replay is the browser's own screencast as
video, with what the recording holds drawn over it in the viewer's browser: the pointer along the
path effect-browser planned, presses, wheels and typed keys, a timeline of actions, model turns and
moment windows, the pictures a model was shown, and the run's grade against the page's truth.

Replays are made in three steps, from the repository root:

```sh
# 1. Record. Scripted runs are free; model runs need the bench's opt-ins.
cd bench && bun run bench run --task checkout --record --humanize

# 2. Pack one trial's recording into public/replays/<id>/ (needs ffmpeg).
cd ../demos && bun run pack -- ../.work/bench/<results>/checkout-1 checkout-human

# 3. Look.
bun run dev
```

`src/catalog.ts` names the demos, the replay ids each one shows and the words a visitor reads;
`src/present.ts` turns recorded calls, answers and times into those words. A demo appears on the
built site only once every replay in it is packed, so the catalog can name runs before they exist;
the dev server lists the missing ones with the commands that record them.

Packing keeps the frames the latest event's page painted, so a background tab never flashes into
view, and encodes them as H.264 at their recorded times, to the millisecond. `replay.json` holds the
recording without its frame list, plus where the video starts on the recording's host clock.

`public/replays/` is ignored by git. `bun run build` writes the site to `dist/`, with the packed
replays copied in, so any static host can serve that one directory.
