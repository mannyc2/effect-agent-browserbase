// The livestream on a self-managed Chromium. The caller provides the agent's and the narrator's
// `LanguageModel` and the platform's services, for example `NodeServices.layer`.
import { Effect, Layer } from "effect";
import * as InMemory from "effect-agent/in-memory";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { livestream } from "./Livestream.ts";
import { Narrator } from "./Narrator.ts";
import { Stage } from "./Stage.ts";

const policy = BrowserPolicy.unrestricted({ maxActions: 60, maxElapsedMillis: 10 * 60_000 });

/** Watch at the Stage's address; a delay of 0 shows the browser live. */
export const watchChromium = (
  task: string,
  options: { readonly delayMillis: number; readonly port: number },
) =>
  Browser.scoped(Chromium.launch(policy), (session) =>
    livestream(session, task, { delayMillis: options.delayMillis }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Chromium.layer({ viewport: { width: 1280, height: 720 } }),
        InMemory.layer,
        Stage.layer({ port: options.port }),
        Narrator.layer,
      ),
    ),
  );
