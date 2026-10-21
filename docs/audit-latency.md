# Reviewed timing assertions

The timing inventory in `testing/ours.md:288–294` names eighteen locations at
reviewed commit `473222529715f67709493def4c30d2419e1f4742`. Seventeen are real
elapsed-time bounds. `ContextLease.test.ts:64` already limits a loop advanced by
`TestClock.adjust("1 millis")`; inspecting that exact commit confirms it is not a
wall-clock assertion. That finding is rejected with evidence, and the virtual
writer-completion regression remains unchanged.

Normal tests retain the native behavior below. Machine-latency envelopes run only
with `bun run test:latency`, which selects `test/**/*.latency.ts` serially through
`packages/browser/vite.latency.config.ts`. Ordinary `ready` continues selecting
`test/**/*.test.ts`; no timeout, retry count or production source was changed.
The latency suite uses local Chromium and the loopback site, with no hosted or
model calls.

| Reviewed location | Normal-test evidence after migration | Optional latency evidence |
| --- | --- | --- |
| Admission:533 | An entered shared read loses its last waiter; the following write returns after canceling the abandoned read. Deferred entry replaces a sleep. | No machine bound needed. |
| Admission:679 | Another page completes a click while a dropped input reply/retry remains pending; the retry times out on the owning TestClock. | No machine bound needed. |
| Admission:713 | Another page completes a click while navigation and its queued input are held at the owned protocol port. | No machine bound needed. |
| Admission:716 | Queued input remains pending at 1,999 virtual ms and fails Busy at 2,000, with one predecessor. | No machine bound needed. |
| Admission:719 | A fail-fast snapshot returns Busy without advancing the frozen owning clock or releasing navigation. | No machine bound needed. |
| Admission:744 | Another page navigates successfully before a held native key receipt is released. | No machine bound needed. |
| Admission:768 | Another page clicks while the first performed-typing receipt and its fixed 9,420-ms schedule remain pending. | No machine bound needed. |
| Admission:787 | Page allocation stays pending at 499 virtual ms, fails Limit at 500, and later succeeds when a page closes. | No machine bound needed. |
| Admission:788 | Fail-fast page allocation returns Limit without advancing the owning clock. | No machine bound needed. |
| Admission:818 | Browser-maintained title is readable while the same page's script reply is held. | Original busy-renderer title under 1,000 ms. |
| Page:1035 | A fetch-triggering click returns while its loopback HTTP response is explicitly held; releasing the response produces the next page. | Original click under 400 ms. |
| Page:1046 | History-only and 204 navigation retain the expected page content. | Original click under 1,000 ms for both cases. |
| Page:1061 | Ten completed clicks produce ten acknowledged Action records and the expected DOM content. | Original ten-click envelope under 1,200 ms. |
| Policy:640 | Paste preserves all text, consults the guard once and emits one TextInserted event. | Original guarded paste under 2,000 ms. |
| Policy:801 | A policy-held action remains pending after 500 virtual ms, beyond its action deadline; hover remains usable, and release permits the guarded action. | No machine bound needed. |
| Cdp:97 | A dropped viewport reply stays pending at 999 virtual ms and fails undispatched Timeout at 1,000; the failed scroll is recorded once. | Original actually busy-renderer scroll and viewport calls under 1,800 ms each. |
| Capture:595 | Native capture still delivers valid timing/currency evidence from a renderer with long tasks. | Original clock-uncertainty upper envelope of 450 ms. |

Later explicit cases covered by the same split are the repeated-document
`until` 600-ms envelope, local `state` under a held input receipt (formerly a
500-ms upper envelope), repeated-commit content readiness under 1,500 ms, and
the frame/presentation envelopes listed by the neighboring native latency suite.
The repeated-document normal test still requires an unmet result, so resetting
its deadline continues to fail behaviorally. Content readiness still requires a
typed Timeout while document commits keep restarting, and retains its real
browser quiet-duration lower bounds.

This is a bounded migration of the reviewed inventory. Other existing timing
checks in Connector, Presentation and CaptureConnection were not part of that
inventory and remain in ordinary tests. Browser timestamp calibration tolerances,
causal submission-before-receipt comparisons, explicit simulated-clock checks,
renderer quiet-duration lower bounds and planned input timestamp relationships
also remain. This work does not claim that every ordinary test is independent of
local Chromium or that all wall-clock assertions have been removed.
