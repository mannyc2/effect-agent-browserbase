# Examples

Everything here uses only the package's public entry points, is compiled against
the packed tarball in acceptance, and allocates nothing on import. The paid
hosted checks are not examples; they live in [`../hosted/`](../hosted/) and run
only through `tools/hosted-run.sh`.

| Example                                             | What it shows                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`workflows.ts`](workflows.ts)                      | Five compositions on one account: inspect a page, a cooperative Live View handoff, a persistent-context writer that detaches and reconnects, a website download, and recording retrieval after the browser scope has ended. Each is a function taking credentials.                           |
| [`record-video.ts`](record-video.ts)                | Caller-owned encoding of one live capture interval with FFmpeg, then decoding every frame back to check presentation times and pixel checksums. [`capture-evidence.ts`](capture-evidence.ts) is its fixed-size failure record. `test/native/video.test.ts` runs it against a local Chromium. |
| [`demo-recording.ts`](demo-recording.ts)            | A bounded demo interval — navigate, scroll, capture — on top of `record-video.ts`. `test/native/demo.test.ts` proves the pacing locally so the hosted `demo` check spends its session on publishing, not discovery.                                                                          |
| [`realistic-footage/`](realistic-footage/README.md) | A storyboard filmed with a drawn pointer, real keys at a typist's cadence and eased scrolling, resampled onto a constant-rate reel. The film in `docs/media/` came from it.                                                                                                                  |

For model-driven control of the same session, see the adapter package's
[`examples/agent.ts`](../../agent-browserbase/examples/agent.ts).
