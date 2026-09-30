import { isDeepStrictEqual } from "node:util";

import { Console, Effect, Option, Schema } from "effect";
import {
  type InspectionRequest,
  observedToolkit,
  toolkit as browserToolkit,
} from "effect-agent-browser/tools";
import type { BrowserSession } from "effect-browser/browser";
import { Observation } from "effect-browser/browser-data";
import { Tool, Toolkit } from "effect/unstable/ai";

import { chartExpected, chartFacts, feedPosts } from "../fixtures/UnderstandingSite.ts";
import { ChartAnalysis } from "./Cases.ts";
import type { Evidence, Event, Journal } from "./Evidence.ts";

export const chartAnalysisSchema = ChartAnalysis;

const bounded = (maximum: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximum),
    Schema.makeFilter((value) => value.trim().length > 0, { title: "not only whitespace" }),
  );

const identifier = bounded(128);
const nonnegative = Schema.Natural;

const claim = Schema.Struct({
  topic: bounded(128),
  value: bounded(128),
  corrects: Schema.NullOr(identifier),
});

const commentaryParameters = Schema.Struct({
  observationId: identifier,
  postId: identifier,
  quote: bounded(512),
  claim,
  caption: bounded(1024),
});

/** A local evidence sink. Receipt acknowledges delivery, never the truth of a claim. */
export const commentaryTool = Tool.make("browser_commentary", {
  description:
    "Deliver live commentary for a post in the latest viewport observation. Give its observationId and postId, a verbatim quote, a structured claim and a short caption. Set claim.corrects to the earlier post ID explicitly corrected, otherwise null. The receipt only acknowledges delivery; it does not verify your claim. This does not write to the website.",
  parameters: commentaryParameters,
  success: Schema.Struct({ entryId: identifier }),
  failureMode: "return",
}).annotate(Tool.Readonly, true);

export const commentaryToolkit = Toolkit.make(commentaryTool);

const visiblePrompt = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
    }),
  ),
});

const visibleRequest = Schema.Struct({ prompt: visiblePrompt });

const toolResult = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  isFailure: Schema.Boolean,
  result: Schema.Unknown,
});

const observedResult = Schema.Struct({
  observation: Schema.TaggedStruct("Available", { observation: Observation }),
});

const observedNames = new Set([
  "browser_navigate_and_inspect",
  "browser_click_and_inspect",
  "browser_fill_and_inspect",
  "browser_scroll_and_inspect",
  "browser_fill_form_and_inspect",
]);

const visibleResults = (value: unknown): ReadonlyArray<typeof toolResult.Type> => {
  const wrapped = Schema.decodeUnknownOption(visibleRequest)(value);

  const prompt = Option.isSome(wrapped)
    ? wrapped.value.prompt
    : Option.getOrUndefined(Schema.decodeUnknownOption(visiblePrompt)(value));

  if (prompt === undefined) return [];

  return prompt.content.flatMap((message) =>
    message.role === "tool" && Array.isArray(message.content)
      ? message.content.flatMap((part) => {
          const decoded = Schema.decodeUnknownOption(toolResult)(part);

          return Option.isSome(decoded) ? [decoded.value] : [];
        })
      : [],
  );
};

/** Only maintained Browser results are source evidence; commentary acknowledgements never are. */
export const visibleObservations = (value: unknown): ReadonlyArray<Observation> =>
  visibleResults(value).flatMap((result) => {
    if (result.isFailure) return [];
    if (result.name === "browser_inspect")
      return Option.match(Schema.decodeUnknownOption(Observation)(result.result), {
        onNone: () => [],
        onSome: (view) => [view],
      });
    if (!observedNames.has(result.name)) return [];

    return Option.match(Schema.decodeUnknownOption(observedResult)(result.result), {
      onNone: () => [],
      onSome: (view) => [view.observation.observation],
    });
  });

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

const postText = (view: Observation | undefined, postId: string) => {
  if (view === undefined || view.scope !== "viewport") return undefined;
  const text = normalize(view.text);
  const start = text.indexOf(`Post ${postId} ·`);

  if (start < 0) return undefined;
  const rest = text.slice(start);
  const next = rest.slice(1).search(/\bPost [\w-]{1,128} ·/);

  return next < 0 ? rest : rest.slice(0, next + 1);
};

const quoted = (view: Observation | undefined, params: typeof commentaryParameters.Type) =>
  postText(view, params.postId)?.includes(normalize(params.quote)) === true;

