import { Schema } from "effect";
import type { BrowserContext, Download, ElementHandle, FileChooser, Frame } from "playwright-core";

import type { ObservedElement } from "../../BrowserData.ts";
import { SafeFilename } from "../../Transfers.ts";
import type { Driver, NativeFileSelection } from "./Driver.ts";
import {
  closeWithin,
  failure,
  type NativeFailure,
  safeDecode,
  sanitize,
  timeout,
} from "./NativeCalls.ts";
import type { AdmissionPolicy, Observation } from "./Observation.ts";
import type { Ticket } from "./Owner.ts";
import type { Targets } from "./Targets.ts";

export const waitEvent = <A>(
  add: (listener: (value: A) => void) => void,
  remove: (listener: (value: A) => void) => void,
  ticket: Ticket,
  accepts: (value: A) => boolean = () => true,
) => {
  let done = false;
  let resolve: (value: A) => void = () => {};
  let reject: (error: NativeFailure) => void = () => {};

  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  // Attach a rejection observer immediately, even while the action is still running.
  void promise.catch(() => {});

  const cleanup = () => {
    remove(listener);
    ticket.signal.removeEventListener("abort", abort);
    clearTimeout(timer);
  };

  const abort = () => {
    if (!done) {
      done = true;
      cleanup();
      reject(failure("interrupted"));
    }
  };

  const listener = (value: A) => {
    if (!done && accepts(value)) {
      done = true;
      cleanup();
      resolve(value);
    }
  };

  const timer = setTimeout(() => {
    if (!done) {
      done = true;
      cleanup();
      reject(failure("timeout"));
    }
  }, ticket.remainingMillis());

  add(listener);
  ticket.signal.addEventListener("abort", abort, { once: true });
  if (ticket.signal.aborted) abort();

  return { promise, cancel: abort };
};

/**
 * In-memory bytes and provider-stored paths reach the page by different mechanisms and are
 * never mixed: the first is streamed from this client, the second is opened by the browser
 * process itself. A mixed request is a configuration error, not a native surprise later.
 */
export const nativeSelection = (
  files: ReadonlyArray<NativeFileSelection>,
):
  | {
      readonly _tag: "Inline";
      readonly payload: Array<{ name: string; mimeType: string; buffer: Buffer }>;
    }
  | { readonly _tag: "Remote"; readonly paths: Array<string> } => {
  if (files.length === 0) throw failure("configuration", "undispatched");
  const inline = files.filter((file) => file._tag === "Inline");
  const remote = files.filter((file) => file._tag === "Remote");

  // The maintained native API encodes a Node Buffer; this lazily loaded driver already
  // requires the Node-only Playwright peer, so the conversion belongs here and nowhere else.
  if (inline.length === files.length) {
    return {
      _tag: "Inline",
      payload: inline.map((file) => ({
        name: file.name,
        mimeType: file.mediaType,
        buffer: Buffer.from(file.bytes),
      })),
    };
  }
  if (remote.length === files.length)
    return { _tag: "Remote", paths: remote.map((file) => file.path) };
  throw failure("configuration", "undispatched");
};

/**
 * Input to the selected document. A mutation marks its ticket dispatched immediately before the
 * one native command that may change the page; any outcome after that point is uncertain.
 */
