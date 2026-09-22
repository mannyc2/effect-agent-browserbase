import { Schema } from "effect";
import type { BrowserContext, CDPSession, Frame, Page } from "playwright-core";

import { Identifier } from "../../BrowserData.ts";
import { InitializationError } from "../../Errors.ts";
import type { NativeBinding } from "./Bindings.ts";

const ContextCreated = Schema.Struct({
  context: Schema.Struct({
    id: Schema.Int.check(Schema.isGreaterThan(0)),
    uniqueId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
    origin: Schema.String.check(Schema.isMaxLength(2048)),
    auxData: Schema.optionalKey(Schema.Struct({ isDefault: Schema.Boolean, frameId: Identifier })),
  }),
});

const ContextDestroyed = Schema.Struct({ executionContextId: Schema.Int });
const TargetIdentity = Schema.Struct({ targetInfo: Schema.Struct({ targetId: Identifier }) });

const Call = Schema.Struct({
  name: Identifier,
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  input: Schema.String.check(Schema.isMaxLength(1024 * 1024)),
});

type DocumentIdentity = typeof ContextCreated.Type.context & {
  sequence: number;
  readonly targetId: string;
};

interface TargetRegistration {
  readonly cdp: CDPSession;
  readonly documents: Map<number, DocumentIdentity>;
  readonly page: Page;
  readonly off: () => void;
  closed: boolean;
}

const error = (step: string, reason: InitializationError["reason"]) =>
  InitializationError.make({ operation: "callback", step, reason });

/**
 * A small page-side transport, not a second host scheduler. Each document owns its finite
 * pending replies and one startup timer; host authority always comes from Chromium's native
 * execution-context event, never the fields in this message or a page-reported origin.
 */
const pageBundle = (
  nativeName: string,
  controllerName: string,
  bindings: ReadonlyArray<NativeBinding>,
): string => `(() => {
  const nativeName = ${JSON.stringify(nativeName)};
  const controllerName = ${JSON.stringify(controllerName)};
  if (Object.prototype.hasOwnProperty.call(globalThis, controllerName)) return;
  const definitions = ${JSON.stringify(
    bindings.map(({ name, maxConcurrent, maxInputBytes, timeoutMillis }) => ({
      name,
      maximum: maxConcurrent + 1,
      maxInputBytes,
      timeoutMillis,
    })),
  )};
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const encode = new TextEncoder();
  const descriptors = Object.getOwnPropertyDescriptors;
  const ownKeys = Reflect.ownKeys;
  const prototype = Object.getPrototypeOf;
  const plain = Object.prototype;
  const arrayPrototype = Array.prototype;
  const pending = new Map();
  const functions = new Map();
  const counts = new Map();
  let sequence = 0;
  let closed = false;
  let startup;
  const rejected = () => {
    const value = new Error('Browser binding call rejected');
    value.name = 'BrowserBindingError';
    value.stack = '';
    return value;
  };
  const jsonInput = (value, maximum) => {
    let nodes = 0;
    const ancestors = new Set();
    const visit = (item, depth) => {
      if (++nodes > Math.min(maximum, 65536) || depth > 64) throw rejected();
      if (item === null || typeof item === 'boolean') return;
      if (typeof item === 'string') { if (item.length > maximum) throw rejected(); return; }
      if (typeof item === 'number') { if (!Number.isFinite(item)) throw rejected(); return; }
      if (typeof item !== 'object' || ancestors.has(item)) throw rejected();
      const array = Array.isArray(item);
      const parent = prototype(item);
      if (array ? parent !== arrayPrototype : parent !== plain && parent !== null) throw rejected();
      ancestors.add(item);
      const fields = descriptors(item);
      const keys = ownKeys(fields);
      if (keys.length > Math.min(maximum, 65536)) throw rejected();
      if (array && keys.length !== item.length + 1) throw rejected();
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || key.length > maximum || key === 'toJSON') throw rejected();
        const field = fields[key];
        if (!field.enumerable || !Object.prototype.hasOwnProperty.call(field, 'value')) throw rejected();
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) throw rejected();
        visit(field.value, depth + 1);
      }
      ancestors.delete(item);
    };
    visit(value, 0);
    return stringify(value);
  };
  const settle = (id, packet) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    clearTimeout(call.timer);
    counts.set(call.name, (counts.get(call.name) || 1) - 1);
    if (packet && packet.ok === true) {
      try { call.resolve(parse(packet.text)); } catch { call.reject(rejected()); }
    } else call.reject(rejected());
  };
  const dispatch = () => {
    clearTimeout(startup);
    startup = undefined;
    if (closed) return;
    const native = globalThis[nativeName];
    if (typeof native !== 'function') {
      if (pending.size > 0) startup = setTimeout(dispatch, 10);
      return;
    }
    for (const [id, call] of pending) {
      if (call.sent) continue;
      call.sent = true;
      try { native(call.message); } catch { settle(id); }
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(startup);
    for (const id of [...pending.keys()]) settle(id);
    for (const [name, fn] of functions) {
      if (globalThis[name] === fn) delete globalThis[name];
    }
  };
  const controller = Object.freeze({ deliver: settle, close,
    get status() { return closed ? 'closed' : functions.size === definitions.length ? 'ready' : 'installing'; }
  });
  Object.defineProperty(globalThis, controllerName, { value: controller, configurable: true });
  for (const definition of definitions) {
    if (Object.prototype.hasOwnProperty.call(globalThis, definition.name)) { close(); return; }
    const fn = (...args) => new Promise((resolve, reject) => {
      if (closed || args.length !== 1 || sequence >= Number.MAX_SAFE_INTEGER ||
          (counts.get(definition.name) || 0) >= definition.maximum) {
        reject(rejected()); return;
      }
      let input;
      try {
        input = jsonInput(args[0], definition.maxInputBytes);
        if (typeof input !== 'string' || input.length > definition.maxInputBytes ||
            encode.encode(input).byteLength > definition.maxInputBytes) throw rejected();
      } catch { reject(rejected()); return; }
      const id = ++sequence;
      const timer = setTimeout(() => settle(id), definition.timeoutMillis);
      counts.set(definition.name, (counts.get(definition.name) || 0) + 1);
      pending.set(id, { name: definition.name, resolve, reject, timer, sent: false,
        message: stringify({ name: definition.name, sequence: id, input }) });
      dispatch();
    });
    functions.set(definition.name, fn);
    Object.defineProperty(globalThis, definition.name, { value: fn, configurable: true });
  }
})();`;

