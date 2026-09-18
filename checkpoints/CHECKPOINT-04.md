# Browserbase continuation checkpoint 04

Continues the exact recovered checkpoint 03 overlay. The baseline ZIP SHA-256 remains
a2ce91785f72a8f05bca45a0f7cd4c31b5c33e69980fa4392e25780dac9fee31.
This is a source checkpoint, NOT an upstream-applied or compiled official package.

The entire upstream tree is still unavailable to this runtime. `review.patch` adds the
current package to ea53ea6671a94eb44b8019e942cc2c9468786723; apply it ONCE to a verified
clean upstream (never together with the original review.patch). `from-checkpoint03.patch`
is instead the minimal delta for an existing checkpoint-03 overlay. Neither represents
an executed application against the full upstream.

New independently executed Effect boundary results: 66/66 on Node 24.11.1 and
66/66 on Bun 1.4.2. Three retired-connection callback regressions failed before the fix.
These tests use authentic Effect rc.115 with scripted provider/native boundaries, not
a substitute AgentRuntime. They do not establish TypeScript/repository/framework/native
browser acceptance. Original checkpoint 03 and all historical logs remain unchanged.

Changes: project interactive options before HTTP-only validation; bind native callbacks
to their connection lease; fail closed on operator pause during setup; assert credentials
on the actual fetch RequestInit rather than Bun's reconstructed Request accessor.
New tests also verify that current-connection events still invalidate/fence correctly.

No paid or hosted Browserbase session, model call, publication, or deployment was run.
