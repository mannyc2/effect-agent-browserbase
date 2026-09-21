import type { Effect } from "effect";

import type { PageExecutionState, PageInfo, PageSuspension } from "../../BrowserData.ts";
import type { BrowserError } from "../../Errors.ts";

export interface PageControlPort {
  readonly state: (page: PageInfo) => Effect.Effect<PageExecutionState, BrowserError>;
  readonly suspend: (page: PageInfo) => Effect.Effect<PageSuspension, BrowserError>;
  readonly resume: (receipt: PageSuspension) => Effect.Effect<void, BrowserError>;
}

const owners = new WeakMap<object, PageControlPort>();

export const associatePageControl = (session: object, port: PageControlPort): void => {
  owners.set(session, port);
};

export const pageControl = (session: object): PageControlPort | undefined => owners.get(session);
