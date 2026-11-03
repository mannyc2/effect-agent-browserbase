/** Connection identity uses the supplied SecureRandom service, or the host's Web Crypto on Node/Bun. */
import { Effect, Option } from "effect";
import { SecureRandom } from "effect/crypto";

import { Failed } from "../../BrowserError.ts";
import { undispatched } from "./context.ts";

const failed = () => undispatched("make", new Failed({ detail: "Could not name connection" }));

export const make = Effect.gen(function* () {
  const supplied = yield* Effect.serviceOption(SecureRandom.SecureRandom);

  return yield* Option.isSome(supplied)
    ? supplied.value.uuidV4()
    : // oxlint-disable-next-line no-restricted-properties -- this host fallback runs only when the captured SecureRandom service is absent
      Effect.try({ try: () => globalThis.crypto.randomUUID(), catch: failed });
});
