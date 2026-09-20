import type { Effect } from "effect";

import type { BrowserbaseError, PageExecutionState, PageInfo, PageSuspension } from "../Types.ts";

export interface PageControlPort {
  readonly state: (page: PageInfo) => Effect.Effect<PageExecutionState, BrowserbaseError>;
  readonly suspend: (page: PageInfo) => Effect.Effect<PageSuspension, BrowserbaseError>;
  readonly resume: (receipt: PageSuspension) => Effect.Effect<void, BrowserbaseError>;
}

const owners = new WeakMap<object, PageControlPort>();

export const associatePageControl = (session: object, port: PageControlPort): void => {
  owners.set(session, port);
};

export const pageControl = (session: object): PageControlPort | undefined => owners.get(session);
