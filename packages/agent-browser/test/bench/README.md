# Watched-browsing bench

Unpublished tools for measuring browser activity shown in livestreams and films.
Scenes use the actual scoped browser owner, retained capture and independent
fixture truth. They measure picture delivery, canvas game operability, durable
plan replay, narration accuracy and sustained watched sessions. Results belong
to the exact source revision and backend recorded with each run.

From `packages/agent-browser`, using the pinned workspace. Replace `RUN` with a
recorded run directory in commands that consume an existing recording:

```sh
vp run bench scenes
vp run bench plan smoke --backend chromium --trials 3
vp run bench run smoke --backend chromium --trials 3 --out ../../.work/bench/runs
vp run bench report ../../.work/bench/runs/RUN
```

## Scenes and hosting

| Scenes                                    | Measurement                                                                                          | Backends                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `smoke`, `animation`                      | Changing-page cadence, gaps and capture cleanup                                                      | Chromium; Browserbase with the fixture bootstrap    |
| `busy`                                    | On-air animation while another page navigates, observes, takes a picture and replays a recorded plan | Chromium; Browserbase with the fixture bootstrap    |
| `typing`, `interstitials`                 | Ordered typing and holds; overlays, blank intervals and first frames                                 | Chromium; Browserbase with the fixture bootstrap    |
| `games-operability`                       | Seeded canvas reels and their HTML twin, including cookie and age gates                              | Chromium; Browserbase with explicit fixture tunnels |
| `replay-drift`, `replay-contention`       | Fresh-page replay after controlled changes, with landing truth and concurrent picture measurement    | Chromium                                            |
| `read-table`, `read-game`, `narrate-walk` | Narration facts checked against fixture truth                                                        | Chromium                                            |
| `game-segment`                            | Sustained canvas play, captions, picture cadence and result reaction timing                          | Chromium; Browserbase with explicit fixture tunnels |

`busy` accepts `--variant created-after`, `created-before` or `resume-after`.
`--style performed` also measures performed replay; the default style is `plain`.
`games-operability` accepts `--driver dom-twin`, `canvas-keys`, `canvas-click` or
`agent-tools`; its default `scripted` driver selects the HTML twin. Game segments
accept `--condition picture` or `digest`, `--max-spins`, `--announce-then-spin` and
`--air-delay-ms`. The delay is a caption eligibility threshold, not an audio or
video compositor.

Hosted stage scenes install the same controlled markup and truth binding through
the original owner's bootstrap. They require no separate fixture server or
`--fixture-origin` flag. Hosted game scenes require an explicitly supplied
`--fixture-tunnels /path/to/cloudflared` executable. Preparation starts two scoped
quick-tunnel children, validates their distinct HTTPS origins and updates the
original loopback game ledger before acquiring the browser. The frame and lobby
origins are qualified as configured cross-origin, operator-prepared origins;
distinct hostnames alone do not prove distinct public-suffix sites. The bench
does not install the tunnel executable. Use it within the operator's authorized
scope for exposing public fixtures.

Hosted replay and narration fixtures are currently rejected before allocation.
Ordinary acceptance runs do not qualify Browserbase behavior. Hosted runs need
`EFFECT_AGENT_BROWSERBASE_LIVE=1`, `BROWSERBASE_API_KEY` and
`BROWSERBASE_PROJECT_ID`. Every run closes its original owner; uncertain
allocation or unconfirmed release stops subsequent sessions.

## Records and measured intervals

Each run owns a new session and output directory. `record.json` records scene,
backend, settings, HEAD and whether source was dirty, events, truth, metrics,
reported model usage, capture metadata and checked cleanup. Source JPEGs remain
in `frames/`. Source state is evidence, rather than an execution prerequisite.
The bounded journal, input logger and frame sink report loss. Game input logs
retain their declared origins and `navigation-tail-unverified` completeness.

`--duration-ms` is bounded to 100–900,000 ms. The default game segment is ten
minutes; replay scenes allow fifteen minutes. Capture adds a 30-second margin,
up to fifteen minutes, and remote session lifetime adds another 60 seconds.
Retention allows at most 54,000 frames and 1 GiB; short runs use a 64 MiB byte
bound. `--capture-quality` changes retained JPEG quality, and game segments use a
lower default than other scenes. These caps bound retained evidence as well as
work; they do not promise a frame for every display tick.

