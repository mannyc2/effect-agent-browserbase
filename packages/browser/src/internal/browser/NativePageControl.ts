import { Schema } from "effect";
import type { Browser, BrowserContext, Frame } from "playwright-core";

import type { PageInfo, PageSuspension } from "../../BrowserData.ts";
import { Identifier } from "../../BrowserData.ts";
import type { CallbackTasks } from "./CallbackTasks.ts";
import type { Driver, DriverEvents, DriverOptions } from "./Driver.ts";
import { closeWithin, failure, safeDecode, sanitize } from "./NativeCalls.ts";
import type { Ticket } from "./Owner.ts";
import { PageExecution } from "./PageExecution.ts";
import type { Entry, Targets } from "./Targets.ts";

/**
 * One native page execution per registered page, created once over its own CDP session. Its
 * receipt is invalidated when the page closes or its main frame navigates, and holds and
 * resumes act only on the exact page and target they name.
 */
export const makePageControl = (
  browser: Browser,
  context: BrowserContext,
  options: DriverOptions,
  targets: Targets,
  callbacks: CallbackTasks,
  events: DriverEvents,
  closing: () => boolean,
  /** A hold or a resume is about to be dispatched to this page. */
  held: (pageId: string) => void,
) => {
  const { current, entries } = targets;

  const execution = (entry: Entry): Promise<PageExecution> => {
    if (!options.pageControl) return Promise.reject(failure("unsupported", "undispatched"));
    entry.execution ??= sanitize(async () => {
      const cdp = await context.newCDPSession(entry.page);

      try {
        const targetId = await targets.targetId(entry);

        if (closing() || entry.page.isClosed()) throw failure("closed");
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
        if (closing() || entry.page.isClosed()) throw failure("closed");

        const control = new PageExecution(entry.id, targetId, {
          readRate: async () =>
            safeDecode(
              Schema.Struct({ playbackRate: Schema.Finite }),
              await cdp.send("Animation.getPlaybackRate"),
            ).playbackRate,
          rate: async (playbackRate) => {
            await cdp.send("Animation.setPlaybackRate", { playbackRate });
          },
          focus: async (enabled) => {
            await cdp.send("Emulation.setFocusEmulationEnabled", { enabled });
          },
          lifecycle: async (state) => {
            await cdp.send("Page.setWebLifecycleState", { state });
          },
          activate: async () => {
            await cdp.send("Page.bringToFront");
          },
          closed: () => closing() || !browser.isConnected() || entry.page.isClosed(),
          detach: async () => {
            if (entry.page.isClosed() || !browser.isConnected()) return;
            try {
              await closeWithin(() => cdp.detach());
            } catch (error) {
              if (!entry.page.isClosed() && browser.isConnected()) throw error;
            }
          },
          frameBarrier: async (ticket) => {
            ticket.check();

            const tree = safeDecode(
              Schema.Struct({
                frameTree: Schema.Struct({ frame: Schema.Struct({ id: Identifier }) }),
              }),
              await cdp.send("Page.getFrameTree"),
            );

            ticket.check();

            const world = await cdp.send("Page.createIsolatedWorld", {
              frameId: tree.frameTree.frame.id,
              worldName: "effect-browser-page-control",
            });

            ticket.check();

            const result = await cdp.send("Runtime.evaluate", {
              expression: "new Promise(resolve => requestAnimationFrame(() => resolve(true)))",
              contextId: safeDecode(
                Schema.Int.check(Schema.isGreaterThan(0)),
                world.executionContextId,
              ),
              awaitPromise: true,
              returnByValue: true,
              userGesture: false,
              timeout: Math.min(2000, ticket.remainingMillis()),
            });

            ticket.check();
            if (result.exceptionDetails !== undefined || result.result.value !== true)
              throw failure("malformed");
          },
        });

        entry.executionValue = control;

        return control;
      } catch (error) {
        await closeWithin(() => cdp.detach()).catch(() => {});
        throw error;
      }
    });

    return entry.execution;
  };

  const explicit = async (
    target: { readonly pageId: string; readonly targetId: string },
    ticket: Ticket,
  ) => {
    ticket.check();
    const entry = entries.get(target.pageId);

    if (entry === undefined || entry.page.isClosed()) throw failure("closed", "undispatched");
    const control = await execution(entry);

    ticket.check();
    if (control.targetId !== target.targetId) throw failure("stale", "undispatched");

    return control;
  };

  /** A closed page's execution is invalidated at once and disposed outside the event. */
  const closed = (entry: Entry) => {
    entry.executionValue?.invalidate();
    if (entry.execution !== undefined)
      callbacks.submit(async () => {
        await (await entry.execution)?.dispose();
      });
  };

  /** A main-frame navigation invalidates the execution; one that was held faults the session. */
  const navigating = (entry: Entry, frame: Frame) => {
    if (frame === entry.page.mainFrame() && entry.executionValue?.invalidate()) events.fault();
  };

  const operations: NonNullable<Driver["pageControl"]> = {
    state: (page: PageInfo, ticket: Ticket) =>
      sanitize(async () => (await explicit(page, ticket)).state()),
    // Announced before the dispatch, so an unknown outcome still leaves nothing unchecked.
    suspend: (page: PageInfo, ticket: Ticket) =>
      sanitize(async () => {
        const control = await explicit(page, ticket);

        held(control.pageId);

        return control.suspend(ticket);
      }),
    resume: (receipt: PageSuspension, ticket: Ticket) =>
      sanitize(async () => {
        const control = await explicit(receipt, ticket);

        held(control.pageId);

        return control.resume(receipt, ticket);
      }),
    checkTarget: (target, ticket: Ticket) =>
      sanitize(async () => {
        ticket.check();
        const control = await execution(current(target).entry);

        ticket.check();
        control.assertRunning();
      }),
  };

  const dispose = () =>
    Promise.allSettled(
      [...entries.values()].map(async (entry) => {
        if (entry.execution !== undefined) await (await entry.execution).dispose();
      }),
    );

  return { execution, closed, navigating, operations, dispose };
};
