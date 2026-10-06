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
refuses redirects so the key never follows one. Each request attempt has a deadline
(`requestTimeout`, 60 seconds by default), so a session create that never answers still settles
and its caller can stop. Only `GET` requests are retried, twice, after a transient failure; a
create that fails in transit is not resent, because it may have created the session. Connect URLs and the Live View debugger URL are `Redacted`: keep them away from
models and logs. A failed connect names only the connect URL's scheme, host and port.

The [repository README](https://github.com/mannyc2/effect-agent-browserbase#readme) has an example.