Picture metrics use host monotonic delivery time. Capture is change-driven, so a
still document can send few frames. FPS measures delivered cadence, and does not
establish transport latency or website audio. Freeze metrics describe delivery
silence within declared changing intervals and count it once across overlaps.
Gap distributions include the initial and trailing window waits; separate
inter-delivery quantiles exclude those edges. Stage and contention metrics also
retain page-reported animation progress and visibility on the host receipt clock.
Progress reports inside a delivery gap distinguish observed page callback work
from missing deliveries. Absent reports leave page progress unverified;
requestAnimationFrame callbacks do not prove compositor painting, and delayed
or batched reports do not calibrate transport latency. Normal capture teardown
bookkeeping is reported separately from the completed scene work window.
Blank-frame measurements use bounded local pixel analysis;
overlay intervals also retain fixture truth. If capture ends or retention reaches
its frame or byte cap, later picture intervals are partial or unmeasured. A held
last frame after that cutoff is not evidence of a page freeze. Caption and game
truth can remain measured after picture retention stops.

Replay cells retain the failing step's original dispatch outcome, containment and
terminal Page phase. Known undispatched or rejected failures are refusals;
unknown mutations and performed actions with a later failure have separate
outcomes and are never replayed. A missing truth report is unverified, while a
completed run with a different reported destination is wrong-place. Controlled
drifts include independently observable decoy destinations, and redirect responses
cannot be cached into later cells. Counts distinguish unique walk/path/drift
conditions from repetitions on fresh Pages; seeds for fixed layouts are repeated
conditions, not new drift variants.

## Model input and spend

Paid model runs require the owner's approval of their printed plan,
`EFFECT_AGENT_BROWSER_BENCH_LIVE=1` and a positive `--max-usd` cap. Authorization
for included browser sessions does not authorize metered model or service calls.
Supply `--subject` with an ignored JSON specification using the `Subject` schema
in [Records.ts](Records.ts). It names the provider, model, gateway, output limit,
reasoning and service tier, plus dated rates in integer micro-dollars per million
tokens. Optional `exposure` supplies a dated maximum input allowance and rate
ceilings for the printed final-request estimate. These are operator-stated
limits, not a token preflight or provider billing guarantee. Keep selected
models and run proposals under `.work/bench/specs/`.

The narration matrix combines all three narration scenes and their `picture`,
`text` and `digest` conditions. `--trials N --matrix` selects nine groups of N
runs. One `--max-usd` ledger covers the whole invocation, including all matrix
cells; it is not renewed per cell. Separate invocations have separate caps.
`--matrix` does not expand game segment variants.

Set `APPROVED_CAP_USD` to the approved positive cap before printing a model plan:

```sh
vp run bench plan read-table --backend chromium --trials 20 --matrix \
  --subject ../../.work/bench/specs/subject.json --max-usd "$APPROVED_CAP_USD"
```

The cap checks estimated spend from reported usage before admitting the next
request. A final request can exceed it; `maxOutputTokens` bounds output including
reasoning. Missing usage stops further calls. Use rate ceilings that cover the
selected provider's input classes and long-context pricing when computing a
conservative proposal. Recorded estimates are not invoices. Candidate models
stay Luna-priced unless the owner authorizes another comparison.

The drivers preserve OpenAI Responses, Anthropic and OpenRouter vendor pinning.
They capture a new viewport PNG before every model call, including calls after
tool execution, and load it as transient context rather than accumulating old
pictures in history. `--picture-scale half` is the default; `full` preserves the
viewport image. The context states the conversion to main-viewport CSS pixels.
Narration `text` includes up to 4,000 UTF-8 bytes of page text; `digest` adds
host-authored action, outcome and timeline facts. Scripted answers verify the
plumbing and graders, and do not measure a real model's accuracy or cost.

## Film, motion and blind clips