/**
 * The pinned Playwright binding callback reports a Frame but no calling document identity.
 * That Frame survives navigation, so checking frame.url() would authorize an old document
 * using its replacement's origin. Chromium's maintained Runtime binding protocol supplies
 * the original executionContextId; uniqueId prevents context-id reuse when publishing replies.
 * These are child CDP sessions on the existing owned Playwright connection, not another owner,
 * websocket, browser resource or publicly exposed raw-protocol capability.
 */
export const makeNativeBindings = (
  context: BrowserContext,
  bindings: ReadonlyArray<NativeBinding>,
  fault: () => void,
) => {
  const identity = globalThis.crypto.randomUUID().replaceAll("-", "");
  const nativeName = `__effect_agent_binding_${identity}`;
  const controllerName = `__effect_agent_bindings_${identity}`;
  const bundle = pageBundle(nativeName, controllerName, bindings);
  const byName = new Map(bindings.map((binding) => [binding.name, binding]));
  const targets = new Map<string, TargetRegistration>();
  const currentDocuments = new Map<string, DocumentIdentity>();
  const attaching = new WeakSet<Page | Frame>();
  // Native replies are bounded too, including rejected calls and late native completions.
  const maximumReplies = 16 + bindings.reduce((sum, binding) => sum + binding.maxConcurrent, 0);
  let replies = 0;
  let closing = false;
  let disposed: Promise<void> | undefined;

  const close = () => {
    closing = true;
  };

  const attach = async (subject: Page | Frame, page: Page): Promise<void> => {
    if (closing || page.isClosed() || attaching.has(subject)) return;
    attaching.add(subject);
    let cdp: CDPSession | undefined;
    let retained = false;

    try {
      try {
        cdp = await context.newCDPSession(subject);
      } catch (cause) {
        // Chromium routes same-process child frames through their parent's target. Only this
        // exact pinned Playwright refusal selects that already-owned session; other failures
        // remain faults rather than silently omitting an out-of-process frame.
        if (
          subject !== page &&
          cause instanceof Error &&
          cause.message.includes("This frame does not have a separate CDP session")
        )
          return;
        if (
          page.isClosed() ||
          (subject !== page && "isDetached" in subject && subject.isDetached())
        )
          return;
        throw cause;
      }
      const native = cdp;

      const targetId = Schema.decodeSync(TargetIdentity)(await native.send("Target.getTargetInfo"))
        .targetInfo.targetId;

      if (closing || page.isClosed() || targets.has(targetId)) return;
      if (targets.size >= 128) throw error("bindings", "busy");
      const documents = new Map<number, DocumentIdentity>();

      const created = (raw: unknown) => {
        const parsed = Schema.decodeUnknownOption(ContextCreated)(raw);

        if (parsed._tag === "None") return;
        const value = parsed.value.context;

        if (closing || value.auxData?.isDefault !== true) return;
        const prior = documents.get(value.id);

        if (prior?.uniqueId === value.uniqueId) return;
        const previous = currentDocuments.get(value.auxData.frameId);

        if (previous !== undefined) {
          const previousDocuments = targets.get(previous.targetId)?.documents;

          if (previousDocuments?.get(previous.id) === previous)
            previousDocuments.delete(previous.id);
          currentDocuments.delete(value.auxData.frameId);
        }
        if (documents.size >= 128 && !documents.has(value.id)) {
          fault();

          return;
        }
        const document = { ...value, sequence: 0, targetId };

        // A new default context for the native frame retires the old document even when its
        // destruction event lags a process swap or a back/forward-cache transition.
        currentDocuments.set(value.auxData.frameId, document);
        documents.set(value.id, document);
      };

      const destroyed = (raw: unknown) => {
        const parsed = Schema.decodeUnknownOption(ContextDestroyed)(raw);

        if (parsed._tag === "Some") {
          const document = documents.get(parsed.value.executionContextId);
          const frameId = document?.auxData?.frameId;

          if (frameId !== undefined && currentDocuments.get(frameId) === document)
            currentDocuments.delete(frameId);
          documents.delete(parsed.value.executionContextId);
        }
      };

      const cleared = () => {
        for (const document of documents.values()) {
          const frameId = document.auxData?.frameId;

          if (frameId !== undefined && currentDocuments.get(frameId) === document)
            currentDocuments.delete(frameId);
        }
        documents.clear();
      };

      const called = (event: {
        readonly name: string;
        readonly payload: string;
        readonly executionContextId: number;
      }) => {
        if (closing || event.name !== nativeName || replies >= maximumReplies) return;
        const document = documents.get(event.executionContextId);

        if (document === undefined || event.payload.length > 2 * 1024 * 1024 + 512) return;
        const parsed = Schema.decodeOption(Schema.fromJsonString(Call))(event.payload);

        if (parsed._tag === "None") return;
        const call = parsed.value;
        const binding = byName.get(call.name);

        if (binding === undefined || call.sequence <= document.sequence) return;
        document.sequence = call.sequence;
        replies++;
        let retired = false;

        const check = async (signal: AbortSignal) => {
          const current = () => {
            if (closing || retired || signal.aborted || page.isClosed())
              throw error(binding.name, "closed");
            if (
              documents.get(document.id) !== document ||
              currentDocuments.get(document.auxData?.frameId ?? "") !== document
            )
              throw error(binding.name, "stale");
            if (!binding.origins.includes(document.origin)) throw error(binding.name, "origin");
          };

          current();

          const result = await native.send("Runtime.evaluate", {
            expression: "true",
            uniqueContextId: document.uniqueId,
            returnByValue: true,
            silent: true,
            timeout: binding.timeoutMillis,
          });

          current();
          if (result.exceptionDetails !== undefined || result.result.value !== true)
            throw error(binding.name, "stale");
        };

        const reply = async (
          packet: { readonly ok: false } | { readonly ok: true; readonly text: string },
        ) => {
          if (
            closing ||
            page.isClosed() ||
            documents.get(document.id) !== document ||
            currentDocuments.get(document.auxData?.frameId ?? "") !== document
          )
            return;
          await native.send("Runtime.evaluate", {
            expression: `globalThis[${JSON.stringify(controllerName)}]?.deliver(${call.sequence},${JSON.stringify(packet)})`,
            uniqueContextId: document.uniqueId,
            returnByValue: true,
            silent: true,
            timeout: binding.timeoutMillis,
          });
        };

        // Runtime admission is synchronous before a consumer fiber or native validation starts.
        // Both branches stay observed even when the source document disappears while settling.
        void binding
          .invoke({
            read: async (signal) => {
              // An environment-free codec can still suspend or invoke host code. Authorize
              // before even decoding, then recheck after decode and before publishing a reply.
              await check(signal);

              return call.input;
            },
            check,
            dispose: async () => {
              retired = true;
            },
          })
          .then(
            (text) => reply({ ok: true, text }),
            () => reply({ ok: false }),
          )
          .catch(() => {})
          .finally(() => {
            replies--;
          });
      };

      const off = () => {
        native.off("Runtime.executionContextCreated", created);
        native.off("Runtime.executionContextDestroyed", destroyed);
        native.off("Runtime.executionContextsCleared", cleared);
        native.off("Runtime.bindingCalled", called);
        cleared();
      };

      const target: TargetRegistration = { cdp: native, documents, page, off, closed: false };

      const onClosed = () => {
        target.closed = true;
        off();
        if (targets.get(targetId) === target) targets.delete(targetId);
        native.off("close", onClosed);
      };

      native.on("close", onClosed);
      targets.set(targetId, target);
      retained = true;
      native.on("Runtime.executionContextCreated", created);
      native.on("Runtime.executionContextDestroyed", destroyed);
      native.on("Runtime.executionContextsCleared", cleared);
      native.on("Runtime.bindingCalled", called);
      await native.send("Runtime.enable");
      if (closing) return;
      await native.send("Runtime.addBinding", { name: nativeName });
      if (closing) {
        await native.send("Runtime.removeBinding", { name: nativeName }).catch(() => {});

        return;
      }
      // Existing documents receive only the callable bridge, never replayed consumer init scripts.
      for (const document of documents.values()) {
        if (closing) return;

        const installed = await native.send("Runtime.evaluate", {
          expression: `${bundle}\nglobalThis[${JSON.stringify(controllerName)}]?.status`,
          uniqueContextId: document.uniqueId,
          returnByValue: true,
          silent: true,
          timeout: 2000,
        });

        if (
          documents.get(document.id) !== document ||
          currentDocuments.get(document.auxData?.frameId ?? "") !== document
        )
          continue;
        if (installed.exceptionDetails !== undefined || installed.result.value !== "ready")
          throw InitializationError.make({
            operation: "register",
            step: "bindings",
            reason: "configuration",
          });
      }
    } finally {
      attaching.delete(subject);
      if (cdp !== undefined && (!retained || closing)) await cdp.detach().catch(() => {});
    }
  };

  const dispose = (): Promise<void> => {
    close();
    disposed ??= (async () => {
      const settled = await Promise.allSettled(
        [...targets.values()].map(async (target) => {
          const documents = [...target.documents.values()];

          target.off();

          const removal = await Promise.allSettled([
            (async () => {
              if (!target.closed && !target.page.isClosed()) {
                for (const document of documents) {
                  await target.cdp
                    .send("Runtime.evaluate", {
                      expression: `globalThis[${JSON.stringify(controllerName)}]?.close()`,
                      uniqueContextId: document.uniqueId,
                      returnByValue: true,
                      silent: true,
                      timeout: 1000,
                    })
                    .catch(() => {});
                }
                if (!target.closed)
                  await target.cdp.send("Runtime.removeBinding", { name: nativeName });
              }
            })(),
          ]);

          // Always attempt detach without overwriting an earlier removal failure. A native
          // target close is terminal evidence; an arbitrary transport error is not.
          const wasClosed = target.closed || target.page.isClosed();

          const detachment = await Promise.allSettled([
            target.closed ? Promise.resolve() : target.cdp.detach(),
          ]);

          if (!wasClosed && removal.some((result) => result.status === "rejected"))
            throw InitializationError.make({
              operation: "dispose",
              step: "bindings",
              reason: "native",
            });
          if (
            !target.closed &&
            !target.page.isClosed() &&
            detachment.some((result) => result.status === "rejected")
          )
            throw InitializationError.make({
              operation: "dispose",
              step: "bindings",
              reason: "native",
            });
        }),
      );

      targets.clear();
      currentDocuments.clear();
      if (settled.some((result) => result.status === "rejected"))
        throw InitializationError.make({
          operation: "dispose",
          step: "bindings",
          reason: "native",
        });
    })();

    return disposed;
  };

  return { bundle, attach, close, dispose };
};
