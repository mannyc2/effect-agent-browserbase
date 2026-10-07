# effect-browser-human-strokes

Optional recorded pointer motion for `effect-browser`. The package replaces the pointer planner
with a bundled library of 32,130 human strokes. It does not change typing, pauses or input policy.

```sh
npm install effect-browser-human-strokes@beta effect-browser@beta effect playwright-core
```

```ts
import { Effect } from "effect";
import * as HumanStrokes from "effect-browser-human-strokes";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";

const browser = HumanStrokes.provideTo(Chromium.layer({ humanize: true }));

const program = Effect.gen(function* () {
  const page = yield* (yield* Browser).page;
  yield* page.goto("https://example.com");
  yield* page.hover({ x: 400, y: 300 });
}).pipe(Effect.provide(browser));
```

**Provide the strokes to the layer that builds the browser.** A browser reads its pointer planner
once, when it is built. `HumanStrokes.provideTo(browserLayer)`, which accepts only a layer that
builds a `Browser`, is the same as `browserLayer.pipe(Layer.provide(HumanStrokes.layer))`.
Placing `HumanStrokes.layer` beside the browser instead, as in
`Layer.merge(browserLayer, HumanStrokes.layer)` or
`Effect.provide(program, [browserLayer, HumanStrokes.layer])`, still loads the data but builds
the browser without it, so it silently keeps the default planner.

The layer reads, decompresses and validates its fixed package asset when constructed. Loading
failures are typed `DataError` values. There is no download, file-path option or configuration
step. Decompression runs on Node's thread pool rather than the event loop, and the built planner
keeps only the validated payload. Each plan decodes only its selected stroke. The single Brotli
asset is 3,152,464 bytes; the validated payload is 10,411,952 bytes. The core browser package
does not include this data.

Selection draws uniformly among strokes whose endpoint distances differ by less than 0.15 in
absolute log ratio, or chooses the nearest absolute distance when none qualify. The selected
geometry is rotated, scaled and randomly mirrored, with an exact final destination. Distances
below two pixels use an immediate endpoint. Original sample times, including fractional
milliseconds and equal-time samples, are retained. No resampling or time scaling is applied.

The library contains 2,604,684 points, with at most 1,604 samples and less than 5,000 milliseconds
per stroke. Humanization describes presentation behavior; this package makes no identity,
anti-detection or universal realism claim.

## Data attribution

The bundled data derives from the **BOUN Mouse Dynamics Dataset**, version 2, by
**Metehan Yıldırım, Arjen Aykan Kılıç and Emin Anarım**, published 26 March 2021:

- Dataset and license: https://data.mendeley.com/datasets/w6cxr8yc7p/2
- DOI: https://doi.org/10.17632/w6cxr8yc7p.2
- License: Creative Commons Attribution 4.0 International,
  https://creativecommons.org/licenses/by/4.0/

Changes: browsing click strokes from three source participants were selected; the initial
two percent of traveled distance and repeated ending positions were trimmed; strokes shorter
than 30 pixels or lasting 5 seconds or more were excluded. Coordinates and times were made
relative to the first retained sample. Integer-coordinate deltas and exact 1/4096-millisecond
time residuals were encoded and Brotli-compressed. Participant identifiers and unrelated
records are not included. These are transformed recordings, not original dataset files.

Code is MIT-licensed. The derived data remains CC BY 4.0; see `LICENSE-data`.
