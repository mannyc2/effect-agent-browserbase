import { Effect, Schema } from "effect";

import {
  ControlFacts,
  FrameInfo,
  ObservedControl,
  PageExecutionState,
  PageInfo,
  PageSuspension,
  ViewportEvidence,
  ViewportRect,
  type FormField,
  type KeyModifier,
  type ObservedElement,
  type SelectOptions,
  type Viewport,
  type ViewportPoint,
  type WaitForElementRequest,
} from "../../BrowserData.ts";
import {
  BrowserError,
  InitializationError,
  Reasons,
  type BrowserOperation,
  type BrowserOutcome,
  type BrowserReason,
} from "../../Errors.ts";
import type { NativeBinding } from "../browser/Bindings.ts";
import type {
  CaptureBinding,
  CaptureStart,
  Driver,
  DriverEvents,
  DriverOptions,
  DriverTarget,
  NativeCheckpoint,
  NativeFileSelection,
  NativeNavigation,
  NativeObservation,
  ReadinessState,
} from "../browser/Driver.ts";
import type { AdmissionPolicy } from "../browser/Observation.ts";
import type { ObservationScope, ReadTicket, Ticket, WaitTicket } from "../browser/Owner.ts";
import type { NativeInput } from "../browser/Pointer.ts";
import { checked } from "../browser/PublicSession.ts";
import { jpegFrame } from "./Frame.ts";
import {
  DocumentScript,
  type BindingReply,
  type ControlScript,
  type Gate,
  type RecordedCall,
  type Script,
  type ScriptableOperation,
  type ScriptedConnection,
  type ScriptedControl,
  type ScriptedFrame,
  type ScriptedOutcome,
} from "./Script.ts";

/** Time for an in-flight navigation, on the Effect clock the engine was opened under. */
export interface EngineTimers {
  readonly sleep: (millis: number) => {
    readonly done: Promise<void>;
    readonly cancel: () => void;
  };
}

/**
 * One scripted browser. Its pages, documents, recorder and arms outlive any one connection, as a
 * keep-alive browser's do; each connection gets its own driver, selection and observation.
 */
export interface ScriptedBrowser {
  readonly connect: (options: DriverOptions, events: DriverEvents) => Driver;
  readonly control: ScriptedControl;
}

/** What the browser needs from each connection open to it. */
interface Live {
  readonly retire: (pageId: string) => void;
  readonly announce: (pageId: string) => void;
  readonly drop: () => void;
  readonly invoke: (
    name: string,
    input: unknown,
    origin: string | undefined,
  ) => Promise<BindingReply>;
  readonly pointer: () => ViewportPoint | null;
  readonly viewport: () => Viewport;
}

interface ControlState {
  script: ControlScript;
  checked: boolean | undefined;
  selected: boolean | undefined;
}

interface DocumentState {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly controls: ReadonlyArray<ControlState>;
}

interface InFlight {
  readonly stop: () => void;
  readonly drop: () => void;
  readonly by: Live;
}

interface Page {
  readonly pageId: string;
  readonly targetId: string;
  readonly frameId: string;
  document: DocumentState;
  epoch: number;
  /** The document epoch that predates registration; `-1` when every document ran the bundle. */
  readonly registeredEpoch: number;
  readonly values: Map<string, string>;
  readonly files: Map<string, ReadonlyArray<string>>;
  focused: string | undefined;
  closed: boolean;
  held: { readonly suspensionId: string; readonly by: Live } | undefined;
  navigation: InFlight | undefined;
  readonly watchers: Set<() => void>;
  capture: { readonly start: CaptureStart; readonly by: Live } | undefined;
}

interface Snapshot {
  readonly id: string;
  readonly pageId: string;
  readonly epoch: number;
  readonly generation: number;
  validity: "valid" | "suspended" | "invalid";
  readonly nodes: Map<string, ControlState>;
  readonly revalidated: Set<string>;
}

interface InternalGate {
  readonly reach: () => void;
  readonly opened: Promise<void>;
}

type MutableCall = {
  -readonly [K in keyof RecordedCall]: RecordedCall[K];
};

const gates = new WeakMap<Gate, InternalGate>();

/** A gate that holds a scripted call until the test opens it. */
const makeGate = Effect.sync((): Gate => {
  let reach: () => void = () => {};
  let open: () => void = () => {};

  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });

  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  const gate: Gate = {
    reached: Effect.promise(() => reached),
    open: Effect.sync(() => {
      open();
    }),
  };

  gates.set(gate, { reach, opened });

  return gate;
});

/** A 1×1 PNG: what a scripted screenshot or checkpoint picture contains. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

const fail = (
  operation: BrowserOperation,
  reason: BrowserReason,
  outcome: BrowserOutcome = "undispatched",
): BrowserError => BrowserError.make({ operation, reason, outcome });

const encoder = new TextEncoder();

/** Cut at a character boundary so the bounded text is still valid UTF-16. */
const bounded = (text: string, maximumBytes: number) => {
  if (encoder.encode(text).length <= maximumBytes) return { text, truncated: false };
  let kept = "";
  let bytes = 0;

  for (const character of text) {
    const size = encoder.encode(character).length;

    if (bytes + size > maximumBytes) break;
    kept += character;
    bytes += size;
  }

  return { text: kept, truncated: true };
};

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
};

const isSelectable = (kind: ControlScript["kind"]) => kind === "select";

const isEditable = (control: ControlScript) =>
  (control.kind === "input" || control.kind === "textarea") && control.disabled !== true;

const isToggle = (control: ControlScript) =>
  control.kind === "input" && (control.inputType === "checkbox" || control.inputType === "radio");

/** Input types native fill types or assigns text into; every other input takes none. */
const textInputs = new Set([
  "",
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
  "color",
  "date",
  "time",
  "datetime-local",
  "month",
  "range",
  "week",
]);

/**
 * What the real driver refuses before dispatching text into a control: a disabled one, one that
 * takes no text, and a number field given something that is not a number.
 */
const textRefusal = (control: ControlScript, text: string): BrowserReason | undefined => {
  const editable = control.facts?.editable;

  if (control.disabled === true) return Reasons.Disabled.make({});
  if (editable === false) return Reasons.Unsupported.make({});
  if (control.kind === "textarea") return undefined;
  if (control.kind !== "input") return editable === true ? undefined : Reasons.Unsupported.make({});
  const type = (control.inputType ?? "").toLowerCase();

  if (!textInputs.has(type)) return Reasons.Unsupported.make({});

  return type === "number" && Number.isNaN(Number(text.trim()))
    ? Reasons.Unsupported.make({})
    : undefined;
};

const controlState = (script: ControlScript): ControlState => ({
  script,
  checked: script.checked ?? (isToggle(script) ? false : undefined),
  selected: script.selected,
});