const commentaryEvent = Schema.Struct({
  type: Schema.Literal("commentary"),
  toolCallId: Schema.String,
  entryId: identifier,
  params: commentaryParameters,
  fresh: Schema.Boolean,
  sourceObserved: Schema.Boolean,
  actionsUsed: nonnegative,
  observationActionsUsed: Schema.NullOr(nonnegative),
  latestObservationId: Schema.NullOr(identifier),
});

/** The original owner's viewport reading and action counter fence the commentary's source. */
export const feedRecorder = <OwnerError>(journal: Journal, browser: BrowserSession<OwnerError>) => {
  let latest: { readonly id: string; readonly actionsUsed: number } | undefined;
  let entries = 0;
  const consumedAliases = new Set<string>();

  const observe = Effect.fn("Understanding.observe")(function* (request: InspectionRequest) {
    const view = yield* browser.observe({ ...request, scope: "viewport" });
    const status = yield* browser.status;

    latest = { id: view.observationId, actionsUsed: status.actions.used };

    return view;
  });

  const layer = commentaryToolkit.toLayer({
    browser_commentary: (params) =>
      Effect.gen(function* () {
        const status = yield* browser.status;
        const events = journal.snapshot().events;
        const request = events.findLast((event) => event.kind === "request");
        const view = visibleObservations(request?.value).at(-1);
        const entryId = `commentary-${entries++}`;

        const retainedCall = events
          .flatMap((event) =>
            request !== undefined &&
            event.kind === "response" &&
            event.turn === request.turn &&
            event.seq > request.seq
              ? Option.match(Schema.decodeUnknownOption(call)(event.value), {
                  onNone: () => [],
                  onSome: (sent) => [sent],
                })
              : [],
          )
          .find(
            (sent) =>
              sent.name === commentaryTool.name &&
              !consumedAliases.has(sent.id) &&
              isDeepStrictEqual(sent.params, params),
          );

        if (retainedCall !== undefined) consumedAliases.add(retainedCall.id);

        const fresh =
          latest !== undefined &&
          latest.id === params.observationId &&
          view?.observationId === params.observationId &&
          latest.actionsUsed === status.actions.used &&
          status.phase === "open" &&
          !status.unresolvedDispatch;

        journal.append({
          kind: "host",
          turn: request?.turn ?? null,
          value: {
            type: "commentary",
            toolCallId: retainedCall?.id ?? `unpaired-${entryId}`,
            entryId,
            params,
            fresh,
            sourceObserved: quoted(view, params),
            actionsUsed: status.actions.used,
            observationActionsUsed: latest?.actionsUsed ?? null,
            latestObservationId: latest?.id ?? null,
          },
        });
        if (journal.manifest.provider !== "scripted")
          yield* Console.log(`[commentary ${params.postId}] ${params.caption}`);

        return { entryId };
      }),
  });

  return { observe, layer };
};

const chartReport = Schema.Struct({
  kind: Schema.Literal("chart-data"),
  passed: Schema.Boolean,
  factsCorrect: Schema.Boolean,
  reported: Schema.NullOr(ChartAnalysis),
  valuesObserved: nonnegative,
  expectedValues: Schema.Literal(6),
  axisObserved: Schema.Boolean,
  unitObserved: Schema.Boolean,
  sourceObserved: Schema.Boolean,
  prose: Schema.Literal("ungraded"),
});

const commentaryDetail = Schema.Struct({
  at: Schema.Finite,
  entryId: identifier,
  postId: identifier,
  quote: bounded(512),
  claim,
  caption: bounded(1024),
  fresh: Schema.Boolean,
  sourceObserved: Schema.Boolean,
  claimCorrect: Schema.Boolean,
  paired: Schema.Boolean,
});

const feedReport = Schema.Struct({
  kind: Schema.Literal("feed-commentary"),
  passed: Schema.Boolean,
  expectedPosts: Schema.Literal(6),
  observedPosts: Schema.Array(identifier),
  groundedCoverage: Schema.Array(identifier),
  commentary: Schema.Array(commentaryDetail),
  wrong: nonnegative,
  unread: nonnegative,
  stale: nonnegative,
  duplicates: nonnegative,
  unrecorded: nonnegative,
  ordered: Schema.Boolean,
  successfulScrollTransitions: nonnegative,
  missingScrollTransitions: nonnegative,
  scrollTransitions: Schema.Array(
    Schema.Struct({
      entryId: identifier,
      postId: identifier,
      turn: Schema.NullOr(nonnegative),
      scrollToolCallId: Schema.NullOr(Schema.String),
      successful: Schema.Boolean,
    }),
  ),
  corrections: Schema.Array(
    Schema.Struct({ postId: identifier, corrects: identifier, supported: Schema.Boolean }),
  ),
  correctionObserved: Schema.Boolean,
  prose: Schema.Literal("ungraded"),
});

