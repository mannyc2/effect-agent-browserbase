import { Schema } from "effect";
import type { ElementHandle, JSHandle } from "playwright-core";

import { ControlFacts, type ObservedElement } from "../../BrowserData.ts";
import { BrowserError } from "../../Errors.ts";
import { pngGeometry } from "../capture/Images.ts";
import type { DriverEvents, NativeCheckpoint, NativeObservation } from "./Driver.ts";
import {
  closeWithin,
  failure,
  NativeFailure,
  safeDecode,
  sanitize,
  timeout,
} from "./NativeCalls.ts";
import type { Ticket } from "./Owner.ts";
import { identityOf, observedControl, PageReadResult, readPage } from "./PageRead.ts";
import type { Targets } from "./Targets.ts";

const TextResult = Schema.Struct({
  text: Schema.String,
  missing: Schema.Boolean,
  overLimit: Schema.Boolean,
});

const Geometry = Schema.Struct({ width: Schema.Natural, height: Schema.Natural });

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(1000000));

const Facts = Schema.Struct({ facts: ControlFacts });

/** Bounds the page traversal itself, so a huge document costs a bounded read. */
const NodeBudget = 20_000;

/** A host's own decision about one control, made on facts read from the page just now. */
export type AdmissionPolicy = (facts: ControlFacts) => boolean;

interface Retained {
  readonly handle: ElementHandle<Element>;
  /** What made this control the one that was inspected; see `identityOf`. */
  readonly identity: string;
}

/**
 * `suspended` is a page hold: the nodes are kept but none may be acted on until it is checked
 * again, one node at a time. Anything else that could change the page makes it `invalid`.
 */
interface Snapshot {
  readonly id: string;
  readonly pageId: string;
  validity: "valid" | "suspended" | "invalid";
  readonly nodes: Map<string, Retained>;
  readonly revalidated: Set<string>;
}

/**
 * What is read from the selected document, and the one retained observation whose nodes a later
 * action may name. That observation is valid only until the next invalidating event.
 */
