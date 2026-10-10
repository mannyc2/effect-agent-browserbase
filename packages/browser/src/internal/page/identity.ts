/** Connection identity uses the supplied Crypto service, or the host's Web Crypto on Node/Bun. */
import { Crypto, Effect, Option, PlatformError } from "effect";

import { Failed } from "../../BrowserError.ts";
import { undispatched } from "./context.ts";

// The core owns this tiny platform adapter to keep Chromium/CDP usable without another package
// or a new required service. Browser construction captures it once; there is no global counter.
const native = () =>
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: () => globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data)),
        catch: (cause) =>
          PlatformError.systemError({
            module: "Crypto",
            method: "digest",
            _tag: "Unknown",
            description: "Could not compute digest",
            cause,
          }),
      }).pipe(Effect.map((bytes) => new Uint8Array(bytes))),
  });

export const make = Effect.gen(function* () {
  const supplied = yield* Effect.serviceOption(Crypto.Crypto);
  const crypto = Option.getOrElse(supplied, native);

  return yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() =>
      undispatched("make", new Failed({ detail: "Could not name connection" })),
    ),
  );
});
