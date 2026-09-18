import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { CallbackTasks } from "../src/internal/CallbackTasks.ts";
import { gate } from "./fixtures/ScriptedProvider.ts";

it.effect("native callback pressure reserves capacity before dispatch and faults once", () =>
  Effect.gen(function* () {
    let calls = 0, faults = 0;
    const finish = gate<void>();
    const tasks = new CallbackTasks(4, () => { faults++; });
    for (let i = 0; i < 1000; i++) {
      tasks.submit(async () => { calls++; await finish.promise; });
    }
    yield* Effect.promise(() => Promise.resolve());
    expect(calls).toBe(4);
    expect(faults).toBe(1);
    finish.resolve();
    yield* Effect.promise(() => tasks.settle());
    expect(tasks.submit(async () => { calls++; })).toBe(false);
    expect(calls).toBe(4);
  }),
);

it.effect("native callback rejections stay observed after their connection retires", () =>
  Effect.gen(function* () {
    let faults = 0;
    const finish = gate<void>();
    const tasks = new CallbackTasks(1, () => { faults++; });
    tasks.submit(() => finish.promise);
    tasks.stop();
    finish.reject(new Error("private native detail"));
    yield* Effect.promise(() => tasks.settle());
    expect(faults).toBe(0);
    expect(tasks.submit(async () => {})).toBe(false);
  }),
);

it.effect("a synchronous callback failure is contained and permits no later work", () =>
  Effect.gen(function* () {
    let faults = 0;
    const tasks = new CallbackTasks(1, () => { faults++; });
    tasks.submit(() => { throw new Error("private callback detail"); });
    yield* Effect.promise(() => tasks.settle());
    expect(faults).toBe(1);
    expect(tasks.submit(async () => {})).toBe(false);
  }),
);
