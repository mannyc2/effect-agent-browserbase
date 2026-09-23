import { Crypto, Effect, PlatformError } from "effect";

/**
 * A `Crypto` whose bytes count up from one, so every id and handoff token a scripted browser draws
 * is predictable. It is not random and computes no digest.
 */
export const makeSequentialCrypto = (): Crypto.Crypto => {
  let draws = 0;

  return Crypto.make({
    randomBytes: (size) => {
      const bytes = new Uint8Array(size);
      let rest = ++draws;

      for (let index = size - 1; index >= 0 && rest > 0; index--) {
        bytes[index] = rest % 256;
        rest = Math.floor(rest / 256);
      }

      return bytes;
    },
    digest: () =>
      Effect.fail(
        PlatformError.badArgument({
          module: "Crypto",
          method: "digest",
          description: "A scripted browser's Crypto computes no digest",
        }),
      ),
  });
};
