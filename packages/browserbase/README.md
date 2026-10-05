# effect-browserbase

[Browserbase](https://www.browserbase.com) for [effect-browser](../browser): hosted sessions as a
`Browser` layer, and an Effect client for the Browserbase REST API.

```sh
npm install effect-browserbase effect-browser effect playwright-core
```

- `Browserbase`: `open` and `layer` create a session and release it when their scope closes, so
  billing stops then rather than at the session's timeout. `attach` connects to a running session
  without taking ownership of it.
- `BrowserbaseClient`: sessions, Live View, stored contexts, Search and Fetch. `layerConfig()`
  reads `BROWSERBASE_API_KEY` and, optionally, `BROWSERBASE_BASE_URL`.
- `BrowserbaseError`: one error with a reason: `Unauthorized`, `NotFound`, `RateLimited`, `Status`,
  `Transport`, `Decode` or `InvalidRequest`.

The API key travels only in the `x-bb-api-key` header, which logs and traces redact, and the client
refuses redirects so the key never follows one. Only `GET` requests are retried, twice, after a
transient failure. Connect URLs and the Live View debugger URL are `Redacted`: keep them away from
models and logs.

The [repository README](https://github.com/mannyc2/effect-agent-browserbase#readme) has an example.