export const makeScriptedBrowser = (script: Script, timers: EngineTimers): ScriptedBrowser => {
  const pages = new Map<string, Page>();
  const calls: Array<MutableCall> = [];
  const armed = new Map<ScriptableOperation, Array<ScriptedOutcome>>();
  const connections: Array<ScriptedConnection> = [];
  const live = new Set<Live>();
  let latest: Live | undefined;
  /** The page last selected by any connection: where the control's document operations act. */
  let lastSelected: string | undefined;
  let attempts = 0;
  let sequence = 0;
  let pageSerial = 0;
  let observationSerial = 0;
  let suspensionSerial = 0;
  let downloadSerial = 0;
  let lastTimestamp = 1_700_000_000_000;

  const state = (document: DocumentScript): DocumentState => ({
    url: document.url,
    title: document.title ?? "",
    text: document.text,
    controls: (document.controls ?? []).map(controlState),
  });

  const documentFor = (url: string): DocumentState => {
    const listed = script.documents.find((document) => document.url === url);

    return state(listed ?? { url, text: "" });
  };

  const createPage = (document: DocumentState, registered: boolean): Page => {
    const serial = ++pageSerial;

    const page: Page = {
      pageId: `page-${serial}`,
      targetId: `target-${serial}`,
      frameId: `frame-${serial}`,
      document,
      epoch: 0,
      registeredEpoch: registered ? 0 : -1,
      values: new Map(),
      files: new Map(),
      focused: undefined,
      closed: false,
      held: undefined,
      navigation: undefined,
      watchers: new Set(),
      capture: undefined,
    };

    pages.set(page.pageId, page);

    return page;
  };

  const openPages = () => [...pages.values()].filter((page) => !page.closed);

  const notify = (page: Page) => {
    const watchers = Array.from(page.watchers);

    for (const watcher of watchers) watcher();
  };

  /** The page shows a new document: nodes go stale, values reset, captures learn of it. */
  const commit = (page: Page, document: DocumentState) => {
    page.document = document;
    page.epoch++;
    page.values.clear();
    page.files.clear();
    page.focused = undefined;
    page.navigation = undefined;
    for (const connection of live) connection.retire(page.pageId);
    if (page.capture !== undefined) {
      const { start } = page.capture;

      if (start.document === undefined) start.invalidate("target-changed");
      else start.document(document.url);
    }
    notify(page);
    for (const connection of live) connection.announce(page.pageId);
  };

  /** In-document change: identity survives by control id, so retained nodes and waits carry on. */
  const update = (page: Page, document: DocumentScript) => {
    const previous = new Map(page.document.controls.map((control) => [control.script.id, control]));

    const controls = (document.controls ?? []).map((script): ControlState => {
      const existing = previous.get(script.id);

      if (existing === undefined) return controlState(script);
      existing.script = script;
      if (script.checked !== undefined) existing.checked = script.checked;
      if (script.selected !== undefined) existing.selected = script.selected;

      return existing;
    });

    page.document = {
      url: document.url,
      title: document.title ?? "",
      text: document.text,
      controls,
    };
    if (page.focused !== undefined && !previous.has(page.focused)) page.focused = undefined;
    notify(page);
  };

  const take = (operation: ScriptableOperation): ScriptedOutcome | undefined => {
    const queue = armed.get(operation);
    const next = queue?.shift();

    if (queue !== undefined && queue.length === 0) armed.delete(operation);

    return next;
  };

  const internalGate = (gate: Gate): InternalGate => {
    const internal = gates.get(gate);

    if (internal === undefined)
      throw new Error("A scripted gate must come from the browser it holds");

    return internal;
  };

  const connect = (options: DriverOptions, events: DriverEvents): Driver => {
    const ordinal = attempts++;

    if (script.connections?.[ordinal] === "refuse") {
      connections.push("refused");
      throw new Error("The scripted browser refused this connection");
    }

    const bindings: ReadonlyArray<NativeBinding> = options.bindings ?? [];
    let viewport: Viewport = { ...options.viewport };
    // Chromium keeps a pointer position per page; a receipt reports the one placed on its page.
    const positions = new Map<string, ViewportPoint>();
    let pointer: ViewportPoint | null = null;
    let selectedId: string | undefined;
    let snapshot: Snapshot | undefined;
    let disconnected = false;
    let index = -1;

    const place = (pageId: string, point: ViewportPoint) => {
      positions.set(pageId, point);
      pointer = point;
    };

    const receipt = (pageId: string): NativeInput => ({ position: positions.get(pageId) ?? null });

    const select = (pageId: string | undefined) => {
      selectedId = pageId;
      lastSelected = pageId;
    };

    const selectedPage = (operation: BrowserOperation = "target"): Page => {
      const page = selectedId === undefined ? undefined : pages.get(selectedId);

      if (disconnected || page === undefined || page.closed)
        throw fail(operation, Reasons.Closed.make({}));

      return page;
    };

    const current = (target: DriverTarget | undefined, operation: BrowserOperation): Page => {
      if (target === undefined) return selectedPage(operation);
      if (disconnected) throw fail(operation, Reasons.Closed.make({}));
      const page = pages.get(target.pageId);

      if (page === undefined || page.closed || page.frameId !== target.frameId)
        throw fail(operation, Reasons.Stale.make({}));

      return page;
    };

    const pageOf = (info: PageInfo, operation: BrowserOperation): Page => {
      const page = pages.get(info.pageId);

      if (page === undefined) throw fail(operation, Reasons.NotFound.make({}));
      if (page.closed || page.targetId !== info.targetId)
        throw fail(operation, Reasons.Stale.make({}));

      return page;
    };

    const info = (page: Page): PageInfo =>
      PageInfo.make({
        pageId: page.pageId,
        targetId: page.targetId,
        url: page.document.url,
        title: page.document.title,
        selected: page.pageId === selectedId,
      });

    const frameInfo = (page: Page): FrameInfo =>
      FrameInfo.make({
        frameId: page.frameId,
        parentFrameId: null,
        url: page.document.url,
        name: "",
      });

    const invalidateSnapshot = (scope: ObservationScope = "all") => {
      if (
        snapshot !== undefined &&
        scope !== "none" &&
        (scope === "all" || scope.pageId === snapshot.pageId)
      )
        snapshot.validity = "invalid";
    };

    /** This connection ends: what it held on the browser's pages ends with it. */
    const dropConnection = (announce: boolean, ended: ScriptedConnection = "dropped") => {
      if (disconnected) return;
      disconnected = true;
      connections[index] = ended;
      live.delete(connection);
      for (const page of pages.values()) {
        if (page.navigation?.by === connection) page.navigation.drop();
        if (page.held?.by === connection) page.held = undefined;
        if (page.capture?.by === connection) page.capture = undefined;
        notify(page);
      }
      if (announce) events.disconnected();
    };

    const dispatch = (ticket: ReadTicket, record: MutableCall) => {
      if ("dispatch" in ticket) (ticket as Ticket).dispatch();
      record.dispatched = true;
    };

    /** Once the owner aborts the admitted call, its own check names the reason. */
    const aborted = (ticket: ReadTicket, operation: BrowserOperation): BrowserError => {
      try {
        ticket.check();
      } catch (error) {
        if (Schema.is(BrowserError)(error)) return error;
      }

      return fail(operation, Reasons.Interrupted.make({}), "unknown");
    };

    const hold = (
      gate: Gate,
      ticket: ReadTicket,
      operation: BrowserOperation,
      record: MutableCall,
    ): Promise<void> => {
      const internal = internalGate(gate);

      internal.reach();

      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          // The owner has already decided; the recorder must not lag behind its fiber.
          record.settled = "failed";
          reject(aborted(ticket, operation));
        };

        const cleanup = () => ticket.signal.removeEventListener("abort", onAbort);

        if (ticket.signal.aborted) {
          onAbort();

          return;
        }
        ticket.signal.addEventListener("abort", onAbort, { once: true });
        void internal.opened.then(() => {
          cleanup();
          resolve();
        });
      });
    };

    const applyArmed = async (
      operation: ScriptableOperation,
      ticket: ReadTicket,
      record: MutableCall,
    ): Promise<void> => {
      const outcome = take(operation);

      if (outcome === undefined) return;
      switch (outcome._tag) {
        case "Fail": {
          if (outcome.outcome === "unknown") dispatch(ticket, record);
          throw fail(operation, outcome.reason, outcome.outcome);
        }
        case "Hold": {
          if (outcome.dispatched) dispatch(ticket, record);
          await hold(outcome.gate, ticket, operation, record);
          ticket.check();

          return;
        }
        case "Disconnect": {
          if (outcome.dispatched === true) dispatch(ticket, record);
          dropConnection(true);
          throw fail(
            operation,
            Reasons.Disconnected.make({}),
            record.dispatched ? "unknown" : "undispatched",
          );
        }
      }
    };

    const attempt = async <A>(
      operation: ScriptableOperation,
      ticket: ReadTicket | undefined,
      meta: {
        readonly pageId?: string;
        readonly elementId?: string;
        readonly selector?: string;
      },
      body: (record: MutableCall) => Promise<A>,
    ): Promise<A> => {
      const record: MutableCall = {
        sequence: ++sequence,
        operation,
        pageId: meta.pageId ?? selectedId ?? "",
        ...(meta.elementId === undefined ? {} : { elementId: meta.elementId }),
        ...(meta.selector === undefined ? {} : { selector: meta.selector }),
        dispatched: false,
        settled: "pending",
      };

      calls.push(record);
      try {
        ticket?.check();
        if (ticket !== undefined) await applyArmed(operation, ticket, record);
        const value = await body(record);

        record.settled = "completed";

        return value;
      } catch (error) {
        record.settled = "failed";
        throw error;
      }
    };

    const meta = (target: string | ObservedElement | undefined) =>
      target === undefined
        ? {}
        : typeof target === "string"
          ? { selector: target }
          : { elementId: target.elementId };

    const facts = (control: ControlState): ControlFacts => {
      const { script: value } = control;
      const extra = value.facts ?? {};

      return ControlFacts.make({
        kind: value.kind,
        label: value.label,
        disabled: value.disabled ?? false,
        ...(control.checked === undefined ? {} : { checked: control.checked }),
        ...(control.selected === undefined ? {} : { selected: control.selected }),
        ...(value.required === undefined ? {} : { required: value.required }),
        ...(value.multiple === undefined ? {} : { multiple: value.multiple }),
        editable: extra.editable ?? isEditable(value),
        ...(value.inputType === undefined ? {} : { inputType: value.inputType }),
        ...(extra.autocomplete === undefined ? {} : { autocomplete: extra.autocomplete }),
        ...(value.destination === undefined ? {} : { destination: value.destination }),
        ...(extra.formMethod === undefined ? {} : { formMethod: extra.formMethod }),
        box: ViewportRect.make(extra.box ?? { x: 0, y: 0, width: 120, height: 24 }),
        placement: extra.placement ?? (value.offscreen === true ? "outside" : "inside"),
        hitTest: extra.hitTest ?? (value.offscreen === true ? "unsampled" : "self"),
        mainFrame: true,
      });
    };

    const observed = (control: ControlState): ObservedControl => {
      const { script: value } = control;

      return ObservedControl.make({
        elementId: value.id,
        kind: value.kind,
        label: value.label,
        disabled: value.disabled ?? false,
        ...(control.checked === undefined ? {} : { checked: control.checked }),
        ...(control.selected === undefined ? {} : { selected: control.selected }),
        ...(value.inputType === undefined ? {} : { inputType: value.inputType }),
        ...(value.required === undefined ? {} : { required: value.required }),
        ...(value.multiple === undefined ? {} : { multiple: value.multiple }),
        ...(value.selectElementId === undefined ? {} : { selectElementId: value.selectElementId }),
      });
    };

    const bySelector = (page: Page, selector: string, operation: BrowserOperation) => {
      const id = selector.startsWith("#") ? selector.slice(1) : undefined;

      const control =
        id === undefined ? undefined : page.document.controls.find((c) => c.script.id === id);

      if (control === undefined) throw fail(operation, Reasons.NotFound.make({}));

      return control;
    };

    /** A retained node is only as current as the observation that produced it. */
    const retained = (
      target: ObservedElement,
      ticket: ReadTicket,
      operation: BrowserOperation,
      allowSuspended = false,
      attached = true,
    ) => {
      ticket.check();
      const stale = () => fail(operation, Reasons.Stale.make({}));
      const current = snapshot;

      if (current === undefined || current.id !== target.observationId) throw stale();
      const node = current.nodes.get(target.elementId);

      if (node === undefined) throw stale();
      if (current.validity === "invalid" || current.generation !== ticket.generation) throw stale();
      const page = pages.get(current.pageId);

      if (page === undefined || page.closed || page.epoch !== current.epoch) throw stale();
      if (selectedId !== current.pageId) throw stale();
      if (
        current.validity === "suspended" &&
        !allowSuspended &&
        !current.revalidated.has(target.elementId)
      )
        throw stale();
      if (attached && !page.document.controls.includes(node)) throw stale();

      return { node, page, snapshot: current };
    };

    const resolve = (
      target: string | ObservedElement,
      ticket: ReadTicket,
      operation: BrowserOperation,
      policy?: AdmissionPolicy,
      browserTarget?: DriverTarget,
      allowSuspended = false,
      enablement = false,
    ) => {
      let node: ControlState;
      let page: Page;

      if (typeof target === "string") {
        page = current(browserTarget, operation);
        node = bySelector(page, target, operation);
      } else {
        ({ node, page } = retained(target, ticket, operation, allowSuspended));
      }
      const fresh = facts(node);

      // A form step's control may have become enabled since it was observed; it must be now.
      if (enablement && node.script.disabled === true)
        throw fail(operation, Reasons.Disabled.make({}));
      if (policy !== undefined) {
        let admitted = false;

        try {
          admitted = policy(fresh) === true;
        } catch {
          admitted = false;
        }
        if (!admitted) throw fail(operation, Reasons.Denied.make({}));
      }
      ticket.check();

      return { node, page, facts: fresh };
    };

    const requireRunning = (page: Page, operation: BrowserOperation) => {
      if (page.held !== undefined) throw fail(operation, Reasons.Busy.make({}));
    };

    const heldObservation = (pageId: string) => {
      if (snapshot?.pageId === pageId && snapshot.validity === "valid") {
        snapshot.validity = "suspended";
        snapshot.revalidated.clear();
      }
    };

    const activate = (page: Page, node: ControlState) => {
      const { script: value } = node;

      page.focused = value.id;
      if (value.kind === "input" && value.inputType === "checkbox") node.checked = !node.checked;
      if (value.kind === "input" && value.inputType === "radio") node.checked = true;
      const target = value.destination ?? value.activates;

      if (target !== undefined) commit(page, documentFor(target));

      return page.document.url;
    };

    const focusedOrRefuse = (
      into: string | ObservedElement | undefined,
      ticket: ReadTicket,
      operation: BrowserOperation,
      policy: AdmissionPolicy | undefined,
      browserTarget: DriverTarget | undefined,
    ) => {
      if (into === undefined) return current(browserTarget, operation);
      const { node, page } = resolve(into, ticket, operation, policy, browserTarget);

      if (page.focused !== node.script.id) throw fail(operation, Reasons.NotFocused.make({}));

      return page;
    };

    const typed = (page: Page, text: string) => {
      const focused =
        page.focused === undefined
          ? undefined
          : page.document.controls.find((control) => control.script.id === page.focused);

      if (focused !== undefined && isEditable(focused.script))
        page.values.set(focused.script.id, (page.values.get(focused.script.id) ?? "") + text);
    };

    /** Issued options of one select, refused exactly where native selection refuses them. */
    const chosen = (node: ControlState, ids: SelectOptions, operation: BrowserOperation) => {
      const current = snapshot;

      if (current === undefined) throw fail(operation, Reasons.Stale.make({}));
      if (!isSelectable(node.script.kind)) throw fail(operation, Reasons.Unsupported.make({}));

      const options = ids.map((id) => {
        const option = current.nodes.get(id);

        if (option === undefined || option.script.selectElementId !== node.script.id)
          throw fail(operation, Reasons.Stale.make({}));

        return option;
      });

      if (
        node.script.disabled === true ||
        options.some((option) => option.script.disabled === true)
      )
        throw fail(operation, Reasons.Disabled.make({}));
      if (node.script.multiple !== true && options.length > 1)
        throw fail(operation, Reasons.Unsupported.make({}));

      return options;
    };

    const choose = (page: Page, node: ControlState, options: ReadonlyArray<ControlState>) => {
      if (node.script.multiple !== true)
        for (const candidate of page.document.controls)
          if (candidate.script.selectElementId === node.script.id) candidate.selected = false;
      for (const option of options) option.selected = true;
      page.focused = node.script.id;
    };

    /** A control's private state after a form step. It is compared here and never returned. */
    const fieldState = (page: Page, node: ControlState): string => {
      const { script: value } = node;

      if (node.checked !== undefined) return JSON.stringify(["checked", node.checked]);
      if (value.kind === "select")
        return JSON.stringify([
          "options",
          page.document.controls
            .filter((option) => option.script.selectElementId === value.id && option.selected)
            .map((option) => option.script.id),
        ]);
      if (value.kind === "input" || value.kind === "textarea" || value.facts?.editable === true)
        return JSON.stringify(["value", page.values.get(value.id) ?? ""]);

      return JSON.stringify(["other"]);
    };

    /** One form step, as the real driver takes it; see `Driver["formStep"]`. */
    const formStep = (
      page: Page,
      node: ControlState,
      field: FormField,
      ticket: Ticket,
      record: MutableCall,
    ) => {
      const epoch = page.epoch;
      let act: (() => void) | undefined;

      if (field.options !== undefined) {
        const options = chosen(node, field.options, "fill-form");

        act = () => choose(page, node, options);
      } else if (field.checked !== undefined) {
        if (node.checked === undefined) throw fail("fill-form", Reasons.Unsupported.make({}));
        if (node.checked !== field.checked) {
          if (!field.checked && node.script.inputType === "radio")
            throw fail("fill-form", Reasons.Unsupported.make({}));
          act = () => {
            activate(page, node);
          };
        }
      } else {
        const text = field.value ?? "";
        const refusal = textRefusal(node.script, text);

        if (refusal !== undefined) throw fail("fill-form", refusal);
        act = () => {
          page.values.set(node.script.id, text);
          // The step then leaves the control, as a person moving on would.
          page.focused = undefined;
        };
      }
      if (act !== undefined) {
        dispatch(ticket, record);
        act();
      }

      // A step that navigated away cannot be read back, which is never a failure of its own.
      const state =
        page.epoch === epoch && !page.closed && page.document.controls.includes(node)
          ? fieldState(page, node)
          : undefined;

      return {
        status: act === undefined ? ("unchanged" as const) : ("set" as const),
        reached:
          field.checked === undefined ||
          state === undefined ||
          state === JSON.stringify(["checked", field.checked]),
        state,
        url: page.document.url,
      };
    };

    const inFlight = (
      page: Page,
      url: string,
      outcome: ScriptedOutcome,
      timeoutMillis: number,
      record: MutableCall,
    ): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        let done = false;
        const timer = timers.sleep(timeoutMillis);

        const finish = (settle: () => void) => {
          if (done) return;
          done = true;
          timer.cancel();
          if (page.navigation === flight) page.navigation = undefined;
          settle();
        };

        const failed = (reason: BrowserReason) =>
          finish(() => {
            record.settled = "failed";
            reject(fail("navigate", reason, "unknown"));
          });

        const flight: InFlight = {
          stop: () => failed(Reasons.Interrupted.make({})),
          drop: () => failed(Reasons.Disconnected.make({})),
          by: connection,
        };

        page.navigation = flight;
        timer.done.then(
          () => failed(Reasons.Timeout.make({})),
          () => {},
        );
        switch (outcome._tag) {
          case "Fail": {
            failed(outcome.reason);

            return;
          }
          case "Disconnect": {
            dropConnection(true);

            return;
          }
          case "Hold": {
            const gate = internalGate(outcome.gate);

            gate.reach();
            void gate.opened.then(() =>
              finish(() => {
                commit(page, documentFor(url));
                resolve(url);
              }),
            );
          }
        }
      });

    const waitUntil = (
      ticket: WaitTicket,
      page: Page,
      operation: BrowserOperation,
      record: MutableCall,
      satisfied: () => boolean,
      detached: () => boolean,
    ): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          page.watchers.delete(check);
          ticket.signal.removeEventListener("abort", onAbort);
          ticket.retire();
        };

        const onAbort = () => {
          cleanup();
          record.settled = "failed";
          reject(aborted(ticket, operation));
        };

        const check = () => {
          try {
            ticket.check();
            if (disconnected) throw fail(operation, Reasons.Disconnected.make({}));
            if (detached()) throw fail(operation, Reasons.Stale.make({}));
            if (!satisfied()) return;
            cleanup();
            resolve();
          } catch (error) {
            cleanup();
            record.settled = "failed";
            reject(error);
          }
        };

        if (ticket.signal.aborted) {
          onAbort();

          return;
        }
        ticket.signal.addEventListener("abort", onAbort, { once: true });
        page.watchers.add(check);
        check();
      });

    const invokeBinding = async (
      name: string,
      input: unknown,
      origin: string | undefined,
    ): Promise<BindingReply> => {
      const binding = bindings.find((candidate) => candidate.name === name);

      if (binding === undefined) return { ok: false };
      const page = selectedId === undefined ? undefined : pages.get(selectedId);
      const epoch = page?.epoch;
      const documentOrigin = origin ?? (page === undefined ? "null" : originOf(page.document.url));
      const text = JSON.stringify(input) ?? "null";

      const error = (reason: InitializationError["reason"]) =>
        InitializationError.make({ operation: "callback", step: name, reason });

      const check = async (signal: AbortSignal) => {
        if (disconnected || signal.aborted) throw error("closed");
        if (page === undefined || page.closed || page.epoch !== epoch) throw error("stale");
        if (!binding.origins.includes(documentOrigin)) throw error("origin");
      };

      try {
        const reply = await binding.invoke({
          read: async (signal) => {
            await check(signal);

            return text;
          },
          check,
          dispose: async () => {},
        });

        return { ok: true, output: JSON.parse(reply) as unknown };
      } catch {
        return { ok: false };
      }
    };

    if (pages.size === 0) {
      // The first page shows the starting document, and predates every registration.
      const startUrl = script.start ?? script.documents[0]?.url ?? "https://scripted.invalid/";
      const first = createPage(documentFor(startUrl), true);

      select(first.pageId);
      if (options.initialTargetId !== undefined && options.initialTargetId !== first.targetId)
        throw fail("connect", Reasons.NotFound.make({}));
      if (options.newPage === true)
        select(createPage(state({ url: startUrl, text: "" }), false).pageId);
    } else if (options.initialTargetId !== undefined) {
      // A later connection reattaches to a page the browser already has.
      const target = openPages().find((page) => page.targetId === options.initialTargetId);

      if (target === undefined) throw fail("connect", Reasons.NotFound.make({}));
      select(target.pageId);
    } else if (options.newPage === true) {
      select(createPage(state({ url: "https://scripted.invalid/blank", text: "" }), false).pageId);
    } else {
      const previous = lastSelected === undefined ? undefined : pages.get(lastSelected);

      select(previous !== undefined && !previous.closed ? previous.pageId : openPages()[0]?.pageId);
    }

    const pageControl: Driver["pageControl"] = {
      state: async (page, ticket) => {
        ticket.check();
        const target = pageOf(page, "page-control");

        return PageExecutionState.make({
          pageId: target.pageId,
          targetId: target.targetId,
          state: target.held === undefined ? "running" : "suspended",
          ...(target.held === undefined ? {} : { suspensionId: target.held.suspensionId }),
        });
      },
      suspend: (page, ticket) =>
        attempt("page-suspend", ticket, { pageId: page.pageId }, async (record) => {
          const target = pageOf(page, "page-suspend");

          requireRunning(target, "page-suspend");
          dispatch(ticket, record);
          target.held = { suspensionId: `suspension-${++suspensionSerial}`, by: connection };
          heldObservation(target.pageId);

          return PageSuspension.make({
            pageId: target.pageId,
            targetId: target.targetId,
            suspensionId: target.held.suspensionId,
          });
        }),
      resume: (receipt, ticket) =>
        attempt("page-resume", ticket, { pageId: receipt.pageId }, async (record) => {
          const target = pages.get(receipt.pageId);

          if (
            target === undefined ||
            target.closed ||
            target.held === undefined ||
            target.targetId !== receipt.targetId ||
            target.held.suspensionId !== receipt.suspensionId
          )
            throw fail("page-resume", Reasons.Stale.make({}));
          dispatch(ticket, record);
          target.held = undefined;
          heldObservation(target.pageId);
        }),
      checkTarget: async (target, ticket) => {
        ticket.check();
        requireRunning(current(target, "page-control"), "page-control");
      },
    };

    const driver: Driver = {
      ...(options.pageControl === true ? { pageControl } : {}),
      selected: () => {
        const page = selectedPage();

        return { pageId: page.pageId, frameId: page.frameId };
      },
      selectedTargetId: async () => selectedPage().targetId,
      listPages: (ticket) => attempt("list-pages", ticket, {}, async () => openPages().map(info)),
      resolvePage: async (page, ticket) => {
        ticket.check();
        const target = pageOf(page, "target");

        return { pageId: target.pageId, frameId: target.frameId };
      },
      selectPage: (page, ticket) =>
        attempt("select-page", ticket, { pageId: page.pageId }, async () => {
          const target = pageOf(page, "select-page");

          select(target.pageId);
          // As the real driver does: moving the selection retires no observation and no wait.
          events.invalidate("target-changed", "none");
        }),
      newPage: (ticket) =>
        attempt("new-page", ticket, {}, async (record) => {
          if (openPages().length >= options.maxPages)
            throw fail(
              "new-page",
              Reasons.Limit.make({
                dimension: "pages",
                maximum: options.maxPages,
                observed: openPages().length,
              }),
            );
          dispatch(ticket, record);

          return info(
            createPage(state({ url: "https://scripted.invalid/blank", text: "" }), false),
          );
        }),
      closePage: (page, ticket) =>
        attempt("close-page", ticket, { pageId: page.pageId }, async (record) => {
          const target = pageOf(page, "close-page");

          dispatch(ticket, record);
          target.closed = true;
          target.navigation?.drop();
          target.capture?.start.invalidate("target-changed");
          target.capture = undefined;
          notify(target);
          if (selectedId === target.pageId) select(undefined);
          invalidateSnapshot({ pageId: target.pageId });
          events.invalidate("target-changed", { pageId: target.pageId });
          for (const other of live) {
            if (other === connection) continue;
            other.retire(target.pageId);
            other.announce(target.pageId);
          }
        }),
      listFrames: (ticket, page) =>
        attempt("list-frames", ticket, {}, async () => [
          frameInfo(page === undefined ? selectedPage("list-frames") : pageOf(page, "list-frames")),
        ]),
      resolveFrame: async (page, frame, ticket) => {
        ticket.check();
        const target = pageOf(page, "target");

        if (frame.frameId !== target.frameId) throw fail("target", Reasons.NotFound.make({}));

        return { pageId: target.pageId, frameId: target.frameId };
      },
      selectFrame: (id, ticket) =>
        attempt("select-frame", ticket, {}, async () => {
          const page = selectedPage("select-frame");

          if (id !== page.frameId) throw fail("select-frame", Reasons.NotFound.make({}));
          events.invalidate("target-changed", "none");
        }),
      beginNavigation: (url, timeoutMillis, ticket, target) =>
        attempt("navigate", undefined, { pageId: target?.pageId }, async (record) => {
          ticket.check();
          const page = current(target, "navigate");

          requireRunning(page, "navigate");
          const outcome = take("navigate");

          if (outcome?._tag === "Fail" && outcome.outcome !== "unknown")
            throw fail("navigate", outcome.reason, outcome.outcome);
          if (outcome?._tag === "Hold" && !outcome.dispatched) {
            await hold(outcome.gate, ticket, "navigate", record);
            ticket.check();
          }
          if (outcome?._tag === "Disconnect" && outcome.dispatched !== true) {
            dropConnection(true);
            throw fail("navigate", Reasons.Disconnected.make({}));
          }
          dispatch(ticket, record);
          page.navigation?.stop();

          const inFlightOutcome =
            outcome === undefined || (outcome._tag === "Hold" && !outcome.dispatched)
              ? undefined
              : outcome;

          let settled: Promise<string>;

          if (inFlightOutcome === undefined) {
            commit(page, documentFor(url));
            settled = Promise.resolve(url);
          } else {
            settled = inFlight(page, url, inFlightOutcome, timeoutMillis, record);
            void settled.catch(() => {});
          }

          const navigation: NativeNavigation = {
            pageId: page.pageId,
            mainFrame: true,
            settled,
            stop: (stopTicket, pending, onDispatch) =>
              attempt("navigate-stop", undefined, { pageId: page.pageId }, async (stopRecord) => {
                stopTicket.check();
                const armedStop = take("navigate-stop");

                if (armedStop?._tag === "Hold" && !armedStop.dispatched) {
                  await hold(armedStop.gate, stopTicket, "navigate-stop", stopRecord);
                  stopTicket.check();
                }
                if (!pending()) return "settled" as const;
                if (armedStop?._tag === "Fail" && armedStop.outcome !== "unknown")
                  throw fail("navigate-stop", armedStop.reason, armedStop.outcome);
                if (armedStop?._tag === "Disconnect" && armedStop.dispatched !== true) {
                  dropConnection(true);
                  throw fail("navigate-stop", Reasons.Disconnected.make({}));
                }
                dispatch(stopTicket, stopRecord);
                onDispatch();
                switch (armedStop?._tag) {
                  case "Fail":
                    throw fail("navigate-stop", armedStop.reason, "unknown");
                  case "Disconnect":
                    dropConnection(true);
                    throw fail("navigate-stop", Reasons.Disconnected.make({}), "unknown");
                  case "Hold":
                    if (armedStop.dispatched) {
                      await hold(armedStop.gate, stopTicket, "navigate-stop", stopRecord);
                      stopTicket.check();
                    }
                }
                page.navigation?.stop();

                return "dispatched" as const;
              }),
          };

          return navigation;
        }),
      readText: (selector, maximumBytes, ticket, target) =>
        attempt("read-text", ticket, { pageId: target?.pageId, ...meta(selector) }, async () => {
          const page = current(target, "read-text");

          if (selector === undefined) return bounded(page.document.text, maximumBytes).text;
          const control = bySelector(page, selector, "read-text");

          return bounded(control.script.text ?? control.script.label, maximumBytes).text;
        }),
      observe: (scope, maximumBytes, controls, ticket, match) =>
        attempt("observe", ticket, {}, async (): Promise<NativeObservation> => {
          const page = selectedPage("observe");
          const needle = match?.toLowerCase();

          const matches = (value: string) =>
            needle === undefined || value.toLowerCase().includes(needle);

          snapshot = undefined;

          // A select matches through its own label or an option's, and keeps its options with it.
          const selects = new Set(
            page.document.controls
              .filter(
                (control) =>
                  isSelectable(control.script.kind) &&
                  (matches(control.script.label) ||
                    page.document.controls.some(
                      (option) =>
                        option.script.selectElementId === control.script.id &&
                        matches(option.script.label),
                    )),
              )
              .map((control) => control.script.id),
          );

          const matching = page.document.controls.filter((control) =>
            control.script.selectElementId !== undefined
              ? selects.has(control.script.selectElementId)
              : isSelectable(control.script.kind)
                ? selects.has(control.script.id)
                : matches(control.script.label),
          );

          const reachable = matching.filter(
            (control) => scope === "document" || control.script.offscreen !== true,
          );

          const kept = reachable.slice(0, controls);

          const text = bounded(
            needle === undefined
              ? page.document.text
              : page.document.text
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line !== "" && matches(line))
                  .join("\n"),
            maximumBytes,
          );

          const next: Snapshot = {
            id: `observation-${++observationSerial}`,
            pageId: page.pageId,
            epoch: page.epoch,
            generation: ticket.generation,
            validity: "valid",
            nodes: new Map(kept.map((control) => [control.script.id, control])),
            revalidated: new Set(),
          };

          snapshot = next;

          return {
            observationId: next.id,
            scope,
            ...(match === undefined ? {} : { match }),
            url: page.document.url,
            text: text.text,
            textTruncated: text.truncated,
            controls: kept.map(observed),
            controlsTruncated: kept.length < reachable.length,
            viewport: ViewportEvidence.make({
              width: viewport.width,
              height: viewport.height,
              clippedText: 0,
              coveredText: 0,
              uncertainText: 0,
              unreachableControls: matching.length - reachable.length,
              exhausted: false,
            }),
          };
        }),
      checkpoint: (maximumBytes, controls, pictureBytes, ticket) =>
        attempt("checkpoint", ticket, {}, async (): Promise<NativeCheckpoint> => {
          const page = selectedPage("checkpoint");
          const text = bounded(page.document.text, maximumBytes);

          const reachable = page.document.controls.filter(
            (control) => control.script.offscreen !== true,
          );

          return {
            url: page.document.url,
            text: text.text,
            textTruncated: text.truncated,
            controls: reachable.slice(0, controls).map(facts),
            controlsTruncated: reachable.length > controls,
            viewport: ViewportEvidence.make({
              width: viewport.width,
              height: viewport.height,
              clippedText: 0,
              coveredText: 0,
              uncertainText: 0,
              unreachableControls: page.document.controls.length - reachable.length,
              exhausted: false,
            }),
            documentChanged: false,
            ...(pictureBytes === undefined ? {} : { picture: new Uint8Array(PNG) }),
          };
        }),
      controlFacts: (target, ticket) =>
        attempt("control-facts", ticket, meta(target), async () => {
          selectedPage("control-facts");

          return resolve(target, ticket, "control-facts").facts;
        }),
      revalidate: (target, ticket) =>
        attempt("revalidate", ticket, meta(target), async () => {
          const { snapshot: current } = retained(target, ticket, "revalidate", true);

          current.revalidated.add(target.elementId);
        }),
      click: (target, ticket, policy, browserTarget) =>
        attempt(
          "click",
          ticket,
          { pageId: browserTarget?.pageId, ...meta(target) },
          async (record) => {
            const { node, page } = resolve(target, ticket, "click", policy, browserTarget);

            requireRunning(page, "click");
            dispatch(ticket, record);

            return activate(page, node);
          },
        ),
      fill: (target, value, ticket, policy, browserTarget) =>
        attempt(
          "fill",
          ticket,
          { pageId: browserTarget?.pageId, ...meta(target) },
          async (record) => {
            const { node, page } = resolve(target, ticket, "fill", policy, browserTarget);

            requireRunning(page, "fill");
            const refusal = textRefusal(node.script, value);

            if (refusal !== undefined) throw fail("fill", refusal);
            dispatch(ticket, record);
            page.focused = node.script.id;
            page.values.set(node.script.id, value);

            return page.document.url;
          },
        ),
      selectOption: (target, ids, ticket, policy) =>
        attempt("select-option", ticket, meta(target), async (record) => {
          const { node, page } = resolve(target, ticket, "select-option", policy);

          requireRunning(page, "select-option");
          const options = chosen(node, ids as SelectOptions, "select-option");

          dispatch(ticket, record);
          choose(page, node, options);

          return page.document.url;
        }),
      formStep: (target, field, ticket, policy) =>
        attempt("fill-form", ticket, meta(target), async (record) => {
          const { node, page } = resolve(
            target,
            ticket,
            "fill-form",
            policy,
            undefined,
            false,
            true,
          );

          requireRunning(page, "fill-form");

          return formStep(page, node, field, ticket, record);
        }),
      formState: (targets, ticket) =>
        attempt("fill-form", ticket, {}, async () =>
          targets.map((target) => {
            // A node the form's own steps detached reads as absent rather than stale.
            const { node, page } = retained(target, ticket, "fill-form", false, false);

            return page.document.controls.includes(node) ? fieldState(page, node) : undefined;
          }),
        ),
      formSubmit: (target, ticket, policy) =>
        attempt("fill-form", ticket, meta(target), async (record) => {
          const { node, page } = resolve(
            target,
            ticket,
            "fill-form",
            policy,
            undefined,
            false,
            true,
          );

          requireRunning(page, "fill-form");
          dispatch(ticket, record);

          return activate(page, node);
        }),
      scroll: (_deltaX, _deltaY, ticket, target) =>
        attempt("scroll", ticket, { pageId: target?.pageId }, async (record) => {
          const page = current(target, "scroll");

          requireRunning(page, "scroll");
          dispatch(ticket, record);

          return page.document.url;
        }),
      pointerMove: (to, ticket, target) =>
        attempt(
          "pointer-move",
          ticket,
          { pageId: target?.pageId },
          async (record): Promise<NativeInput> => {
            const page = current(target, "pointer-move");

            requireRunning(page, "pointer-move");
            dispatch(ticket, record);
            place(page.pageId, { x: to.x, y: to.y });

            return receipt(page.pageId);
          },
        ),
      hover: (target, ticket, policy, browserTarget) =>
        attempt(
          "hover",
          ticket,
          { pageId: browserTarget?.pageId, ...meta(target) },
          async (record): Promise<NativeInput> => {
            const {
              node,
              page,
              facts: fresh,
            } = resolve(target, ticket, "hover", policy, browserTarget);

            requireRunning(page, "hover");
            if (node.script.offscreen === true) throw fail("hover", Reasons.NotVisible.make({}));
            dispatch(ticket, record);
            place(page.pageId, {
              x: fresh.box.x + fresh.box.width / 2,
              y: fresh.box.y + fresh.box.height / 2,
            });

            return receipt(page.pageId);
          },
        ),
      wheel: (_deltaX, _deltaY, at, ticket, target) =>
        attempt(
          "wheel",
          ticket,
          { pageId: target?.pageId },
          async (record): Promise<NativeInput> => {
            const page = current(target, "wheel");

            requireRunning(page, "wheel");
            dispatch(ticket, record);
            if (at !== undefined) place(page.pageId, { x: at.x, y: at.y });

            return receipt(page.pageId);
          },
        ),
      press: (key, _modifiers: ReadonlyArray<KeyModifier>, into, ticket, policy, browserTarget) =>
        attempt(
          "press",
          ticket,
          { pageId: browserTarget?.pageId, ...meta(into) },
          async (record): Promise<NativeInput> => {
            const page = focusedOrRefuse(into, ticket, "press", policy, browserTarget);

            requireRunning(page, "press");
            dispatch(ticket, record);
            if (key.length === 1) typed(page, key);

            return receipt(page.pageId);
          },
        ),
      type: (text, into, ticket, policy, browserTarget) =>
        attempt(
          "type",
          ticket,
          { pageId: browserTarget?.pageId, ...meta(into) },
          async (record): Promise<NativeInput> => {
            const page = focusedOrRefuse(into, ticket, "type", policy, browserTarget);

            requireRunning(page, "type");
            dispatch(ticket, record);
            typed(page, text);

            return receipt(page.pageId);
          },
        ),
      screenshot: (_fullPage, _maximumBytes, ticket, target) =>
        attempt("screenshot", ticket, { pageId: target?.pageId }, async () => {
          current(target, "screenshot");

          return new Uint8Array(PNG);
        }),
      resize: (next, ticket) =>
        attempt("resize", ticket, {}, async (record) => {
          const page = selectedPage("resize");

          dispatch(ticket, record);
          viewport = { width: next.width, height: next.height };
          page.capture?.start.invalidate("resized");
          events.invalidate("resized");
        }),
      waitFor: (selector, state, ticket, target) =>
        attempt("wait", ticket, { pageId: target.pageId, selector }, async (record) => {
          const page = current(target, "wait");
          const epoch = page.epoch;

          const find = () => {
            const id = selector.startsWith("#") ? selector.slice(1) : undefined;

            return id === undefined
              ? undefined
              : page.document.controls.find((control) => control.script.id === id);
          };

          await waitUntil(
            ticket,
            page,
            "wait",
            record,
            () => {
              const control = find();
              const present = control !== undefined;
              const visible = present && control.script.offscreen !== true;

              switch (state) {
                case "visible":
                  return visible;
                case "hidden":
                  return !visible;
                case "attached":
                  return present;
                case "detached":
                  return !present;
              }
            },
            () => page.closed || page.epoch !== epoch,
          );
        }).finally(() => ticket.retire()),
      waitForElement: (reference, state, ticket, target) =>
        attempt(
          "wait",
          ticket,
          { pageId: target.pageId, elementId: reference.elementId },
          async (record) => {
            const page = current(target, "wait");
            const { node } = retained(reference, ticket, "wait", true);
            const epoch = page.epoch;

            await waitUntil(
              ticket,
              page,
              "wait",
              record,
              () => {
                const present = page.document.controls.includes(node);
                const visible = present && node.script.offscreen !== true;

                switch (state satisfies WaitForElementRequest["state"]) {
                  case "visible":
                    return visible;
                  case "hidden":
                    return !visible;
                  case "enabled":
                    return present && node.script.disabled !== true;
                  case "disabled":
                    return present && node.script.disabled === true;
                }
              },
              () => page.closed || page.epoch !== epoch,
            );
          },
        ).finally(() => ticket.retire()),
      clickAndWait: (target, ticket) =>
        attempt("click-and-wait", ticket, meta(target), async (record) => {
          const { node, page } = resolve(target, ticket, "click-and-wait");

          requireRunning(page, "click-and-wait");
          dispatch(ticket, record);

          return activate(page, node);
        }),
      clickForDownload: (target, ticket) =>
        attempt("download-action", ticket, meta(target), async (record) => {
          const { node, page } = resolve(target, ticket, "download-action");

          requireRunning(page, "download-action");
          if (node.script.download === undefined)
            throw fail("download-action", Reasons.Unsupported.make({}));
          dispatch(ticket, record);
          page.focused = node.script.id;

          return {
            downloadId: `download-${++downloadSerial}`,
            filename: node.script.download,
            state: "completed" as const,
          };
        }),
      selectFiles: (target, files, ticket) =>
        attempt("select-files", ticket, meta(target), async (record) =>
          selectFilesOn(target, files, ticket, record, "select-files"),
        ),
      clickForFileSelection: (target, files, ticket) =>
        attempt("file-chooser", ticket, meta(target), async (record) =>
          selectFilesOn(target, files, ticket, record, "file-chooser"),
        ),
      documentReadiness: async (ticket, target): Promise<ReadinessState> => {
        ticket.check();
        const page = current(target, "ready");
        const bootstrap = options.bootstrap;

        if (bootstrap === undefined || bootstrap.readiness.length === 0) return { _tag: "Ready" };
        if (
          page.epoch <= page.registeredEpoch &&
          bootstrap.existingDocuments === "RequireFreshNavigation"
        )
          return { _tag: "RequiresNavigation" };
        const origin = originOf(page.document.url);

        const applicable = bootstrap.readiness.some(
          (requirement) =>
            requirement.origins === undefined || requirement.origins.includes(origin),
        );

        return applicable ? { _tag: "Ready" } : { _tag: "NotApplicable" };
      },
      dismissDialogs: async () => {},
      capture: async (target): Promise<CaptureBinding> => {
        const page =
          target === undefined
            ? selectedPage("capture")
            : pageOf(
                PageInfo.make({
                  pageId: target.pageId,
                  targetId: target.targetId,
                  url: "",
                  title: "",
                  selected: false,
                }),
                "capture",
              );

        return {
          pageId: page.pageId,
          targetId: page.targetId,
          frameId: page.frameId,
          source: {
            start: async (start) => {
              if (disconnected || page.closed) throw fail("capture-start", Reasons.Closed.make({}));
              page.capture = { start, by: connection };
              start.opened?.(page.document.url);
            },
            stop: async () => {
              page.capture = undefined;
              const outcome = take("capture-stop");

              if (outcome?._tag === "Fail")
                throw fail("capture-stop", outcome.reason, outcome.outcome);
            },
          },
        };
      },
      invalidateObservation: (scope) => {
        invalidateSnapshot(scope);
      },
      disconnect: async () => {
        if (disconnected) return;
        const outcome = take("disconnect");

        if (outcome?._tag === "Hold") {
          // A native disconnect cannot be aborted: it waits for the gate however long cleanup does.
          const gate = internalGate(outcome.gate);

          gate.reach();
          await gate.opened;
        }
        if (outcome?._tag === "Fail") {
          dropConnection(false, "close-failed");
          throw fail("disconnect", outcome.reason, outcome.outcome);
        }
        dropConnection(false, "closed");
      },
    };

    const selectFilesOn = (
      target: string | ObservedElement,
      files: ReadonlyArray<NativeFileSelection>,
      ticket: Ticket,
      record: MutableCall,
      operation: "select-files" | "file-chooser",
    ) => {
      const { node, page } = resolve(target, ticket, operation);

      requireRunning(page, operation);
      if (node.script.kind !== "input" || node.script.inputType !== "file")
        throw fail(operation, Reasons.Unsupported.make({}));
      dispatch(ticket, record);
      page.files.set(
        node.script.id,
        files.map((file) => (file._tag === "Inline" ? file.name : file.path)),
      );

      return page.document.url;
    };

    const connection: Live = {
      retire: (pageId) => invalidateSnapshot({ pageId }),
      announce: (pageId) => events.invalidate("target-changed", { pageId }),
      drop: () => dropConnection(true),
      invoke: invokeBinding,
      pointer: () => pointer,
      viewport: () => viewport,
    };

    index = connections.push("open") - 1;
    live.add(connection);
    latest = connection;

    return driver;
  };

  const toScript = (document: DocumentState): DocumentScript => ({
    url: document.url,
    title: document.title,
    text: document.text,
    controls: document.controls.map((control) => ({
      ...control.script,
      ...(control.checked === undefined ? {} : { checked: control.checked }),
      ...(control.selected === undefined ? {} : { selected: control.selected }),
    })),
  });

  /** The page last selected by any connection; it stays reachable while no connection is open. */
  const selectedOrClosed = Effect.suspend(() => {
    const page = lastSelected === undefined ? undefined : pages.get(lastSelected);

    return page === undefined || page.closed
      ? Effect.fail(fail("target", Reasons.Closed.make({})))
      : Effect.succeed(page);
  });

  const control: ScriptedControl = {
    calls: Effect.sync(() => calls.map((call) => Object.freeze({ ...call }))),
    next: (operation, outcome) =>
      Effect.sync(() => {
        const queue = armed.get(operation) ?? [];

        queue.push(outcome);
        armed.set(operation, queue);
      }),
    gate: makeGate,
    document: {
      current: selectedOrClosed.pipe(Effect.map((page) => toScript(page.document))),
      replace: (next) =>
        checked(DocumentScript, next, "configure").pipe(
          Effect.flatMap((document) =>
            selectedOrClosed.pipe(
              Effect.map((page) => {
                page.navigation?.stop();
                commit(page, state(document));
              }),
            ),
          ),
        ),
      update: (next) =>
        checked(DocumentScript, next, "configure").pipe(
          Effect.flatMap((document) =>
            selectedOrClosed.pipe(
              Effect.map((page) => {
                update(page, document);
              }),
            ),
          ),
        ),
      values: Effect.sync(() =>
        lastSelected === undefined ? new Map() : new Map(pages.get(lastSelected)?.values ?? []),
      ),
      files: Effect.sync(() =>
        lastSelected === undefined ? new Map() : new Map(pages.get(lastSelected)?.files ?? []),
      ),
    },
    pointer: Effect.sync(() => latest?.pointer() ?? null),
    capture: {
      emit: (frame: ScriptedFrame = {}) =>
        selectedOrClosed.pipe(
          Effect.flatMap((page) => {
            const running = page.capture?.start;

            if (running === undefined)
              return Effect.fail(fail("capture-consume", Reasons.NotFound.make({})));
            const timestamp = frame.timestamp ?? lastTimestamp + 40;
            const viewport = page.capture?.by.viewport() ?? { width: 0, height: 0 };

            lastTimestamp = Math.max(lastTimestamp, timestamp);

            return Effect.sync(() => {
              running.receive({
                data: frame.bytes ?? jpegFrame(),
                timestamp,
                viewportWidth: frame.viewportWidth ?? viewport.width,
                viewportHeight: frame.viewportHeight ?? viewport.height,
              });
            });
          }),
        ),
    },
    invoke: (name, input, invokeOptions) =>
      Effect.promise(() => {
        const open = [...live].at(-1);

        return open === undefined
          ? Promise.resolve<BindingReply>({ ok: false })
          : open.invoke(name, input, invokeOptions?.origin);
      }),
    disconnect: Effect.sync(() => {
      for (const connection of [...live]) connection.drop();
    }),
    connections: Effect.sync(() => [...connections]),
  };

  return { connect, control };
};
