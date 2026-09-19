# Documentation media

This directory is the one place in the repository where generated binary output
is committed. Everything else generated stays ignored and lives in Actions
artifacts. The exception exists so the README can show a real recording of a
real hosted Browserbase session; it is not a general dumping ground for build
products.

## Rules

- Only files produced by `tools/hosted-demo.sh` from a commit on `main`.
- Only the extensions and sizes declared in [`budget.json`](budget.json).
  `tools/test/hosted.test.mjs` enforces that budget and fails ordinary unpaid CI
  if documentation references media that is not committed.
- Never a hand-edited, re-timed, sped-up or composited recording. The file must
  be exactly what the run produced, so the video is evidence rather than
  marketing.
- Never a recording of a page showing credentials, a Live View URL, a signed
  artifact URL or private content. `BROWSERBASE_DEMO_URL` must be a public page.

## Producing the recording

The recording requires a paid Browserbase session, so it is never produced by
ordinary CI. Run the **Hosted Browserbase** workflow manually with `run: demo`
(see [hosted testing](../HOSTED.md)), download its artifact, and commit the
files you want from it:

```sh
# From the downloaded artifact directory.
cp hosted-demo.gif hosted-demo.mp4 docs/media/
```

`hosted-demo.jsonl`, `source-sha.txt` and `SHA256SUMS` from the same artifact
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
