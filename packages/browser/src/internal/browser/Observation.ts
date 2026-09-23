import { Schema } from "effect";
import type { ElementHandle, JSHandle } from "playwright-core";

import { ControlFacts, type ObservedElement, type SelectOptions } from "../../BrowserData.ts";
import { BrowserError, Reasons } from "../../Errors.ts";
import type { DriverEvents, DriverTarget, NativeCheckpoint, NativeObservation } from "./Driver.ts";
import { pngGeometry } from "./Images.ts";
import {
  closeWithin,
  failure,
  NativeFailure,
  safeDecode,
  sanitize,
  timeout,
} from "./NativeCalls.ts";
import type { ObservationScope, ReadTicket, Ticket } from "./Owner.ts";
import { identityOf, observedControl, PageReadResult, readPage } from "./PageRead.ts";
import type { Targets } from "./Targets.ts";

const TextResult = Schema.Struct({
  text: Schema.String,
  missing: Schema.Boolean,
  byteLength: Schema.Natural,
});

const Geometry = Schema.Struct({ width: Schema.Natural, height: Schema.Natural });

const checkScreenshotGeometry = (geometry: typeof Geometry.Type) => {
  if (geometry.width < 1) throw failure(Reasons.Malformed.make({ path: "screenshot.width" }));
  if (geometry.height < 1) throw failure(Reasons.Malformed.make({ path: "screenshot.height" }));
  if (geometry.width > 16384)
    throw failure(
      Reasons.Limit.make({ dimension: "width", maximum: 16384, observed: geometry.width }),
    );
  if (geometry.height > 16384)
    throw failure(
      Reasons.Limit.make({ dimension: "height", maximum: 16384, observed: geometry.height }),
    );
  const pixels = geometry.width * geometry.height;

  if (pixels > 33_554_432)
    throw failure(
      Reasons.Limit.make({ dimension: "pixels", maximum: 33_554_432, observed: pixels }),
    );
};

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(1000000));

const Facts = Schema.Struct({ facts: ControlFacts });

