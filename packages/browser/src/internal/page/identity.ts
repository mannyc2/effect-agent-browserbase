/** Connection identity uses the supplied Crypto service, or the host's Web Crypto on Node/Bun. */
import { Crypto, Effect, Option } from "effect";

import { Failed } from "../../BrowserError.ts";
import { undispatched } from "./context.ts";

const failed = () => undispatched("make", new Failed({ detail: "Could not name connection" }));

export const make = Effect.gen(function* () {
  const supplied = yield* Effect.serviceOption(Crypto.Crypto);

  return yield* Option.isSome(supplied)
    ? supplied.value.randomUUIDv4.pipe(Effect.mapError(failed))
    : // oxlint-disable-next-line no-restricted-properties -- this host fallback runs only when the captured Effect Crypto service is absent
      Effect.try({ try: () => globalThis.crypto.randomUUID(), catch: failed });
});
