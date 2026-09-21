import { Schema } from "effect";
import type { ElementHandle, JSHandle } from "playwright-core";

import { ObservedControl, type ObservedElement } from "../../BrowserData.ts";
import { pngGeometry } from "../capture/Images.ts";
import type { DriverEvents, NativeObservation } from "./Driver.ts";
import { closeWithin, failure, safeDecode, sanitize, timeout } from "./NativeCalls.ts";
import type { Ticket } from "./Owner.ts";
import type { Targets } from "./Targets.ts";

const TextResult = Schema.Struct({
  text: Schema.String,
  missing: Schema.Boolean,
  overLimit: Schema.Boolean,
});

const ObservationData = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(131072)),
  textTruncated: Schema.Boolean,
  controlsTruncated: Schema.Boolean,
  controls: Schema.Array(
    Schema.Struct({
      kind: ObservedControl.fields.kind,
      label: ObservedControl.fields.label,
      disabled: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(64)),
});

const Geometry = Schema.Struct({ width: Schema.Natural, height: Schema.Natural });

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(1000000));

interface Snapshot {
  readonly id: string;
  valid: boolean;
  readonly nodes: Map<string, ElementHandle<Element>>;
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
    if (observation !== undefined) observation.valid = false;
  };

  const changed = (reason: Parameters<DriverEvents["invalidate"]>[0]) => {
    invalidate();
    events.invalidate(reason);
  };

  const dispose = async () => {
    const old = observation;

    observation = undefined;
    if (old !== undefined) {
      old.valid = false;
      await closeWithin(() =>
        Promise.allSettled([...old.nodes.values()].map((node) => node.dispose())),
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
        count = safeDecode(Count, await countHandle.jsonValue(), "target-count");
      } finally {
        await countHandle.dispose();
      }
      ticket.check();
      if (count !== 1)
        throw failure("target", count === 0 ? "not-found" : "ambiguous", "undispatched");
      node = await holder.getProperty("node");
      const element = node.asElement();

      if (element === null) throw failure("target", "not-found", "undispatched");
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
  const retained = (target: ObservedElement): ElementHandle<Element> => {
    if (observation === undefined || !observation.valid || observation.id !== target.observationId)
      throw failure("target", "stale", "undispatched");
    const node = observation.nodes.get(target.elementId);

    if (node === undefined) throw failure("target", "stale", "undispatched");

    return node;
  };

  const readText = (selector: string | undefined, maximumBytes: number, ticket: Ticket) =>
    sanitize("read-text", async () => {
      ticket.check();

      const raw: unknown = await current().frame.evaluate(
        ({ selector, maximumBytes }) => {
          const element = selector === undefined ? document.body : document.querySelector(selector);

          if (element === null) return { text: "", missing: true, overLimit: false };

          const text =
            element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");

          if (new TextEncoder().encode(text).length > maximumBytes)
            return { text: "", missing: false, overLimit: true };

          return { text, missing: false, overLimit: false };
        },
        { selector, maximumBytes },
      );

      ticket.check();
      const value = safeDecode(TextResult, raw, "read-text");

      if (value.missing) throw failure("read-text", "not-found");
      if (value.overLimit || new TextEncoder().encode(value.text).length > maximumBytes)
        throw failure("read-text", "limit");

      return value.text;
    });

  const observe = (maximumBytes: number, controlLimit: number, ticket: Ticket) =>
    sanitize("observe", async () => {
      await dispose();
      ticket.check();

      const holder = await current().frame.evaluateHandle(
        ({ maximumBytes, controlLimit }) => {
          const all = document.querySelectorAll(
            "a[href],button,input,select,textarea,[role=button]",
          );

          const nodes: Element[] = [];

          for (let i = 0; i < Math.min(all.length, controlLimit); i++) nodes.push(all[i]);
          const source = document.body?.innerText ?? "";
          const encoded = new TextEncoder().encode(source);
          let end = Math.min(encoded.length, maximumBytes);

          // Do not manufacture a replacement character by cutting a UTF-8 sequence.
          while (end > 0 && end < encoded.length && (encoded[end] & 192) === 128) end--;
          const text = new TextDecoder().decode(encoded.subarray(0, end));

          return {
            nodes,
            data: {
              text,
              textTruncated: end < encoded.length,
              controlsTruncated: all.length > nodes.length,
              controls: nodes.map((node) => {
                const tag = node.tagName.toLowerCase();

                const kind =
                  tag === "a"
                    ? "link"
                    : ["button", "input", "select", "textarea"].includes(tag)
                      ? tag
                      : "other";

                const label = (
                  node.getAttribute("aria-label") ??
                  node.getAttribute("placeholder") ??
                  (node instanceof HTMLInputElement
                    ? node.labels?.[0]?.textContent
                    : node.textContent) ??
                  ""
                ).slice(0, 256);

                return {
                  kind,
                  label,
                  disabled:
                    node.matches(":disabled") || node.getAttribute("aria-disabled") === "true",
                };
              }),
            },
          };
        },
        { maximumBytes, controlLimit },
      );

      const nodes = new Map<string, ElementHandle<Element>>();
      let nodesHandle: JSHandle | undefined;

      try {
        const dataHandle = await holder.getProperty("data");
        let data: typeof ObservationData.Type;

        try {
          data = safeDecode(ObservationData, await dataHandle.jsonValue(), "observe");
        } finally {
          await dataHandle.dispose();
        }
        if (
          new TextEncoder().encode(data.text).length > maximumBytes ||
          data.controls.length > controlLimit
        )
          throw failure("observe", "limit");
        nodesHandle = await holder.getProperty("nodes");
        for (let i = 0; i < data.controls.length; i++) {
          const node = await nodesHandle.getProperty(String(i));
          const element = node.asElement();

          if (element === null) {
            await node.dispose();
            throw failure("observe", "malformed");
          }
          nodes.set(`element-${i}`, element);
        }
        ticket.check();
        const id = `observation-${++observationSerial}`;

        observation = { id, valid: true, nodes };

        const result: NativeObservation = {
          ...data,
          observationId: id,
          url: targets.selectedUrl(),
          controls: data.controls.map((control, i) =>
            ObservedControl.make({ ...control, elementId: `element-${i}` }),
          ),
        };

        return result;
      } catch (error) {
        await Promise.allSettled([...nodes.values()].map((node) => node.dispose()));
        throw error;
      } finally {
        await nodesHandle?.dispose().catch(() => {});
        await holder.dispose();
      }
    });

  const screenshot = (fullPage: boolean, maximumBytes: number, ticket: Ticket) =>
    sanitize("screenshot", async () => {
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

      const geometry = safeDecode(Geometry, raw, "screenshot");

      if (
        geometry.width < 1 ||
        geometry.height < 1 ||
        geometry.width > 16384 ||
        geometry.height > 16384 ||
        geometry.width * geometry.height > 33_554_432
      )
        throw failure("screenshot", "limit");
      ticket.check();

      const bytes: unknown = await page.screenshot({
        type: "png",
        fullPage,
        scale: "css",
        timeout: timeout(ticket),
      });

      if (!(bytes instanceof Uint8Array)) throw failure("screenshot", "malformed");
      if (bytes.length > maximumBytes) throw failure("screenshot", "limit");
      const actual = pngGeometry(bytes);

      if (
        actual.width > 16384 ||
        actual.height > 16384 ||
        actual.width * actual.height > 33_554_432
      )
        throw failure("screenshot", "limit");
      ticket.check();

      return new Uint8Array(bytes);
    });

  return { invalidate, changed, dispose, exactElement, retained, readText, observe, screenshot };
};

export type Observation = ReturnType<typeof makeObservation>;