export const makeObservation = (targets: Targets, events: DriverEvents) => {
  const { current } = targets;
  let observation: Snapshot | undefined;
  let observationSerial = 0;

  const invalidate = () => {
    if (observation !== undefined) observation.validity = "invalid";
  };

  /**
   * A read is ordered against document replacement by failing: if the document it was reading
   * was replaced underneath it, or a navigation is still in flight on its page, the native error
   * is `target-changed` and `undispatched`, so a caller knows to read again. A read is never a
   * mutation, so reading again is always safe.
   */
  const reading = async <A>(body: () => Promise<A>): Promise<A> => {
    const { entry, frame } = current();
    const epoch = targets.epochOf(frame);

    try {
      return await body();
    } catch (error) {
      // A fenced ticket and a failure with its own reason already say what happened. Only an
      // unexplained native error is explained by the document having gone.
      const unexplained =
        !Schema.is(BrowserError)(error) &&
        (!Schema.is(NativeFailure)(error) || error.reason === "provider");

      if (unexplained && (targets.epochOf(frame) !== epoch || targets.navigating.has(entry.id)))
        throw failure("target-changed", "undispatched");
      throw error;
    }
  };

  const changed = (reason: Parameters<DriverEvents["invalidate"]>[0]) => {
    invalidate();
    events.invalidate(reason);
  };

  /**
   * Holding or resuming a page may run its `freeze` and `resume` handlers, so nothing observed
   * on it may be acted on unchecked. Another page's observation is untouched: a stage hold is
   * independent of the page an agent is driving.
   */
  const held = (pageId: string) => {
    if (observation?.pageId === pageId && observation.validity === "valid") {
      observation.validity = "suspended";
      observation.revalidated.clear();
    }
  };

  const dispose = async () => {
    const old = observation;

    observation = undefined;
    if (old !== undefined) {
      old.validity = "invalid";
      await closeWithin(() =>
        Promise.allSettled([...old.nodes.values()].map((node) => node.handle.dispose())),
      );
    }
  };

  const exactElement = async (
    selector: string,
    ticket: Ticket,
  ): Promise<ElementHandle<Element>> => {
    ticket.check();

    const holder = await current().frame.evaluateHandle((requested) => {
      try {
        const matches = document.querySelectorAll(requested);

        return { count: matches.length, node: matches.length === 1 ? matches[0] : null };
      } catch {
        return { count: 0, node: null };
      }
    }, selector);

    let node: JSHandle | undefined;

    try {
      const countHandle = await holder.getProperty("count");
      let count: number;

      try {
        count = safeDecode(Count, await countHandle.jsonValue());
      } finally {
        await countHandle.dispose();
      }
      ticket.check();
      if (count !== 1) throw failure(count === 0 ? "not-found" : "ambiguous", "undispatched");
      node = await holder.getProperty("node");
      const element = node.asElement();

      if (element === null) throw failure("not-found", "undispatched");
      ticket.check();

      return element;
    } catch (error) {
      await node?.dispose().catch(() => {});
      throw error;
    } finally {
      await holder.dispose();
    }
  };

  /** A retained node is only as current as the observation that produced it. */
  const retained = (target: ObservedElement, allowSuspended = false): Retained => {
    const snapshot = observation;

    if (snapshot === undefined || snapshot.id !== target.observationId)
      throw failure("stale", "undispatched");

    const usable =
      snapshot.validity === "valid" ||
      (snapshot.validity === "suspended" &&
        (allowSuspended || snapshot.revalidated.has(target.elementId)));

    const node = snapshot.nodes.get(target.elementId);

    if (!usable || node === undefined) throw failure("stale", "undispatched");

    return node;
  };

  /**
   * Read from the exact node, never re-resolved from a selector or a label. It is the same page
   * function an observation uses, told to read one node and traverse nothing.
   */
  const factsOf = async (element: ElementHandle<Element>): Promise<ControlFacts> => {
    const holder = await current().frame.evaluateHandle(readPage, {
      scope: "document" as const,
      maximumBytes: 0,
      controlLimit: 0,
      nodeBudget: 0,
      only: element,
    });

    try {
      const data = await holder.getProperty("data");

      try {
        return safeDecode(Facts, await data.jsonValue()).facts;
      } finally {
        await data.dispose();
      }
    } finally {
      await holder.dispose();
    }
  };

  /**
   * The exact attached node a target names, checked against the page right now. A selector must
   * still match it and nothing else. A retained node must still be the control that was
   * inspected: the same node with a different destination, type or label is not. A host policy
   * then decides on those fresh facts, and a refusal or a policy that throws sends nothing.
   */
  const resolve = async (
    target: string | ObservedElement,
    ticket: Ticket,
    policy?: AdmissionPolicy,
    allowSuspended = false,
  ): Promise<{ readonly element: ElementHandle<Element>; readonly kept: boolean }> => {
    const kept = typeof target !== "string";

    const node = typeof target === "string" ? undefined : retained(target, allowSuspended);

    const element = typeof target === "string" ? await exactElement(target, ticket) : node?.handle;

    if (element === undefined) throw failure("stale", "undispatched");
    try {
      const attached: unknown = await element.evaluate(
        (candidate, selector) => {
          if (!candidate.isConnected) return false;
          if (selector === undefined) return true;
          const matches = candidate.ownerDocument.querySelectorAll(selector);

          return matches.length === 1 && matches[0] === candidate;
        },
        typeof target === "string" ? target : undefined,
      );

      if (attached !== true) throw failure("stale", "undispatched");
      if (node !== undefined || policy !== undefined) {
        const facts = await factsOf(element);

        if (node !== undefined && identityOf(facts) !== node.identity)
          throw failure("stale", "undispatched");
        if (policy !== undefined) {
          let admitted = false;

          try {
            admitted = policy(facts) === true;
          } catch {
            admitted = false;
          }
          if (!admitted) throw failure("denied", "undispatched");
        }
      }
      ticket.check();

      return { element, kept };
    } catch (error) {
      if (!kept) await closeWithin(() => element.dispose()).catch(() => {});
      throw error;
    }
  };

  const controlFacts = (target: ObservedElement, ticket: Ticket) =>
    sanitize(async () => {
      const { element } = await resolve(target, ticket);

      return factsOf(element);
    });

  /** After a hold, one node at a time: still attached, and still the control inspected. */
  const revalidate = (target: ObservedElement, ticket: Ticket) =>
    sanitize(async () => {
      await resolve(target, ticket, undefined, true);
      observation?.revalidated.add(target.elementId);
    });

  const readText = (selector: string | undefined, maximumBytes: number, ticket: Ticket) =>
    sanitize(async () => {
      ticket.check();

      const raw: unknown = await reading(() =>
        current().frame.evaluate(
          ({ selector, maximumBytes }) => {
            const element =
              selector === undefined ? document.body : document.querySelector(selector);

            if (element === null) return { text: "", missing: true, overLimit: false };

            const text =
              element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");

            if (new TextEncoder().encode(text).length > maximumBytes)
              return { text: "", missing: false, overLimit: true };

            return { text, missing: false, overLimit: false };
          },
          { selector, maximumBytes },
        ),
      );

      ticket.check();
      const value = safeDecode(TextResult, raw);

      if (value.missing) throw failure("not-found");
      if (value.overLimit || new TextEncoder().encode(value.text).length > maximumBytes)
        throw failure("limit");

      return value.text;
    });

  /** One bounded read of the selected frame, and the node handles it names, in order. */
  const read = async (
    scope: "document" | "viewport",
    maximumBytes: number,
    controlLimit: number,
    ticket: Ticket,
    keepNodes: boolean,
  ) => {
    const holder = await current().frame.evaluateHandle(readPage, {
      scope,
      maximumBytes,
      controlLimit,
      nodeBudget: NodeBudget,
    });

    const handles: Array<ElementHandle<Element>> = [];
    let nodesHandle: JSHandle | undefined;

    try {
      const dataHandle = await holder.getProperty("data");
      let data: PageReadResult;

      try {
        data = safeDecode(PageReadResult, await dataHandle.jsonValue());
      } finally {
        await dataHandle.dispose();
      }
      if (
        new TextEncoder().encode(data.text).length > maximumBytes ||
        data.controls.length > controlLimit
      )
        throw failure("limit");
      if (keepNodes) {
        nodesHandle = await holder.getProperty("nodes");
        for (let i = 0; i < data.controls.length; i++) {
          const node = await nodesHandle.getProperty(String(i));
          const element = node.asElement();

          if (element === null) {
            await node.dispose();
            throw failure("malformed");
          }
          handles.push(element);
        }
      }
      ticket.check();

      return { data, handles };
    } catch (error) {
      await Promise.allSettled(handles.map((handle) => handle.dispose()));
      throw error;
    } finally {
      await nodesHandle?.dispose().catch(() => {});
      await holder.dispose();
    }
  };

  const observe = (
    scope: "document" | "viewport",
    maximumBytes: number,
    controlLimit: number,
    ticket: Ticket,
  ) =>
    sanitize(async () => {
      await dispose();
      ticket.check();
      const pageId = current().entry.id;

      const { data, handles } = await reading(() =>
        read(scope, maximumBytes, controlLimit, ticket, true),
      );

      const id = `observation-${++observationSerial}`;
      const nodes = new Map<string, Retained>();

      // One handle per control, in the order the page returned them.
      handles.forEach((handle, i) => {
        const facts = data.controls[i];

        if (facts !== undefined) nodes.set(`element-${i}`, { handle, identity: identityOf(facts) });
      });
      if (nodes.size !== data.controls.length) {
        await Promise.allSettled(handles.map((handle) => handle.dispose()));
        throw failure("malformed");
      }
      observation = { id, pageId, validity: "valid", nodes, revalidated: new Set() };

      const result: NativeObservation = {
        observationId: id,
        scope,
        url: targets.selectedUrl(),
        text: data.text,
        textTruncated: data.textTruncated,
        controlsTruncated: data.controlsTruncated,
        controls: data.controls.map((facts, i) => observedControl(facts, `element-${i}`)),
        viewport: data.viewport,
      };

      return result;
    });

  const screenshot = (fullPage: boolean, maximumBytes: number, ticket: Ticket) =>
    sanitize(() =>
      reading(async () => {
        const page = current().entry.page;

        ticket.check();

        const raw: unknown = await page.evaluate(
          (full) => ({
            width: full
              ? Math.max(document.documentElement.scrollWidth, window.innerWidth)
              : window.innerWidth,
            height: full
              ? Math.max(document.documentElement.scrollHeight, window.innerHeight)
              : window.innerHeight,
          }),
          fullPage,
        );

        const geometry = safeDecode(Geometry, raw);

        if (
          geometry.width < 1 ||
          geometry.height < 1 ||
          geometry.width > 16384 ||
          geometry.height > 16384 ||
          geometry.width * geometry.height > 33_554_432
        )
          throw failure("limit");
        ticket.check();

        const bytes: unknown = await page.screenshot({
          type: "png",
          fullPage,
          scale: "css",
          timeout: timeout(ticket),
        });

        if (!(bytes instanceof Uint8Array)) throw failure("malformed");
        if (bytes.length > maximumBytes) throw failure("limit");
        const actual = pngGeometry(bytes);

        if (
          actual.width > 16384 ||
          actual.height > 16384 ||
          actual.width * actual.height > 33_554_432
        )
          throw failure("limit");
        ticket.check();

        return new Uint8Array(bytes);
      }),
    );

  /**
   * Passive: it reads what is on screen and takes a picture, keeps no node, and leaves the
   * retained observation exactly as it was. Text and picture are sampled one after the other,
   * so a document replaced in between is reported rather than hidden.
   */
  const checkpoint = (
    maximumBytes: number,
    controlLimit: number,
    pictureBytes: number | undefined,
    ticket: Ticket,
  ) =>
    sanitize(async () => {
      ticket.check();
      const { frame } = current();
      const epoch = targets.epochOf(frame);

      const { data } = await reading(() =>
        read("viewport", maximumBytes, controlLimit, ticket, false),
      );

      const picture =
        pictureBytes === undefined ? undefined : await screenshot(false, pictureBytes, ticket);

      const result: NativeCheckpoint = {
        url: targets.selectedUrl(),
        ...data,
        ...(picture === undefined ? {} : { picture }),
        documentChanged: targets.epochOf(frame) !== epoch,
      };

      return result;
    });

  return {
    invalidate,
    changed,
    held,
    dispose,
    resolve,
    controlFacts,
    revalidate,
    readText,
    observe,
    screenshot,
    checkpoint,
  };
};

export type Observation = ReturnType<typeof makeObservation>;