These commands consume retained files after the browser has closed. They need
local `ffmpeg` and `ffprobe`; they do not allocate another browser or call a model.

```sh
vp run bench film ../../.work/bench/runs/RUN
vp run bench motion ../../.work/bench/candidate-input.json \
  --human ../../.work/bench/human-input.json
vp run bench clip ../../.work/bench/runs/RUN/film/raw.mp4 \
  --samples ../../.work/bench/cursor-samples.json --out ../../.work/bench/clip
```

`film` creates raw and commentary MP4s, captions and timing metadata from the
retained JPEG interval. `motion` accepts arrays of `InputEvent`, such as the
`events` array of an input-log snapshot. It reports sampled movement, dwell,
keyboard, scroll and idle statistics; `--human` adds empirical KS distances and
sample counts. DOM target width supports a Fitts index; canvas target width is
unavailable. Untrusted events and frame-local coordinates do not become measured
main-viewport pointer paths.

`clip` accepts `CursorSample[]`. [Clip.ts](Clip.ts) supplies conversions from
trusted input logs or a timeline with an explicit clock bridge. Native samples,
commanded points and intended schedules keep their separate qualifications.
Intended glides are not measured physical paths. Click pulses for every comparison arm
come from trusted source-time pointerdown samples; a native-call completion interval
cannot time a pulse. Movement duration excludes the subsequent pre-click dwell.
The renderer applies the same
cursor and press artwork to each arm, strips audio and metadata, and verifies
geometry, duration and complete decode. Clips are at most fifteen seconds.

Prepare an ignored panel specification containing `{seed, clips:[{arm,path}]}`,
where each arm is `human`, `plain`, `performed` or `tuned`:

```sh
vp run bench panel prepare ../../.work/bench/panel-spec.json --out ../../.work/bench/panel
vp run bench panel serve ../../.work/bench/panel --port 4112
vp run bench panel report ../../.work/bench/panel
```

Preparation copies bounded clips under anonymous names and records checksums.
The server shows only anonymous clip URLs and stores person-or-bot guesses and
naturalness ratings in `ratings.json`; duplicate rater/clip answers are refused.
The CLI prints the mirrored HTTPS URL returned by `dev-url`. Reports retain
participating rater counts and conservative 95% Hoeffding bounds over independent
bounded rater means. Agreement in a small panel retains uncertainty, and repeated
clips do not increase the independent sample count. Empty or
partial ratings remain identified as such.

`run` checks local FFmpeg and FFprobe before fixture preparation, tunnel startup,
browser allocation or inference. The printed plan includes the selected picture scale.

## Human comparison

[HumanReference.ts](HumanReference.ts) supplies a scoped Live View operator
protocol, not an unattended CLI scene. Only its terminal-side callback receives
redacted bearer Live View URLs. Both modes require an explicit operator release
message; a timeout or cancellation closes the original owner and records failure.

The `reference` handoff mode stops capture and pauses binding admission before
operator control, then resumes with fresh Pages after release. It records
`humanFootage: "unavailable"` and `panelEligible: false` for that capture gap.

The separate `operatorOnlyReference` mode issues `browser.liveView` while
capture and the origin-limited input binding remain active on the exact on-air
Page. The host runs no automation or model calls during operator control and
closes the original owner after release. This is an operator-only host protocol;
it does not pause browser admission or grant a handoff token. The optional
`openOperatorOnlyReference` helper permits only its initial navigation.

Retained operator footage includes the complete captured scene, native input
samples and cursor timing against the browser-reported shared Unix epoch. Known
capture or input loss, incomplete capture and protocol failures prevent panel
eligibility. Upstream frame loss remains unknown, navigation tails are unverified
and the shared epoch is not an independent clock calibration. Unpaid protocol
fixtures always remain panel-ineligible. Actual owner-operated Browserbase
reference tasks, matched agent clips and real panel ratings are still outstanding;
synthetic logs cannot establish human likeness or justify a tuned profile.

Generated records, specifications, panel data and media stay ignored under
`.work/` or in acceptance artifacts. The former nine-case evaluation and its
pilots remain in Git history at `1ed8259`.
