import type { Effect } from "effect";

import type { PageExecutionState, PageInfo, PageSuspension } from "../../BrowserData.ts";
import type { BrowserError } from "../../Errors.ts";

export interface PageControlPort {
  readonly state: (page: PageInfo) => Effect.Effect<PageExecutionState, BrowserError>;
  readonly suspend: (page: PageInfo) => Effect.Effect<PageSuspension, BrowserError>;
  readonly resume: (receipt: PageSuspension) => Effect.Effect<void, BrowserError>;
}

export interface PageControlAssociation {
  readonly port: PageControlPort;
  readonly page?: PageInfo;
}

const owners = new WeakMap<object, PageControlAssociation>();

export const associatePageControl = (
  session: object,
  port: PageControlPort,
  page?: PageInfo,
): void => {
  owners.set(session, {
    port,
    ...(page === undefined ? {} : { page: Object.freeze({ ...page }) }),
  });
};

export const pageControl = (session: object): PageControlAssociation | undefined =>
  owners.get(session);
