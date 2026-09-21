import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { CallbackTasks } from "../src/internal/browser/CallbackTasks.ts";
import { gate } from "./fixtures/ScriptedProvider.ts";

it.effect("reject-call failures stay local and leave admission usable", () =>
  Effect.gen(function* () {
    let faults = 0,
      calls = 0;

    const tasks = new CallbackTasks(1, () => {
      faults++;
    });

    expect(
      tasks.submit(async () => {
        calls++;
        throw new Error("private callback detail");
      }, "reject-call"),
    ).toBe(true);
    yield* Effect.promise(() => tasks.settle());
    expect(faults).toBe(0);

    expect(
      tasks.submit(async () => {
        calls++;
      }, "reject-call"),
    ).toBe(true);
    yield* Effect.promise(() => tasks.settle());
    expect(calls).toBe(2);
    expect(faults).toBe(0);
  }),
);

it.effect("reject-call pressure refuses excess work without poisoning the connection", () =>
  Effect.gen(function* () {
    let faults = 0,
      calls = 0;

    const finish = gate<void>();

    const tasks = new CallbackTasks(1, () => {
      faults++;
    });

    expect(
      tasks.submit(async () => {
        calls++;
        await finish.promise;
      }, "reject-call"),
    ).toBe(true);
    expect(
      tasks.submit(async () => {
        calls++;
      }, "reject-call"),
    ).toBe(false);
    expect(calls).toBe(0);
    expect(faults).toBe(0);

    yield* Effect.promise(() => Promise.resolve());
    expect(calls).toBe(1);
    finish.resolve();
    yield* Effect.promise(() => tasks.settle());

    expect(
      tasks.submit(async () => {
        calls++;
      }, "reject-call"),
    ).toBe(true);
    yield* Effect.promise(() => tasks.settle());
    expect(calls).toBe(2);
    expect(faults).toBe(0);
  }),
);

it.effect("fail-session mode still faults once and permanently closes admission", () =>
  Effect.gen(function* () {
    let faults = 0;

    const tasks = new CallbackTasks(1, () => {
      faults++;
    });

    expect(
      tasks.submit(async () => {
        throw new Error("private callback detail");
      }, "fail-session"),
    ).toBe(true);
    yield* Effect.promise(() => tasks.settle());
    expect(faults).toBe(1);
    expect(tasks.submit(async () => {}, "reject-call")).toBe(false);
    expect(tasks.submit(async () => {}, "fail-session")).toBe(false);
  }),
);