export const makeActions = (
  context: BrowserContext,
  targets: Targets,
  observation: Observation,
) => {
  const { current } = targets;
  let downloadSerial = 0;

  const postUrl = () => {
    const value = targets.selectedUrl();
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw failure("malformed");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw failure("malformed");

    return value;
  };

  /**
   * Acts on the exact attached node a target names. The observation seam establishes that it is
   * still the control that was inspected and that the host's policy, if any, admits it. `admit`
   * then sees that node before anything is dispatched, so a refusal it raises is undispatched
   * too, and what it learns reaches the action without the node being resolved a second time.
   */
  const withAdmittedElement = async <Admitted, A>(
    target: string | ObservedElement,
    ticket: Ticket,
    admit: (element: ElementHandle<Element>) => Promise<Admitted>,
    action: (element: ElementHandle<Element>, admitted: Admitted) => Promise<A>,
    policy?: AdmissionPolicy,
  ): Promise<A> => {
    const { element, kept } = await observation.resolve(target, ticket, policy);

    try {
      const admitted = await admit(element);

      ticket.check();
      // ElementHandle actions do not re-resolve the selector onto a replacement node.
      ticket.dispatch();

      return await action(element, admitted);
    } finally {
      if (!kept) await closeWithin(() => element.dispose()).catch(() => {});
    }
  };

  const withElement = <A>(
    target: string | ObservedElement,
    ticket: Ticket,
    action: (element: ElementHandle<Element>) => Promise<A>,
    policy?: AdmissionPolicy,
  ): Promise<A> => withAdmittedElement(target, ticket, async () => {}, action, policy);

  const click = (target: string | ObservedElement, ticket: Ticket, policy?: AdmissionPolicy) =>
    sanitize(async () => {
      await withElement(
        target,
        ticket,
        (element) => element.click({ timeout: timeout(ticket) }),
        policy,
      );
      ticket.check();

      return postUrl();
    });

  /**
   * A file the provider already stores is named to the browser process, which opens it; this
   * client never reads that path. Exactly one main-frame node may match, and exactly one
   * command dispatches. A retained node or child frame is refused rather than approximated.
   */
  const attachStoredFiles = async (
    target: string | ObservedElement,
    paths: ReadonlyArray<string>,
    ticket: Ticket,
  ) => {
    if (typeof target !== "string") throw failure("unsupported", "undispatched");
    const { entry, frame } = current();

    if (frame !== entry.page.mainFrame()) throw failure("unsupported", "undispatched");
    const cdp = await context.newCDPSession(entry.page);

    try {
      ticket.check();

      const root = safeDecode(
        Schema.Struct({ root: Schema.Struct({ nodeId: Schema.Int }) }),
        await cdp.send("DOM.getDocument", { depth: 0 }),
      );

      const matched = safeDecode(
        Schema.Struct({ nodeIds: Schema.Array(Schema.Int).check(Schema.isMaxLength(64)) }),
        await cdp.send("DOM.querySelectorAll", { nodeId: root.root.nodeId, selector: target }),
      );

      ticket.check();
      const nodeId = matched.nodeIds[0];

      if (matched.nodeIds.length !== 1 || nodeId === undefined)
        throw failure(matched.nodeIds.length === 0 ? "not-found" : "ambiguous", "undispatched");
      ticket.dispatch();
      await cdp.send("DOM.setFileInputFiles", { files: [...paths], nodeId });
    } finally {
      await closeWithin(() => cdp.detach()).catch(() => {});
    }
  };

  const navigate: Driver["navigate"] = (url, ticket) =>
    sanitize(async () => {
      const { frame } = current();

      ticket.dispatch();
      await frame.goto(url, { waitUntil: "domcontentloaded", timeout: timeout(ticket) });
      ticket.check();

      return postUrl();
    });

  const fill: Driver["fill"] = (target, value, ticket, policy) =>
    sanitize(async () => {
      await withElement(
        target,
        ticket,
        (element) => element.fill(value, { timeout: timeout(ticket) }),
        policy,
      );
      ticket.check();

      return postUrl();
    });

  const scroll: Driver["scroll"] = (deltaX, deltaY, ticket) =>
    sanitize(async () => {
      const { frame } = current();

      ticket.dispatch();
      await frame.evaluate(
        ({ x, y }) => window.scrollBy({ left: x, top: y, behavior: "instant" }),
        { x: deltaX, y: deltaY },
      );
      ticket.check();

      return postUrl();
    });

  const waitFor: Driver["waitFor"] = (selector, state, ticket) =>
    sanitize(async () => {
      const node = await current().frame.waitForSelector(selector, {
        state,
        strict: true,
        timeout: timeout(ticket),
      });

      await node?.dispose();
      ticket.check();
    });

  const clickAndWait: Driver["clickAndWait"] = (target, ticket) =>
    sanitize(async () => {
      const { entry, frame } = current();

      const observer = waitEvent<Frame>(
        (on) => entry.page.on("framenavigated", on),
        (off) => entry.page.off("framenavigated", off),
        ticket,
        (changedFrame) => changedFrame === frame,
      );

      try {
        await click(target, ticket);
        await observer.promise;
        await frame.waitForLoadState("domcontentloaded", { timeout: timeout(ticket) });
        ticket.check();

        return postUrl();
      } finally {
        observer.cancel();
      }
    });

  const clickForDownload: Driver["clickForDownload"] = (target, ticket) =>
    sanitize(async () => {
      const page = current().entry.page;

      const observer = waitEvent<Download>(
        (on) => page.on("download", on),
        (off) => page.off("download", off),
        ticket,
      );

      try {
        await click(target, ticket);
        const download = await observer.promise;

        const filename = safeDecode(SafeFilename, download.suggestedFilename());

        const error = await download.failure();

        ticket.check();

        return {
          downloadId: `native-download-${++downloadSerial}`,
          filename,
          state: error === null ? "completed" : "failed",
        };
      } finally {
        observer.cancel();
      }
    });

  const selectFiles: Driver["selectFiles"] = (target, files, ticket) =>
    sanitize(async () => {
      const selection = nativeSelection(files);

      if (selection._tag === "Remote") await attachStoredFiles(target, selection.paths, ticket);
      else
        await withElement(target, ticket, (element) =>
          element.setInputFiles(selection.payload, { timeout: timeout(ticket) }),
        );
      ticket.check();

      return postUrl();
    });

  const clickForFileSelection: Driver["clickForFileSelection"] = (target, files, ticket) =>
    sanitize(async () => {
      const selection = nativeSelection(files);

      // A chooser is satisfied with bytes this client holds. A provider-stored file is
      // attached to an exact input node instead, where the browser can open the path.
      if (selection._tag === "Remote") throw failure("unsupported", "undispatched");
      const page = current().entry.page;

      const observer = waitEvent<FileChooser>(
        (on) => page.on("filechooser", on),
        (off) => page.off("filechooser", off),
        ticket,
      );

      try {
        await click(target, ticket);
        const chooser = await observer.promise;

        ticket.check();
        if (!chooser.isMultiple() && selection.payload.length > 1) throw failure("unsupported");
        // Exactly one attachment for this chooser; a second would open another dispatch.
        await chooser.setFiles(selection.payload, { timeout: timeout(ticket) });
        ticket.check();

        return postUrl();
      } finally {
        observer.cancel();
      }
    });

  return {
    withAdmittedElement,
    navigate,
    click,
    fill,
    scroll,
    waitFor,
    clickAndWait,
    clickForDownload,
    selectFiles,
    clickForFileSelection,
  };
};
