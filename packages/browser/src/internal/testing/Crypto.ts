import { Crypto, Effect, PlatformError } from "effect";

/**
 * A `Crypto` whose bytes count up from one, so every id and handoff token a scripted browser draws
 * is predictable. A namespace occupies UUID bytes untouched by its version/variant bits.
 * It is not random and computes no digest.
 */
export const makeSequentialCrypto = (namespace = 0): Crypto.Crypto => {
  let draws = 0;

  return Crypto.make({
    randomBytes: (size) => {
      const bytes = new Uint8Array(size);
      let rest = ++draws;

      for (let index = size - 1; index >= 0 && rest > 0; index--) {
        bytes[index] = rest % 256;
        rest = Math.floor(rest / 256);
      }
      let scope = BigInt(namespace);

      for (let index = 0; index < size - 8 && scope > 0n; index++) {
        if (index === 6) continue;
        bytes[index] = Number(scope % 256n);
        scope /= 256n;
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