export const UnderstandingReport = Schema.Union([chartReport, feedReport]);
export type UnderstandingReport = typeof UnderstandingReport.Type;

const call = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Unknown,
});

const answeredObservations = (evidence: Evidence) => {
  const answered = new Set(
    evidence.events.filter((event) => event.kind === "response").map((event) => event.turn),
  );

  return evidence.events.flatMap((event) =>
    event.kind === "request" && answered.has(event.turn) ? visibleObservations(event.value) : [],
  );
};

const chartGrade = (evidence: Evidence) => {
  const output = Schema.decodeUnknownOption(Schema.Struct({ chart: ChartAnalysis }))(
    evidence.facts.output,
  );

  const reported = Option.isSome(output) ? output.value.chart : null;
  const factsCorrect = reported !== null && isDeepStrictEqual(reported, chartExpected);
  const texts = answeredObservations(evidence).map((view) => normalize(view.text));

  const valuesObserved = chartFacts.rows.reduce(
    (sum, row) =>
      sum +
      (texts.some((text) => text.includes(`${row.month} ${row.Harbor} ${row.Marsh}`)) ? 2 : 0),
    0,
  );

  const axisObserved = texts.some((text) =>
    text.includes(`Vertical axis: ${chartFacts.axisMinimum} to ${chartFacts.axisMaximum}`),
  );

  const unitObserved = texts.some((text) => text.includes(`Source readings (${chartFacts.unit})`));
  const sourceObserved = valuesObserved === 6 && axisObserved && unitObserved;

  return Schema.decodeSync(chartReport)({
    kind: "chart-data",
    passed: factsCorrect && sourceObserved,
    factsCorrect,
    reported,
    valuesObserved,
    expectedValues: 6,
    axisObserved,
    unitObserved,
    sourceObserved,
    prose: "ungraded",
  });
};

const precedingRequest = (events: ReadonlyArray<Event>, before: number) =>
  events.findLast((event) => event.kind === "request" && event.seq < before);

const successfulScroll = (
  sent: typeof call.Type,
  results: ReadonlyArray<typeof toolResult.Type>,
) => {
  if (sent.name !== "browser_scroll" && sent.name !== "browser_scroll_and_inspect") return false;

  const params = Schema.decodeUnknownOption(browserToolkit.tools.browser_scroll.parametersSchema)(
    sent.params,
  );

  if (Option.isNone(params) || (params.value.deltaX === 0 && params.value.deltaY === 0))
    return false;
  const result = results.find((part) => part.id === sent.id && part.name === sent.name);

  if (result === undefined || result.isFailure) return false;

  return sent.name === "browser_scroll"
    ? Option.isSome(
        Schema.decodeUnknownOption(browserToolkit.tools.browser_scroll.successSchema)(
          result.result,
        ),
      )
    : Option.isSome(
        Schema.decodeUnknownOption(observedToolkit.tools.browser_scroll_and_inspect.successSchema)(
          result.result,
        ),
      );
};

