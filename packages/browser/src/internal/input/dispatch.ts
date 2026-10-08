/**
 * Sending input to the browser. Each mouse event, key and inserted text goes out on the page's
 * protocol session, stamped with the browser's clock when its run has a mapping, and is published
 * as it is submitted.
 */
import { Effect, MutableRef, Option } from "effect";

import { BrowserError } from "../../BrowserError.ts";
import {
  KeyChanged,
  PointerPressed,
  PointerReleased,
  TextInserted,
  WheelScrolled,
} from "../../BrowserEvent.ts";
import { type PageContext, reasonOf } from "../page/context.ts";
import * as BrowserClock from "../pictures/clock.ts";
import type * as Replies from "./replies.ts";

export type MouseEvent = {
  readonly type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
  readonly x: number;
  readonly y: number;
  readonly button?: "none" | "left" | "right" | "middle";
  readonly buttons?: number;
  readonly clickCount?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
};

export const make = (page: PageContext) => {
  const { id, pointer, publish, now, noteInput, closedBy } = page;
  const { send } = page.protocol;
  // Each run's clock mapping, recorded when it begins.
  const inputClocks = new WeakMap<Replies.Run, BrowserClock.Estimate>();

  // Every run records its mapping when it begins; a missing one leaves Chromium's own receipt time.
  const stamp = (estimate: BrowserClock.Estimate | undefined, at: number) =>
    estimate === undefined ? {} : { timestamp: BrowserClock.toBrowserSeconds(estimate, at) };

  const inputCall = <A>(operation: string, effect: Effect.Effect<A, Replies.InputFailure>) =>
    effect.pipe(
      Effect.mapError(
        (error) =>
          new BrowserError({
            operation,
            reason: reasonOf(error.cause, undefined, closedBy()),
            dispatched: false,
          }),
      ),
    );

  const dispatchMouse = (
    event: MouseEvent,
    estimate: BrowserClock.Estimate | undefined,
    submitted?: () => void,
  ): Promise<unknown> => {
    const at = now();
    const point = { x: event.x, y: event.y };
    const button = event.button ?? "left";

    // Construct boundary data before dispatch: validation must never abandon the native reply.
    const track =
      event.type === "mousePressed" && button !== "none"
        ? new PointerPressed({
            at,
            page: id,
            ...point,
            button,
            clickCount: event.clickCount ?? 1,
          })
        : event.type === "mouseReleased" && button !== "none"
          ? new PointerReleased({
              at,
              page: id,
              ...point,
              button,
              clickCount: event.clickCount ?? 1,
            })
          : event.type === "mouseWheel"
            ? new WheelScrolled({
                at,
                page: id,
                ...point,
                dx: event.deltaX ?? 0,
                dy: event.deltaY ?? 0,
              })
            : undefined;

    const response = send("Input.dispatchMouseEvent", { ...event, ...stamp(estimate, at) });

    noteInput();
    if (event.type === "mouseMoved") MutableRef.set(pointer, Option.some(point));
    if (track !== undefined) publish(track);
    submitted?.();

    return response;
  };

  const sendMouse = (
    operation: string,
    run: Replies.Run,
    event: MouseEvent,
    submitted?: () => void,
  ) =>
    inputCall(
      operation,
      Effect.gen(function* () {
        const held = `mouse:${event.button ?? "left"}`;
        const estimate = inputClocks.get(run);

        if (event.type === "mouseReleased") return yield* run.up(held);
        if (event.type === "mousePressed") {
          yield* run.reserve(2);
          yield* run.down(
            held,
            () => dispatchMouse(event, estimate, submitted),
            () =>
              dispatchMouse(
                {
                  type: "mouseReleased",
                  ...Option.getOrElse(MutableRef.get(pointer), () => ({ x: event.x, y: event.y })),
                  button: event.button ?? "left",
                  buttons: 0,
                  clickCount: event.clickCount ?? 1,
                },
                estimate,
              ),
          );
        } else {
          yield* run.reserve(1);
          yield* run.send(() => dispatchMouse(event, estimate, submitted));
        }
      }),
    );

  // Keys and text bound for a secret field are recorded without their content.
  const dispatchKey = (
    key: string,
    phase: "down" | "up",
    command: (at: number, estimate: BrowserClock.Estimate | undefined) => Promise<unknown>,
    run: Replies.Run,
    secret = false,
  ) => {
    const at = now();
    const event = new KeyChanged({ at, page: id, key: secret ? "Unidentified" : key, phase });
    const response = command(at, inputClocks.get(run));

    noteInput();
    publish(event);

    return response;
  };

  const dispatchText = (text: string, secret: boolean): Promise<unknown> => {
    const track = new TextInserted({ at: now(), page: id, text: secret ? "•" : text });
    const response = send("Input.insertText", { text });

    noteInput();
    publish(track);

    return response;
  };

  const flush = (operation: string, run: Replies.Run) => inputCall(operation, run.drain);

  return {
    inputClocks,
    stamp,
    inputCall,
    dispatchMouse,
    sendMouse,
    dispatchKey,
    dispatchText,
    flush,
  };
};

export type Dispatch = ReturnType<typeof make>;
