import { Context } from "effect";
import { connectPlaywright } from "./Playwright.ts";
import type { Connector } from "./Session.ts";

/** Private injection seam; only the explicit testing subpath supplies a local CDP connection. */
export const NativeConnector = Context.Reference<Connector>(
  "@effect-agent/platform-browserbase/internal/NativeConnector",
  { defaultValue: () => connectPlaywright },
);