const feedGrade = (evidence: Evidence) => {
  const entries = evidence.events.flatMap((event) =>
    event.kind === "host"
      ? Option.match(Schema.decodeUnknownOption(commentaryEvent)(event.value), {
          onNone: () => [],
          onSome: (record) => [{ event, record }],
        })
      : [],
  );

  const calls = evidence.events.flatMap((event) =>
    event.kind === "response"
      ? Option.match(Schema.decodeUnknownOption(call)(event.value), {
          onNone: () => [],
          onSome: (sent) => (sent.name === commentaryTool.name ? [{ event, sent }] : []),
        })
      : [],
  );

  const commentary = entries.map(({ event, record }) => {
    const matched = calls.find(({ sent }) => sent.id === record.toolCallId);
    const request = precedingRequest(evidence.events, matched?.event.seq ?? event.seq);
    const view = visibleObservations(request?.value).at(-1);
    const expected = feedPosts.find((post) => post.id === record.params.postId);

    const fresh =
      record.fresh &&
      record.latestObservationId === record.params.observationId &&
      view?.observationId === record.params.observationId &&
      record.actionsUsed === record.observationActionsUsed;

    const sourceObserved =
      record.sourceObserved &&
      quoted(view, record.params) &&
      expected !== undefined &&
      normalize(record.params.quote) === normalize(expected.text) &&
      postText(view, expected.id)?.includes(normalize(expected.text)) === true;

    return {
      at: event.at,
      entryId: record.entryId,
      ...record.params,
      fresh,
      sourceObserved,
      claimCorrect:
        expected !== undefined && isDeepStrictEqual(record.params.claim, expected.claim),
      paired:
        matched !== undefined &&
        matched.event.seq < event.seq &&
        isDeepStrictEqual(matched.sent.params, record.params),
    };
  });

  const grounded = commentary.filter(
    (entry) => entry.fresh && entry.sourceObserved && entry.claimCorrect && entry.paired,
  );

  const groundedCoverage = [...new Set(grounded.map((entry) => entry.postId))];
  const observations = answeredObservations(evidence);

  const observedPosts = feedPosts.flatMap((post) =>
    observations.some((view) => postText(view, post.id)?.includes(normalize(post.text)))
      ? [post.id]
      : [],
  );

  const wrong = commentary.filter((entry) => !entry.claimCorrect || !entry.paired).length;
  const unread = commentary.filter((entry) => !entry.sourceObserved).length;
  const stale = commentary.filter((entry) => !entry.fresh).length;
  const duplicates = commentary.length - new Set(commentary.map((entry) => entry.postId)).size;

  const unrecorded = calls.filter(
    ({ sent }) => !entries.some(({ record }) => record.toolCallId === sent.id),
  ).length;

  const ordered = isDeepStrictEqual(
    commentary.map((entry) => entry.postId),
    feedPosts.map((post) => post.id),
  );

  const scrollTransitions = entries.flatMap(({ event, record }, index) => {
    const previous = entries[index - 1];

    if (previous === undefined) return [];
    const previousCall = calls.find(({ sent }) => sent.id === previous.record.toolCallId);
    const after = previousCall?.event.seq ?? previous.event.seq;
    const matched = calls.find(({ sent }) => sent.id === record.toolCallId);
    const request = precedingRequest(evidence.events, matched?.event.seq ?? event.seq);
    const results = visibleResults(request?.value);

    const scroll = evidence.events
      .flatMap((candidate) =>
        request !== undefined &&
        candidate.kind === "response" &&
        candidate.seq > after &&
        candidate.seq < request.seq
          ? Option.match(Schema.decodeUnknownOption(call)(candidate.value), {
              onNone: () => [],
              onSome: (sent) => (successfulScroll(sent, results) ? [sent] : []),
            })
          : [],
      )
      .at(-1);

    return [
      {
        entryId: record.entryId,
        postId: record.params.postId,
        turn: request?.turn ?? null,
        scrollToolCallId: scroll?.id ?? null,
        successful: scroll !== undefined,
      },
    ];
  });

  const successfulScrollTransitions = scrollTransitions.filter((entry) => entry.successful).length;
  const missingScrollTransitions = scrollTransitions.length - successfulScrollTransitions;

  const corrections = commentary.flatMap((entry, index) =>
    entry.claim.corrects === null
      ? []
      : [
          {
            postId: entry.postId,
            corrects: entry.claim.corrects,
            supported:
              grounded.includes(entry) &&
              commentary
                .slice(0, index)
                .some((prior) => prior.postId === entry.claim.corrects && grounded.includes(prior)),
          },
        ],
  );

  const correctionObserved = corrections.some(
    (entry) => entry.postId === "p05" && entry.corrects === "p02" && entry.supported,
  );

  return Schema.decodeSync(feedReport)({
    kind: "feed-commentary",
    passed:
      groundedCoverage.length === feedPosts.length &&
      wrong === 0 &&
      unread === 0 &&
      stale === 0 &&
      duplicates === 0 &&
      unrecorded === 0 &&
      ordered &&
      successfulScrollTransitions === feedPosts.length - 1 &&
      missingScrollTransitions === 0 &&
      correctionObserved,
    expectedPosts: 6,
    observedPosts,
    groundedCoverage,
    commentary,
    wrong,
    unread,
    stale,
    duplicates,
    unrecorded,
    ordered,
    successfulScrollTransitions,
    missingScrollTransitions,
    scrollTransitions,
    corrections,
    correctionObserved,
    prose: "ungraded",
  });
};

/** Structured facts and delivery are deterministic; free prose is retained without a truth grade. */
export const gradeUnderstanding = (evidence: Evidence): UnderstandingReport | null =>
  evidence.manifest.task === "chart-data"
    ? chartGrade(evidence)
    : evidence.manifest.task === "feed-commentary"
      ? feedGrade(evidence)
      : null;
