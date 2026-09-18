# Preserved checkpoints — do not modify

Historical record. Nothing in here is regenerated, re-run or edited. New results
belong in a new `results/<date>-<label>/` directory.

| Path | What it is |
| --- | --- |
| `browserbase-continuation-04.zip` | Checkpoint 04, 133,654 bytes, SHA-256 `60c9fe45…`. Byte-exact as received. |
| `SHA256.json` | Per-entry manifest for that archive — 43 entries. |
| `CHECKPOINT-04.md` | The checkpoint's own README, as written when it was produced. |
| `patches/review.patch` | Full patch: clean upstream `ea53ea66…` → this package. 33 files, 3,584 insertions. |
| `patches/from-checkpoint03.patch` | Incremental patch: an existing checkpoint-03 overlay → checkpoint 04. |
| `probes/run.mjs` | The independent boundary harness used for the 66-case runs. |
| `runs/` | Historical logs from the environment that produced checkpoint 04 (Node 24.11.1, Bun 1.4.2). |
| `access/` | Historical `curl` failure records. **Superseded** — see below. |

Apply exactly one patch, never both: `review.patch` onto clean upstream, or
`from-checkpoint03.patch` onto an existing checkpoint-03 overlay.

## About `access/`

Those seven JSON files record `curl` exit 6 / "Could not resolve host" for
`codeload.github.com`, `registry.npmjs.org`, `nodejs.org` and `github.com`. They
are kept because they are honest evidence of what that environment could do.

They are **not** evidence about the inputs. On 2026-09-18, from an environment
with network access, the pinned upstream cloned successfully and all eight
canonical npm inputs resolved. See
[`../results/2026-09-18-github-session/canonical-inputs.json`](../results/2026-09-18-github-session/canonical-inputs.json).
