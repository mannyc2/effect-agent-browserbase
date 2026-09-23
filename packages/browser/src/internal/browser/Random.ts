import { type Crypto, Effect } from "effect";

/**
 * A fresh UUIDv4 from the consumer's `Crypto` service. Without secure random bytes no browser can
 * be owned safely, so a failure here is a defect rather than a typed browser error.
 */
export const randomUuid = (crypto: Crypto.Crypto): Effect.Effect<string> =>
  Effect.orDie(crypto.randomUUIDv4);