const SelectionFacts = Schema.Struct({
  facts: ControlFacts,
  attached: Schema.Boolean,
  options: Schema.Array(
    Schema.Struct({
      facts: ControlFacts,
      member: Schema.Boolean,
      valueMatches: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(64)),
});

/** Bounds the page traversal itself, so a huge document costs a bounded read. */
const NodeBudget = 20_000;

/** A host's own decision about one control, made on facts read from the page just now. */
export type AdmissionPolicy = (facts: ControlFacts) => boolean;

interface Retained {
  readonly handle: ElementHandle<Element>;
  /** What made this control the one that was inspected; see `identityOf`. */
  readonly identity: string;
  readonly multiple?: boolean;
  /** The submitted value is retained privately and never appears in a control or receipt. */
  readonly option?: { readonly selectElementId: string; readonly value: string };
  leases: number;
  retired: boolean;
  disposal?: Promise<void>;
}

/**
 * `suspended` is a page hold: the nodes are kept but none may be acted on until it is checked
 * again, one node at a time. Anything else that could change the page makes it `invalid`.
 */
interface Snapshot {
  readonly id: string;
  readonly target: DriverTarget;
  readonly documentEpoch: number;
  readonly generation: number;
  validity: "reading" | "valid" | "suspended" | "invalid";
  readonly nodes: Map<string, Retained>;
  readonly revalidated: Set<string>;
}

/**
 * What is read from the selected document, and the one retained observation whose nodes a later
 * action may name. That observation is valid only until the next invalidating event.
 */
export const makeObservation = (targets: Targets, events: DriverEvents) => {
  const { current } = targets;
  const connectionNamespace = globalThis.crypto.randomUUID();
  let observation: Snapshot | undefined;
  let observationSerial = 0;
  let connectionRetired = false;

  const invalidate = (scope: ObservationScope = "all") => {
    if (
      observation !== undefined &&
      scope !== "none" &&
      (scope === "all" || scope.pageId === observation.target.pageId)
    )
      observation.validity = "invalid";
  };

  /**
   * A read is ordered against document replacement by failing: if the document it was reading
   * was replaced underneath it, or a navigation is still in flight on its page, the native error
   * is `target-changed` and `undispatched`, so a caller knows to read again. A read is never a
   * mutation, so reading again is always safe.
   */
  const reading = async <A>(body: () => Promise<A>, target?: DriverTarget): Promise<A> => {
    const { entry, frame } = current(target);
    const epoch = targets.epochOf(frame);

    try {
      return await body();
    } catch (error) {
      // A fenced ticket and a failure with its own reason already say what happened. Only an
      // unexplained native error is explained by the document having gone.
      const unexplained =
        !Schema.is(BrowserError)(error) &&
        (!Schema.is(NativeFailure)(error) || error.reason._tag === "Provider");

      if (unexplained && (targets.epochOf(frame) !== epoch || targets.navigating.has(entry.id)))
        throw failure(Reasons.TargetChanged.make({}), "undispatched");
      throw error;
    }
  };

  const changed = (
    reason: Parameters<DriverEvents["invalidate"]>[0],
    scope: ObservationScope = "all",
  ) => {
    invalidate(scope);
    events.invalidate(reason, scope);
  };

  /**
   * Holding or resuming a page may run its `freeze` and `resume` handlers, so nothing observed
   * on it may be acted on unchecked. Another page's observation is untouched: a stage hold is
   * independent of the page an agent is driving.
   */
  const held = (pageId: string) => {
    if (observation?.target.pageId === pageId) {
      if (observation.validity === "reading") observation.validity = "invalid";
      else if (observation.validity === "valid") {
        observation.validity = "suspended";
        observation.revalidated.clear();
      }
    }
  };

  const disposeNode = (node: Retained): Promise<void> =>
    connectionRetired
      ? Promise.resolve()
      : (node.disposal ??= Promise.resolve().then(() =>
          connectionRetired ? undefined : node.handle.dispose(),
        ));

  const retireNode = (node: Retained): Promise<void> => {
    node.retired = true;

    return node.leases === 0 ? disposeNode(node) : Promise.resolve();
  };

  const dispose = async () => {
    const old = observation;

    observation = undefined;
    if (old !== undefined) {
      old.validity = "invalid";
      await closeWithin(() => Promise.allSettled([...old.nodes.values()].map(retireNode)));
    }
  };

  const exactElement = async (
    selector: string,
    ticket: Ticket,
    target?: DriverTarget,
  ): Promise<ElementHandle<Element>> => {
    ticket.check();

    const holder = await current(target).frame.evaluateHandle((requested) => {
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
      if (count !== 1)
        throw failure(
          count === 0 ? Reasons.NotFound.make({}) : Reasons.Ambiguous.make({}),
          "undispatched",
        );
      node = await holder.getProperty("node");
      const element = node.asElement();

      if (element === null) throw failure(Reasons.NotFound.make({}), "undispatched");
      ticket.check();

      return element;
    } catch (error) {
      await node?.dispose().catch(() => {});
      throw error;
    } finally {
      await holder.dispose();
    }
  };

  /** Selection can move away and back; the original document and snapshot cannot be replaced. */
  const checkSnapshot = (snapshot: Snapshot, ticket: ReadTicket): void => {
    ticket.check();
    if (
      observation !== snapshot ||
      snapshot.generation !== ticket.generation ||
      snapshot.validity === "invalid"
    )
      throw failure(Reasons.Stale.make({}), "undispatched");

    const selected = targets.selected();

    if (
      selected.pageId !== snapshot.target.pageId ||
      selected.frameId !== snapshot.target.frameId ||
      targets.epochOf(current(snapshot.target).frame) !== snapshot.documentEpoch
    )
      throw failure(Reasons.Stale.make({}), "undispatched");
  };

  /** A retained node is only as current as the observation that produced it. */
  const retained = (target: ObservedElement, ticket: ReadTicket, allowSuspended = false) => {
    const snapshot = observation;

    if (snapshot === undefined || snapshot.id !== target.observationId)
      throw failure(Reasons.Stale.make({}), "undispatched");
    const node = snapshot.nodes.get(target.elementId);

    if (node === undefined) throw failure(Reasons.Stale.make({}), "undispatched");

    const check = (): void => {
      checkSnapshot(snapshot, ticket);

      const usable =
        snapshot.validity === "valid" ||
        (snapshot.validity === "suspended" &&
          (allowSuspended || snapshot.revalidated.has(target.elementId)));

      if (!usable || snapshot.nodes.get(target.elementId) !== node)
        throw failure(Reasons.Stale.make({}), "undispatched");
    };

    check();

    return { node, snapshot, check };
  };

  /**
   * A wait borrows one exact node without authorizing input. Its state may change. Retiring the
   * observation defers this node's disposal until the native wait actually releases the lease.
   */
  const lease = (reference: ObservedElement, ticket: ReadTicket) => {
    const { node, snapshot } = retained(reference, ticket);

    node.leases++;
    let released: Promise<void> | undefined;

    return {
      element: node.handle,
      check: () => {
        ticket.check();
        if (
          connectionRetired ||
          observation !== snapshot ||
          snapshot.validity === "invalid" ||
          targets.epochOf(current(snapshot.target).frame) !== snapshot.documentEpoch
        )
          throw failure(Reasons.Stale.make({}), "undispatched");
      },
      release: (): Promise<void> => {
        released ??= (async () => {
          node.leases--;
          if (node.retired && node.leases === 0) await disposeNode(node);
        })();

        return released;
      },
    };
  };

  /**
   * Read from the exact node, never re-resolved from a selector or a label. It is the same page
   * function an observation uses, told to read one node and traverse nothing.
   */
  const sampleFacts = async (
    element: ElementHandle<Element>,
    check: () => void,
    target?: DriverTarget,
    options?: ReadonlyArray<{ readonly node: ElementHandle<Element>; readonly value: string }>,
  ): Promise<unknown> => {
    check();

    const holder = await current(target).frame.evaluateHandle(readPage, {
      scope: "document" as const,
      maximumBytes: 0,
      controlLimit: 0,
      nodeBudget: 0,
      only: element,
      ...(options === undefined ? {} : { options }),
    });

    try {
      check();
      const data = await holder.getProperty("data");

      try {
        check();
        const raw: unknown = await data.jsonValue();

        check();

        return raw;
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
    browserTarget?: DriverTarget,
  ): Promise<{
    readonly element: ElementHandle<Element>;
    readonly kept: boolean;
    readonly check: () => void;
    readonly facts: ControlFacts | undefined;
  }> => {
    const kept = typeof target !== "string";

    const retainedNode =
      typeof target === "string" ? undefined : retained(target, ticket, allowSuspended);

    const node = retainedNode?.node;
    const resolvedTarget = retainedNode?.snapshot.target ?? browserTarget;
    const check = retainedNode?.check ?? (() => ticket.check());

    const element =
      typeof target === "string" ? await exactElement(target, ticket, browserTarget) : node?.handle;

    if (element === undefined) throw failure(Reasons.Stale.make({}), "undispatched");
    let facts: ControlFacts | undefined;

    try {
      check();

      const select =
        node?.option === undefined
          ? undefined
          : retainedNode?.snapshot.nodes.get(node.option.selectElementId)?.handle;

      const attached: unknown = await element.evaluate(
        (candidate, { selector, selection }) => {
          if (!candidate.isConnected || candidate.ownerDocument !== document) return false;
          if (
            selection !== undefined &&
            (!(candidate instanceof HTMLOptionElement) ||
              !(selection.select instanceof HTMLSelectElement) ||
              !selection.select.isConnected ||
              candidate.closest("select") !== selection.select ||
              selection.select.options.item(candidate.index) !== candidate ||
              candidate.value !== selection.value)
          )
            return false;
          if (selector === undefined) return true;
          const matches = candidate.ownerDocument.querySelectorAll(selector);

          return matches.length === 1 && matches[0] === candidate;
        },
        {
          selector: typeof target === "string" ? target : undefined,
          selection:
            select === undefined || node?.option === undefined
              ? undefined
              : { select, value: node.option.value },
        },
      );

      check();
      if (attached !== true) throw failure(Reasons.Stale.make({}), "undispatched");
      if (node !== undefined || policy !== undefined) {
        facts = safeDecode(Facts, await sampleFacts(element, check, resolvedTarget)).facts;

        check();
        if (node !== undefined && identityOf(facts) !== node.identity)
          throw failure(Reasons.Stale.make({}), "undispatched");
        if (policy !== undefined) {
          let admitted = false;

          try {
            admitted = policy(facts) === true;
          } catch {
            admitted = false;
          }
          if (!admitted) throw failure(Reasons.Denied.make({}), "undispatched");
        }
      }
      check();

      return { element, kept, check, facts };
    } catch (error) {
      if (!kept) await closeWithin(() => element.dispose()).catch(() => {});
      check();
      throw error;
    }
  };

  /** Validate all options in one fresh page read, while keeping the original exact handles. */
  const selectOptions = async (
    target: ObservedElement,
    ids: SelectOptions,
    element: ElementHandle<Element>,
    ticket: Ticket,
  ) => {
    const select = retained(target, ticket);

    if (select.node.handle !== element) throw failure(Reasons.Stale.make({}), "undispatched");
    if (select.node.multiple === undefined)
      throw failure(Reasons.Unsupported.make({}), "undispatched");

    const options = ids.map((elementId) => {
      const option = retained({ observationId: target.observationId, elementId }, ticket);
      const identity = option.node.option;

      if (identity === undefined || identity.selectElementId !== target.elementId)
        throw failure(Reasons.Stale.make({}), "undispatched");

      return { ...option, value: identity.value };
    });

    const check = () => {
      select.check();
      for (const option of options) option.check();
    };

    const fresh = safeDecode(
      SelectionFacts,
      await sampleFacts(
        element,
        check,
        select.snapshot.target,
        options.map((option) => ({ node: option.node.handle, value: option.value })),
      ),
    );

    check();
    if (!fresh.attached || identityOf(fresh.facts) !== select.node.identity)
      throw failure(Reasons.Stale.make({}), "undispatched");
    if (fresh.options.length !== options.length)
      throw failure(Reasons.Malformed.make({}), "undispatched");
    for (const [index, sampled] of fresh.options.entries()) {
      const option = options[index];

      if (
        option === undefined ||
        !sampled.member ||
        !sampled.valueMatches ||
        identityOf(sampled.facts) !== option.node.identity
      )
        throw failure(Reasons.Stale.make({}), "undispatched");
    }
    if (fresh.facts.disabled || fresh.options.some((option) => option.facts.disabled))
      throw failure(Reasons.Disabled.make({}), "undispatched");
    if (fresh.facts.multiple !== true && ids.length > 1)
      throw failure(Reasons.Unsupported.make({}), "undispatched");
    check();

    return {
      handles: options.map((option) => option.node.handle),
      values: options.map((option) => option.value),
    };
  };

  const controlFacts = (target: ObservedElement, ticket: Ticket) =>
    sanitize(async () => {
      const { facts, check } = await resolve(target, ticket);

      check();
      if (facts === undefined) throw failure(Reasons.Malformed.make({}), "undispatched");

      return facts;
    });

  /** After a hold, one node at a time: still attached, and still the control inspected. */
  const revalidate = (target: ObservedElement, ticket: Ticket) =>
    sanitize(async () => {
      const snapshot = observation;
      const { check } = await resolve(target, ticket, undefined, true);

      check();
      if (snapshot === undefined || snapshot !== observation)
        throw failure(Reasons.Stale.make({}), "undispatched");
      snapshot.revalidated.add(target.elementId);
    });

  const readText = (
    selector: string | undefined,
    maximumBytes: number,
    ticket: Ticket,
    target?: DriverTarget,
  ) =>
    sanitize(async () => {
      ticket.check();

      const raw: unknown = await reading(
        () =>
          current(target).frame.evaluate(
            ({ selector, maximumBytes }) => {
              const element =
                selector === undefined ? document.body : document.querySelector(selector);

              if (element === null) return { text: "", missing: true, byteLength: 0 };

              const text =
                element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");

              const byteLength = new TextEncoder().encode(text).length;

              return { text: byteLength > maximumBytes ? "" : text, missing: false, byteLength };
            },
            { selector, maximumBytes },
          ),
        target,
      );

      ticket.check();
      const value = safeDecode(TextResult, raw);

      if (value.missing) throw failure(Reasons.NotFound.make({}));
      const observedBytes = Math.max(value.byteLength, new TextEncoder().encode(value.text).length);

      if (observedBytes > maximumBytes)
        throw failure(
          Reasons.Limit.make({ dimension: "text", maximum: maximumBytes, observed: observedBytes }),
        );

      return value.text;
    });

  /** One bounded read of the selected frame, and the node handles it names, in order. */
  const read = async (
    scope: "document" | "viewport",
    maximumBytes: number,
    controlLimit: number,
    check: () => void,
    keepNodes: boolean,
    target?: DriverTarget,
  ) => {
    check();

    const holder = await current(target).frame.evaluateHandle(readPage, {
      scope,
      maximumBytes,
      controlLimit,
      nodeBudget: NodeBudget,
      choices: keepNodes,
    });

    const handles: Array<ElementHandle<Element>> = [];
    let nodesHandle: JSHandle | undefined;

    try {
      let data: PageReadResult;

      try {
        check();
        const dataHandle = await holder.getProperty("data");

        try {
          check();
          const raw: unknown = await dataHandle.jsonValue();

          check();
          data = safeDecode(PageReadResult, raw);
        } finally {
          await dataHandle.dispose();
        }
        check();
        const textBytes = new TextEncoder().encode(data.text).length;

        if (textBytes > maximumBytes)
          throw failure(
            Reasons.Limit.make({ dimension: "text", maximum: maximumBytes, observed: textBytes }),
          );
        if (data.controls.length > controlLimit)
          throw failure(
            Reasons.Limit.make({
              dimension: "controls",
              maximum: controlLimit,
              observed: data.controls.length,
            }),
          );
        if (keepNodes) {
          nodesHandle = await holder.getProperty("nodes");
          check();
          for (let i = 0; i < data.controls.length; i++) {
            const node = await nodesHandle.getProperty(String(i));
            const element = node.asElement();

            if (element === null) {
              await node.dispose();
              throw failure(Reasons.Malformed.make({}));
            }
            // Playwright types every property handle as `any`. readPage stores only Elements
            // under `nodes`, and asElement() has already rejected any other value.
            // oxlint-disable-next-line typescript/no-unsafe-argument -- untyped Playwright handle
            handles.push(element);
            check();
          }
        }
      } finally {
        await nodesHandle?.dispose().catch(() => {});
        await holder.dispose();
      }
      check();

      return { data, handles };
    } catch (error) {
      // Ownership transfers only after wrapper release succeeds and the snapshot is rechecked.
      await closeWithin(() => Promise.allSettled(handles.map((handle) => handle.dispose()))).catch(
        () => {},
      );
      check();
      throw error;
    }
  };

  const observe = (
    scope: "document" | "viewport",
    maximumBytes: number,
    controlLimit: number,
    ticket: Ticket,
  ) =>
    sanitize(async () => {
      ticket.check();
      await dispose();
      ticket.check();
      const target = targets.selected();

      const snapshot: Snapshot = {
        id: `observation-${connectionNamespace}-${++observationSerial}`,
        target,
        documentEpoch: targets.epochOf(current(target).frame),
        generation: ticket.generation,
        validity: "reading",
        nodes: new Map(),
        revalidated: new Set(),
      };

      // Own-page events must also retire a read whose native handles have not arrived yet.
      observation = snapshot;
      let handles: Array<ElementHandle<Element>> = [];

      try {
        const sampled = await reading(
          () =>
            read(
              scope,
              maximumBytes,
              controlLimit,
              () => checkSnapshot(snapshot, ticket),
              true,
              target,
            ),
          target,
        );

        handles = sampled.handles;
        checkSnapshot(snapshot, ticket);
        const { data } = sampled;
        const selects = new Map<number, boolean>();
        const options = new Map<number, NonNullable<Retained["option"]>>();

        for (const select of data.selects ?? []) {
          if (selects.has(select.index) || data.controls[select.index]?.multiple === undefined)
            throw failure(Reasons.Malformed.make({}));
          selects.set(select.index, select.optionsTruncated);
          for (const option of select.options) {
            if (options.has(option.index) || data.controls[option.index]?.selected === undefined)
              throw failure(Reasons.Malformed.make({}));
            options.set(option.index, {
              selectElementId: `element-${select.index}`,
              value: option.value,
            });
          }
        }

        // One handle per control, in the order the page returned them.
        handles.forEach((handle, i) => {
          const facts = data.controls[i];

          if (facts !== undefined) {
            const option = options.get(i);

            snapshot.nodes.set(`element-${i}`, {
              handle,
              identity: identityOf(facts),
              leases: 0,
              retired: false,
              ...(facts.multiple === undefined ? {} : { multiple: facts.multiple }),
              ...(option === undefined ? {} : { option }),
            });
          }
        });
        if (snapshot.nodes.size !== data.controls.length) throw failure(Reasons.Malformed.make({}));

        const result: NativeObservation = {
          observationId: snapshot.id,
          scope,
          url: targets.url(target),
          text: data.text,
          textTruncated: data.textTruncated,
          controlsTruncated: data.controlsTruncated,
          controls: data.controls.map((facts, i) => {
            const option = options.get(i);
            const optionsTruncated = selects.get(i);

            return observedControl(facts, `element-${i}`, {
              ...(option === undefined ? {} : { selectElementId: option.selectElementId }),
              ...(optionsTruncated === undefined ? {} : { optionsTruncated }),
            });
          }),
          viewport: data.viewport,
        };

        checkSnapshot(snapshot, ticket);
        snapshot.validity = "valid";

        return result;
      } catch (error) {
        snapshot.validity = "invalid";
        if (observation === snapshot) observation = undefined;
        await closeWithin(() =>
          Promise.allSettled(handles.map((handle) => handle.dispose())),
        ).catch(() => {});
        throw error;
      }
    });

  const screenshot = (
    fullPage: boolean,
    maximumBytes: number,
    ticket: Ticket,
    target?: DriverTarget,
  ) =>
    sanitize(() =>
      reading(async () => {
        const page = current(target).entry.page;

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

        checkScreenshotGeometry(geometry);
        ticket.check();

        const bytes: unknown = await page.screenshot({
          type: "png",
          fullPage,
          scale: "css",
          timeout: timeout(ticket),
        });

        if (!(bytes instanceof Uint8Array)) throw failure(Reasons.Malformed.make({}));
        if (bytes.length > maximumBytes)
          throw failure(
            Reasons.Limit.make({
              dimension: "returned-bytes",
              maximum: maximumBytes,
              observed: bytes.length,
            }),
          );
        const actual = pngGeometry(bytes);

        checkScreenshotGeometry(actual);
        ticket.check();

        return new Uint8Array(bytes);
      }, target),
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
        read("viewport", maximumBytes, controlLimit, () => ticket.check(), false),
      );

      const picture =
        pictureBytes === undefined ? undefined : await screenshot(false, pictureBytes, ticket);

      const result: NativeCheckpoint = {
        url: targets.selectedUrl(),
        text: data.text,
        textTruncated: data.textTruncated,
        controls: data.controls,
        controlsTruncated: data.controlsTruncated,
        viewport: data.viewport,
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
    lease,
    retireConnection: () => {
      connectionRetired = true;
      const old = observation;

      observation = undefined;
      if (old !== undefined) {
        old.validity = "invalid";
        for (const node of old.nodes.values()) node.retired = true;
      }
    },
    resolve,
    selectOptions,
    controlFacts,
    revalidate,
    readText,
    observe,
    screenshot,
    checkpoint,
  };
};

export type Observation = ReturnType<typeof makeObservation>;
