// The same livestream on a Browserbase session. BROWSERBASE_PROJECT_ID and BROWSERBASE_API_KEY
// are read from the ConfigProvider. Live View is not used: its URL controls the browser, so it
// can be shown to an operator, never to an audience; viewers get the captured frames instead.
import { Effect, Layer } from "effect";
import * as InMemory from "effect-agent/in-memory";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as Account from "effect-browserbase/account";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import { recipe } from "effect-browserbase/launch";

import { livestream } from "./Livestream.ts";
import { Narrator } from "./Narrator.ts";
import { Stage } from "./Stage.ts";

const policy = BrowserPolicy.unrestricted({ maxActions: 60, maxElapsedMillis: 10 * 60_000 });

const launch = recipe({ viewport: { _tag: "Fixed", width: 1280, height: 720 } });

/** Watch at the Stage's address; a delay of 0 shows the browser live. */
export const watchBrowserbase = (
  task: string,
  options: { readonly delayMillis: number; readonly port: number },
) =>
  Browser.scoped(BrowserbaseBrowser.open(policy), (session) =>
    livestream(session, task, { delayMillis: options.delayMillis }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        BrowserbaseBrowser.layer({ launch }).pipe(Layer.provide(Account.layerConfig())),
        InMemory.layer,
        Stage.layer({ port: options.port }),
        Narrator.layer,
      ),
    ),
  );
