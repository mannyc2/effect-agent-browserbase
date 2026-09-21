# Documentation media

This directory is the one place in the repository where generated binary output
is committed. Everything else generated stays ignored and lives in Actions
artifacts. The exception exists so the README can show a real recording of a
real hosted Browserbase session; it is not a general dumping ground for build
products.

## Rules

- Only files produced by the `demo` check (`tools/hosted-run.sh`) from a commit on `main`,
  and the one local film named under [The local film](#the-local-film) below.
- Only the extensions and sizes declared in [`budget.json`](budget.json).
  `tools/test/hosted.test.mjs` enforces that budget and fails ordinary unpaid CI
  if documentation references media that is not committed.
- Preserve the caller-encoded MP4 without manual edits or compositing. The
  script-derived GIF is an explicitly rescaled, frame-rate-reduced preview,
  not a lossless frame or timing record. Retain the producing commands and
  distinguish capture accounting from decoded output accounting.
- Never a recording of a page showing credentials, a Live View URL, a signed
  artifact URL or private content. `BROWSERBASE_DEMO_URL` must be a public page.

## The committed recording

| | |
| --- | --- |
| Source commit | `d5892f2f7e1bdaf06c99f210891af6d7b0750a05` |
| Session | `1fcd0607-cffb-4c48-918a-bf1d999fd332` |
| Runtime | Bun 1.4.2, Playwright 1.63.0, effect-agent 0.1.0-beta.102, Effect 4.0.0-rc.115 |
| Target | `https://github.com/mannyc2/effect-agent-browserbase` |
| Actions | one navigation, four bounded scrolls, one observation |
| Capture | 31 received, 31 delivered, 0 dropped, 0 duplicates, `nativeStop: "confirmed"` |
| Encoded | 27 decoded frames, 27 distinct pixel checksums, 800×450, no audio stream |
| `hosted-demo.mp4` | `f001be8a52cb899ffb96c8359d44aeec3c268ffd82cb3deb682918ccb4562c3e` |
| `hosted-demo.gif` | `f9a6368975949e2ddb05d065207dfe0ca9691ffde71a3216f642871fbdda49fd` |

This file **deviates from the first rule above** and the deviation is deliberate,
not an oversight. It was produced by running `examples/hosted-demo.ts` (now the `demo` check)
directly from the branch head, not by the hosted runner from a commit on `main`,
because the `Hosted Browserbase` workflow's protected environment and secrets
are not configured yet, and the wrapper additionally requires a bootstrapped
upstream worktree. The GIF was encoded with the exact ladder from that script
and was accepted on its first rung, 960px at 10fps.

The table is maintainer-reported run provenance; the committed bytes and their
hashes are independently inspectable. It does not replace retained provider
responses, nor establish that every original capture callback became a decoded
frame: the reported counts are 31 delivered callbacks versus 27 decoded frames.
Re-recording through the workflow once its environment exists should replace
this file rather than sit beside it; it requires separate hosted authorization.

The committed MP4 is 800×450. Playwright's default screencast sizing fits within
800×800; this is consistent with the observed geometry, not evidence that the
public adapter exposes size controls. The GIF is separately scaled by its
preview-encoding command.

## The local film

`realistic-footage.mp4` and its GIF preview are the output of
[`examples/realistic-footage`](../../packages/browserbase/examples/realistic-footage/README.md):
a storyboard performed with a drawn pointer, paced typing and eased scrolling,
filmed across one navigation.

It is **not hosted evidence** and supports no claim in [STATUS.md](../STATUS.md).
It was filmed by `test/native/realistic-footage.test.ts` against a local Chromium
over real CDP, with provider allocation scripted as in every native test, from
the source in the commit that added the file. The page it shows is the example's
own fictional `StageSite.ts`, served from loopback. No Browserbase session,
credential or model was involved.

| | |
| --- | --- |
| Runtime | Node 24.14.1, Playwright 1.63.0, Chromium 153.0.8010.12, Effect 4.0.0-rc.115 |
| Seed | `night-rail-atlas` |
| Actions | one navigation, four native pointer moves, six fills, three clicks, one click-and-wait |
| Capture | two intervals, 0 dropped, both `nativeStop: "confirmed"`, 70 ms uncovered at the cut |
| Measured | capture latency p50 5.6 ms against a clock offset of −0.5 ± 0.9 ms; loopback, one machine |
| Encoded | 554 decoded frames, 18.5s, 1280×720, constant 30 fps, h264 `yuv420p`, no audio stream |
| `realistic-footage.mp4` | `6990c343b84a277d5de913b6d189e248d6fe8c1610d6585c63a74a2dcefe1a6d` |
| `realistic-footage.gif` | `26b83d0c560638be38682495a18d03a38a5f3ac26266c6bf42c20919814921f1` |

The seed fixes every path and pause, but not the bytes: frame delivery follows
Chromium's own repaint schedule, so a retake is the same performance with a
different checksum. To retake it, set `REALISTIC_FOOTAGE_DIR` and run that test
(see the example's README), then derive the preview:

```sh
ffmpeg -i realistic-footage.mp4 -vf "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" realistic-footage.gif
```

## Producing the recording

The recording requires a paid Browserbase session, so it is never produced by
ordinary CI. Run the **Hosted Browserbase** workflow manually with `checks: demo`
(see [hosted testing](../HOSTED.md)), download its artifact, and commit the
files you want from it:

```sh
# From the downloaded artifact directory.
cp demo/hosted-demo.gif demo/hosted-demo.mp4 docs/media/
```

`demo.jsonl`, `source-sha.txt` and `SHA256SUMS` from the same artifact
identify the exact source commit, session, capture summary and decoded frame
counts behind the recording. Cite that run in the pull request that commits the
media; do not commit the records themselves.

## Referencing it

GitHub renders a committed GIF inline from a relative path. Add this to the root
`README.md` once `hosted-demo.gif` is committed:

```md
![A hosted Browserbase session navigating and scrolling under Effect Agent control](docs/media/hosted-demo.gif)
```

Delete the "No recording is committed yet" paragraph in the same section when
you add it. Keep the alt text descriptive. The MP4 is the higher-quality copy; link it
rather than embedding it, because a relative `<video>` source does not play
reliably in GitHub's README renderer:

```md
[Higher-quality MP4](docs/media/hosted-demo.mp4)
```

Reference media only from repository documentation. The npm package publishes
`dist`, its own README and the license; a relative media path in the package
README would resolve to nothing on the registry page.
