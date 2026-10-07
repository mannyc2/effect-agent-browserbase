// A run's results: one versioned record per trial, appended as a JSON line, and the ledger beside
// them, both through `FileSystem`, so `report` reads back exactly what `run` wrote.
import { Effect, FileSystem, type PlatformError, Schema } from "effect";

import { arms } from "./Arms.ts";
import { Accounting, BenchError, Timing } from "./Budget.ts";
import * as Diagnostics from "./Diagnostics.ts";
import { Phases, Protocol } from "./Trace.ts";
import { Reason, RunInfo, Status } from "./Trial.ts";

export class TrialRecord extends Schema.Class<TrialRecord>("bench/TrialRecord")({
  version: Schema.Literal(2),
  task: Schema.String,
  kind: Schema.Literals(["operate", "understand"]),
  /** Null for a scripted solution. */
  arm: Schema.NullOr(Schema.Literals(arms)),
  trial: Schema.Int,
  baseSeed: Schema.Int,
  seed: Schema.Int,
  /** A calendar date, in ISO form; elapsed time is `seconds`, on a monotonic clock. */
  startedAt: Schema.String,
  run: RunInfo,
  reasoning: Schema.NullOr(Schema.String),
  status: Status,
  reason: Reason,
  /** Null unless the trial was graded. */
  pass: Schema.NullOr(Schema.Boolean),
  /**
   * Whether a graded operate trial's page holds the work the task asked for, whatever the answer
   * said; null for understand tasks and ungraded trials.
   */
  onPage: Schema.NullOr(Schema.Boolean),
  detail: Schema.String,
  error: Schema.NullOr(Schema.String),
  diagnostic: Schema.NullOr(Diagnostics.Failure),
  lastResponse: Schema.NullOr(Diagnostics.LastResponse),
  answer: Schema.Unknown,
  /** Model turns and tool calls of a trial that reached an outcome; null otherwise. */
  steps: Schema.NullOr(Schema.Int),
  actions: Schema.NullOr(Schema.Int),
  accounting: Accounting,
  /** Admission queueing and provider request time within `seconds`. */
  timing: Timing,
  /** Opening the browser, the model's tool calls and looks at the page, within `seconds`. */
  phases: Phases,
  /** A latency or hosted run's DevTools commands and round trips, by span; null otherwise. */
  protocol: Schema.NullOr(Protocol),
  /** The fastest round trip to the browser that its clock calibrations measured; null if none ran. */
  roundTripMillis: Schema.NullOr(Schema.Finite),
  /** A hosted trial's Browserbase region; null otherwise. */
  region: Schema.NullOr(Schema.String),
  /** The trial's trace, to find it where spans are exported; null for a trial that never ran. */
  traceId: Schema.NullOr(Schema.String),
  seconds: Schema.Finite,
}) {}

/** The admission ledger as it stood when the run ended or was interrupted. */
export const Ledger = Schema.Struct({
  knownUsd: Schema.Finite,
  reservedUsd: Schema.Finite,
  maxUsd: Schema.Finite,
  interrupted: Schema.Boolean,
});

const RecordLine = Schema.fromJsonString(TrialRecord);

const LedgerJson = Schema.fromJsonString(Ledger);

const unwritten = (error: PlatformError.PlatformError | Schema.SchemaError) =>
  new BenchError({ message: `could not write bench results: ${error.message}` });

/** Add one trial's record to the end of `file`, as one line. */
export const append = Effect.fnUntraced(function* (file: string, record: TrialRecord) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.writeFileString(file, `${yield* Schema.encodeEffect(RecordLine)(record)}\n`, {
    flag: "a",
  });
}, Effect.mapError(unwritten));

export const writeLedger = Effect.fnUntraced(function* (file: string, ledger: typeof Ledger.Type) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.writeFileString(file, `${yield* Schema.encodeEffect(LedgerJson)(ledger)}\n`);
}, Effect.mapError(unwritten));

/** Every record in `file`, in the order written. A line that is not a record fails the read. */
export const read = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;

  const text = yield* fs
    .readFileString(file)
    .pipe(
      Effect.mapError(
        (error) => new BenchError({ message: `could not read ${file}: ${error.message}` }),
      ),
    );

  const lines = text.split("\n").flatMap((line, index) => (line === "" ? [] : [{ line, index }]));

  return yield* Effect.forEach(lines, ({ line, index }) =>
    Schema.decodeEffect(RecordLine)(line).pipe(
      Effect.mapError(
        (error) =>
          new BenchError({
            message: `${file}, line ${index + 1}, is not a trial record: ${error.message}`,
          }),
      ),
    ),
  );
});
