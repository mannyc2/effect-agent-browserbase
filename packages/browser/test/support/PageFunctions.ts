/**
 * A page whose functions, such as `Snapshot.find`, answer as a test says, and otherwise as the
 * page does: a fake replaces what a page reads by name, without re-implementing a member.
 */
import {
  type Functions,
  functionsOf,
  Implementation,
  key,
} from "../../src/internal/page/functions.ts";
import type { Page } from "../../src/Page.ts";

export const replace = (page: Page, functions: Partial<Functions>): Page => ({
  ...page,
  [key]: new Implementation({ ...functionsOf(page), ...functions }),
});
