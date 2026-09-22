import { Schema } from "effect";
import type { BrowserContext, Disposable, Frame, Page } from "playwright-core";

import { Reasons, InitializationError } from "../../Errors.ts";
import type { CompiledBootstrap } from "./Bootstrap.ts";
import type { CallbackTasks } from "./CallbackTasks.ts";
import type {
  Driver,
  DriverEvents,
  DriverOptions,
  DriverTarget,
  ReadinessState,
} from "./Driver.ts";
import { makeNativeBindings } from "./NativeBindings.ts";
import { failure, NativeFailure, sanitize } from "./NativeCalls.ts";
import type { Ticket } from "./Owner.ts";
import type { Targets } from "./Targets.ts";

/**
 * The connection's bootstrap registrations and native bindings, and the readiness of the selected
 * document under that bootstrap. Fencing is synchronous; disposal removes what was registered.
 */
export const makeInitialization = (
  context: BrowserContext,
  options: DriverOptions,
  targets: Targets,
  callbacks: CallbackTasks,
  events: DriverEvents,
  closing: () => boolean,
) => {
  const { current, entries, epochOf } = targets;
  const registeredEpochs = new WeakMap<Frame, number>();
  const readyDocuments = new WeakMap<Frame, number>();
  const registrations: Disposable[] = [];
  let initializationClosed = false;
  let disposal: Promise<void> | undefined;

  const initializationFault = (error: InitializationError) => {
    if (closing() || initializationClosed) return;
    if (options.onBindingFault === undefined)
      events.fault({
        source: "native",
        reason: "registration",
        disposition: error.reason === "busy" ? "not-dispatched" : "unknown",
      });
    else options.onBindingFault(error);
  };

  const bindingTask = (action: () => Promise<void>) => {
    const admitted = callbacks.submit(async () => {
      try {
        await action();
      } catch (cause) {
        initializationFault(
          Schema.is(InitializationError)(cause)
            ? cause
            : InitializationError.make({
                operation: "register",
                step: "bindings",
                reason: "native",
              }),
        );
      }
    }, "reject-call");

    if (!admitted)
      initializationFault(
        InitializationError.make({ operation: "register", step: "bindings", reason: "busy" }),
      );
  };

  const bindings =
    options.bindings === undefined || options.bindings.length === 0
      ? undefined
      : makeNativeBindings(context, options.bindings, () =>
          initializationFault(
            InitializationError.make({ operation: "register", step: "bindings", reason: "busy" }),
          ),
        );

  const attach = async (page: Page) => {
    if (bindings === undefined) return;
    await bindings.attach(page, page);
    for (const frame of page.frames())
      if (frame !== page.mainFrame()) await bindings.attach(frame, page);
  };

  const fence = () => {
    initializationClosed = true;
    bindings?.close();
  };

  const dispose = (): Promise<void> => {
    fence();
    disposal ??= (async () => {
      const outcomes = await Promise.allSettled([
        ...registrations.splice(0).map((registration) => registration.dispose()),
        ...(bindings === undefined ? [] : [bindings.dispose()]),
      ]);

      if (outcomes.some((result) => result.status === "rejected"))
        throw failure(Reasons.Provider.make({}));
    })();

    return disposal;
  };

  /** Attaches a page this connection registered after initialization, off the event path. */
  const attachPage = (page: Page) => {
    if (bindings !== undefined) bindingTask(() => attach(page));
  };

  /** Attaches the new document of a frame that navigated after initialization. */
  const attachFrame = (frame: Frame, page: Page) => {
    if (bindings !== undefined) bindingTask(() => bindings.attach(frame, page));
  };

  /**
   * Registrations are installed once per connection and before this connection creates any
   * document. Documents that were already running keep their recorded epoch, so the readiness
   * policy can tell them apart from documents that actually ran the bundle.
   */
  const install = async () => {
    const bootstrap = options.bootstrap;

    if (bootstrap === undefined && bindings === undefined) return;
    for (const entry of entries.values())
      for (const frame of entry.page.frames()) registeredEpochs.set(frame, epochOf(frame));
    // Host capabilities precede the bundle: a step may depend on a granted capability.
    for (const grant of bootstrap?.permissions ?? [])
      await context.grantPermissions([...grant.permissions], { origin: grant.origin });

    // One bundle guarantees callable wrappers exist before dependent init steps. Ordering
    // between two Playwright addInitScript registrations is intentionally not assumed.
    const content = [bindings?.bundle, bootstrap?.bundle]
      .filter((part) => part !== undefined)
      .join("\n");

    if (content.length > 0) {
      const registration = await context.addInitScript({ content });

      if (initializationClosed) await registration.dispose();
      else registrations.push(registration);
    }
  };

  const documentOrigin = (frame: Frame): string => {
    try {
      const url = new URL(frame.url());

      return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
    } catch {
      return "";
    }
  };

  /** A finite wait for a page promise. Native work continues; only this wait is bounded. */
  const evaluateWithin = async (
    frame: Frame,
    expression: string,
    milliseconds: number,
  ): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        frame.evaluate(expression),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(failure(Reasons.Timeout.make({}))), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const readiness = async (
    bootstrap: CompiledBootstrap,
    ticket: Ticket,
    target?: DriverTarget,
  ): Promise<ReadinessState> => {
    const { frame } = current(target);
    const epoch = epochOf(frame);

    if (readyDocuments.get(frame) === epoch) return { _tag: "Ready" };
    ticket.check();
    // A document that predates registration never ran the bundle; saying so is the contract.
    if (epoch <= (registeredEpochs.get(frame) ?? -1)) {
      if (bootstrap.existingDocuments === "RequireFreshNavigation")
        return { _tag: "RequiresNavigation" };
    }
    const origin = documentOrigin(frame);

    const applicable = bootstrap.readiness.filter(
      (requirement) => requirement.origins === undefined || requirement.origins.includes(origin),
    );

    if (applicable.length === 0) {
      readyDocuments.set(frame, epoch);

      return { _tag: "NotApplicable" };
    }

    for (const requirement of applicable) {
      const budget = Math.max(1, Math.min(requirement.timeoutMillis, ticket.remainingMillis()));
      let value: unknown;

      try {
        value = await evaluateWithin(frame, requirement.expression, budget);
      } catch (error) {
        if (epochOf(frame) !== epoch || frame.isDetached())
          return { _tag: "NotReady", step: requirement.step, reason: "stale" };

        return {
          _tag: "NotReady",
          step: requirement.step,
          reason:
            Schema.is(NativeFailure)(error) && error.reason._tag === "Timeout"
              ? "timeout"
              : "failed",
        };
      }
      ticket.check();
      // A completed wait cannot ready a document that replaced the one it observed.
      if (epochOf(frame) !== epoch)
        return { _tag: "NotReady", step: requirement.step, reason: "stale" };
      if (value !== true) return { _tag: "NotReady", step: requirement.step, reason: "failed" };
    }
    readyDocuments.set(frame, epoch);

    return { _tag: "Ready" };
  };

  const documentReadiness: Driver["documentReadiness"] = (ticket, target) =>
    sanitize(async () => {
      const bootstrap = options.bootstrap;

      return bootstrap === undefined || bootstrap.readiness.length === 0
        ? { _tag: "Ready" as const }
        : readiness(bootstrap, ticket, target);
    });

  return { attach, attachPage, attachFrame, fence, dispose, install, documentReadiness };
};
