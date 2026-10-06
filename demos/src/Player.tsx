// Plays one packed replay: the video with the pointer, presses and a status line drawn over it
// from the recorded track, a timeline, and beside it the run's result and its story in words.
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import {
  type CallWords,
  clock,
  cost,
  describeCall,
  doing,
  duration,
  type Field,
  fields,
  sameField,
} from "./present.ts";
import { pointerAt, recentMark, type Replay, type Track, track } from "./Replay.ts";

/** The standard arrow pointer, with its hot spot at the origin. */
const arrow = new Path2D("M0 0 L0 17 L4.5 13 L7.5 20 L10.5 18.8 L7.6 12 L13 12 Z");

const draw = (canvas: HTMLCanvasElement, recorded: Track, at: number, scale: number) => {
  const context = canvas.getContext("2d");

  if (context === null) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const press = recentMark(recorded.presses, at, 500);

  if (press !== undefined) {
    context.beginPath();
    context.arc(
      press.mark.x * scale,
      press.mark.y * scale,
      6 + press.progress * 24,
      0,
      Math.PI * 2,
    );
    context.strokeStyle = `rgba(249, 115, 22, ${1 - press.progress})`;
    context.lineWidth = 3;
    context.stroke();
  }

  const wheel = recentMark(recorded.wheels, at, 500);

  if (wheel !== undefined) {
    const direction = Math.sign(wheel.mark.dy) || 1;
    const x = wheel.mark.x * scale + 22;
    const y = wheel.mark.y * scale + direction * wheel.progress * 10;

    context.fillStyle = `rgba(59, 130, 246, ${1 - wheel.progress})`;
    context.beginPath();
    context.moveTo(x - 6, y - direction * 4);
    context.lineTo(x + 6, y - direction * 4);
    context.lineTo(x, y + direction * 5);
    context.fill();
  }

  const pointer = pointerAt(recorded, at);

  if (pointer !== undefined) {
    context.save();
    context.translate(pointer.x * scale, pointer.y * scale);
    context.shadowColor = "rgba(0, 0, 0, 0.35)";
    context.shadowBlur = 4;
    context.shadowOffsetY = 1;
    context.fillStyle = "#111";
    context.strokeStyle = "#fff";
    context.lineWidth = 1.5;
    context.stroke(arrow);
    context.shadowColor = "transparent";
    context.fill(arrow);
    context.restore();
  }
};

interface Span {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly ok: boolean;
}

const actionSpans = (replay: Replay): Array<Span> =>
  replay.events.flatMap(({ event }) =>
    event._tag === "Action"
      ? [{ start: event.startedAt, end: event.at, label: doing(event), ok: event.ok }]
      : [],
  );

/** The question a model answered over the recording's frames, if this run had one. */
const questionOf = (replay: Replay) =>
  replay.moments.find((moment) => moment.expected !== undefined);

type Entry =
  | { readonly kind: "caption"; readonly at: number; readonly text: string }
  | {
      readonly kind: "steps";
      readonly at: number;
      readonly first: number;
      readonly last: number;
      readonly said: string;
      readonly calls: ReadonlyArray<CallWords>;
      readonly rejected: string | undefined;
    };

const sameSteps = (
  left: Extract<Entry, { kind: "steps" }>,
  right: Extract<Entry, { kind: "steps" }>,
) =>
  left.said === right.said &&
  left.rejected === right.rejected &&
  JSON.stringify(left.calls) === JSON.stringify(right.calls);

/** The narrator's captions and the agent's steps in time order, repeated steps folded into one. */
const story = (replay: Replay): Array<Entry> => {
  const captions = replay.moments.flatMap((moment): Array<Entry> =>
    moment.caption === undefined ? [] : [{ kind: "caption", at: moment.at, text: moment.caption }],
  );

  const steps = replay.steps.map((step): Entry => ({
    kind: "steps",
    at: step.at,
    first: step.step,
    last: step.step,
    said: step.text.trim(),
    calls: step.calls.map((call, order) => describeCall(call, step.results[order])),
    rejected: step.rejected,
  }));

  const folded: Array<Entry> = [];

  for (const entry of [...captions, ...steps].toSorted((left, right) => left.at - right.at)) {
    const previous = folded.at(-1);

    if (previous?.kind === "steps" && entry.kind === "steps" && sameSteps(previous, entry))
      folded[folded.length - 1] = { ...previous, last: entry.last };
    else folded.push(entry);
  }

  return folded;
};

/** What is happening at `now`, for the status line over the video. */
const statusAt = (
  replay: Replay,
  spans: ReadonlyArray<Span>,
  now: number,
): { readonly text: string; readonly tone: "act" | "fail" | "wait" } | undefined => {
  const action = spans.findLast((span) => span.start <= now && span.end >= now);

  if (action !== undefined) return { text: action.label, tone: action.ok ? "act" : "fail" };
  const question = questionOf(replay);

  if (question !== undefined && question.from <= now && now <= question.at)
    return { text: "Capturing frames for the model", tone: "wait" };
  const lastStep = replay.steps.at(-1);

  if (lastStep !== undefined && now < lastStep.at)
    return { text: "Deciding the next step…", tone: "wait" };

  return undefined;
};

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
  </svg>
);

const PauseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />
  </svg>
);

const ReplayIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5V2L7.5 6 12 10V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" fill="currentColor" />
  </svg>
);

const Timeline = (props: {
  readonly replay: Replay;
  readonly now: number;
  readonly spans: ReadonlyArray<Span>;
  readonly onSeek: (at: number) => void;
}) => {
  const { startsAt, durationMillis } = props.replay.video;
  const question = questionOf(props.replay);
  const fraction = (at: number) => Math.min(1, Math.max(0, (at - startsAt) / durationMillis));
  const left = (at: number) => `${fraction(at) * 100}%`;

  const width = (start: number, end: number) =>
    `max(3px, ${(fraction(end) - fraction(start)) * 100}%)`;

  const seekTo = (element: HTMLElement, clientX: number) => {
    const box = element.getBoundingClientRect();

    props.onSeek(startsAt + ((clientX - box.left) / box.width) * durationMillis);
  };

  return (
    <div
      className="timeline"
      role="slider"
      aria-label="Position in the recording"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMillis)}
      aria-valuenow={Math.round(props.now - startsAt)}
      aria-valuetext={`${clock(props.now - startsAt, durationMillis)} of ${clock(durationMillis, durationMillis)}`}
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        seekTo(event.currentTarget, event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          seekTo(event.currentTarget, event.clientX);
      }}
      onKeyDown={(event) => {
        const step = Math.max(1000, durationMillis / 20);

        if (event.key === "ArrowRight") props.onSeek(props.now + step);
        else if (event.key === "ArrowLeft") props.onSeek(props.now - step);
        else if (event.key === "Home") props.onSeek(startsAt);
        else if (event.key === "End") props.onSeek(startsAt + durationMillis);
        else return;
        event.preventDefault();
      }}
    >
      <div className="track">
        <span className="played" style={{ width: left(props.now) }} />
        {question !== undefined && (
          <span
            className="window"
            style={{ left: left(question.from), width: width(question.from, question.at) }}
            title="The stretch the model's frames come from"
          />
        )}
        {props.spans.map((span, index) => (
          <span
            key={index}
            className={span.ok ? "span" : "span failed"}
            style={{ left: left(span.start), width: width(span.start, span.end) }}
            title={span.label}
          />
        ))}
      </div>
      {props.replay.steps.map((step) => (
        <span
          key={`s${step.step}`}
          className={step.results.some((result) => result.isFailure) ? "dot failed" : "dot"}
          style={{ left: left(step.at) }}
          title={`Step ${step.step}`}
        />
      ))}
      {question?.frames.map((frame, order) => (
        <span
          key={`f${order}`}
          className="frame-tick"
          style={{ left: left(frame.hostTime) }}
          title={`Frame ${order + 1} given to the model`}
        />
      ))}
      <span className="playhead" style={{ left: left(props.now) }} />
    </div>
  );
};

/** Names the timeline's marks that this replay has. */
const Legend = ({ replay }: { readonly replay: Replay }) => {
  const failedStep = replay.steps.some((step) => step.results.some((result) => result.isFailure));

  return (
    <div className="legend">
      <span>
        <i className="key-span" /> browser input
      </span>
      {replay.steps.length > 0 && (
        <span>
          <i className="key-dot" /> agent step
        </span>
      )}
      {failedStep && (
        <span>
          <i className="key-dot failed" /> step that failed
        </span>
      )}
      {questionOf(replay) !== undefined && (
        <span>
          <i className="key-frame" /> frame given to the model
        </span>
      )}
    </div>
  );
};

const FieldList = (props: {
  readonly items: ReadonlyArray<Field>;
  readonly marks?: ReadonlyMap<string, boolean> | undefined;
}) => (
  <dl className="fields">
    {props.items.map((item) => {
      const mark = props.marks?.get(item.key);

      return (
        <div key={item.key}>
          <dt>{item.label}</dt>
          <dd className={mark === false ? "wrong" : undefined}>
            {item.value}
            {mark !== undefined && (
              <span className="mark" aria-label={mark ? "matches" : "does not match"}>
                {mark ? " ✓" : " ✗"}
              </span>
            )}
          </dd>
        </div>
      );
    })}
  </dl>
);

const Badge = ({ replay }: { readonly replay: Replay }) => {
  const { outcome } = replay;

  if (outcome.status !== "graded" || outcome.pass === null)
    return <span className="badge">Not graded</span>;

  return outcome.pass ? (
    <span className="badge pass">✓ Passed</span>
  ) : (
    <span className="badge fail">✗ Failed</span>
  );
};

/** The run's length, its steps and what its models cost, or that a script drove it. */
const Stats = ({ replay }: { readonly replay: Replay }) => (
  <ul className="stats">
    <li>{duration(replay.video.durationMillis)}</li>
    {replay.run.model === null ? (
      <li>scripted, no AI</li>
    ) : (
      <>
        <li>
          {replay.steps.length} {replay.steps.length === 1 ? "step" : "steps"}
        </li>
        <li>{cost(replay.outcome.knownUsd)} in model calls</li>
      </>
    )}
  </ul>
);

/** What the run reported and whether the page agrees, with what the check requires. */
const Result = (props: {
  readonly replay: Replay;
  readonly check: string | undefined;
  readonly reference: string | undefined;
}) => {
  const { replay } = props;
  const { outcome } = replay;
  const question = questionOf(replay);
  const failed = outcome.status === "graded" && outcome.pass === false;

  return (
    <section className={failed ? "result failed" : "result"}>
      {question === undefined ? (
        <>
          <h5>{replay.run.model === null ? "The script reported" : "The agent reported"}</h5>
          <FieldList items={fields(outcome.answer)} />
        </>
      ) : replay.run.model === null ? (
        <>
          <h5>The correct answer, from the page</h5>
          <FieldList items={fields(question.expected)} />
          {props.reference !== undefined && <p className="note">{props.reference}</p>}
        </>
      ) : (
        <div className="compare">
          <div>
            <h5>The model answered</h5>
            <FieldList
              items={fields(outcome.answer)}
              marks={
                new Map(
                  fields(outcome.answer).map((field) => [
                    field.key,
                    sameField(outcome.answer, question.expected, field.key),
                  ]),
                )
              }
            />
          </div>
          <div>
            <h5>The page held</h5>
            <FieldList items={fields(question.expected)} />
          </div>
        </div>
      )}
      {failed && (
        <p className="why">
          <strong>Why it failed:</strong> {outcome.detail}
        </p>
      )}
      {props.check !== undefined && (
        <p className="check">
          <strong>How it's checked:</strong> {props.check}
        </p>
      )}
    </section>
  );
};

/** The question a model receives and the frames it sees, each a link to its instant. */
const Question = (props: {
  readonly replay: Replay;
  readonly base: string;
  readonly onSeek: (at: number) => void;
}) => {
  const question = questionOf(props.replay);
  const [open, setOpen] = useState(false);

  if (question === undefined) return null;

  return (
    <section className="question">
      <h5>The question</h5>
      <p className={open ? "prompt open" : "prompt"}>{question.question}</p>
      {question.question.length > 180 && (
        <button type="button" className="link" onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show the whole question"}
        </button>
      )}
      <h5>
        {question.frames.length === 1
          ? "The frame it sees"
          : `The ${question.frames.length} frames it sees, oldest first`}
      </h5>
      <div className="frames">
        {question.frames.map((frame, order) => (
          <button
            key={frame.file}
            type="button"
            onClick={() => props.onSeek(frame.hostTime)}
            title="Jump to this instant in the video"
          >
            <img src={`${props.base}/${frame.file}`} alt={`Frame ${order + 1}`} />
            <span>
              {clock(
                frame.hostTime - props.replay.video.startsAt,
                props.replay.video.durationMillis,
              )}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
};

const Call = ({ call }: { readonly call: CallWords }) => (
  <span className={call.failed ? "call failed" : "call"} title={call.technical}>
    {call.failed ? `✗ ${call.text}, ${call.why ?? "failed"}` : call.text}
    {call.answer !== undefined && (
      <span className="answer">
        {fields(call.answer)
          .map((field) => `${field.label}: ${field.value}`)
          .join(" · ")}
      </span>
    )}
  </span>
);

/** The narrator's captions and the agent's steps, following playback; each jumps to its time. */
const Feed = (props: {
  readonly entries: ReadonlyArray<Entry>;
  readonly now: number;
  readonly onSeek: (at: number) => void;
}) => {
  const list = useRef<HTMLOListElement>(null);
  const { entries } = props;
  const current = entries.findLastIndex((entry) => entry.at <= props.now);

  useEffect(() => {
    const container = list.current;

    if (container === null) return;
    const item = container.children[current];

    // Before the first entry, the list starts at its top; after it, the current entry sits a
    // third of the way down.
    container.scrollTo({
      top: item instanceof HTMLElement ? item.offsetTop - container.clientHeight / 3 : 0,
      behavior: "smooth",
    });
  }, [current]);

  if (entries.length === 0) return null;

  return (
    <section className="story">
      <h5>Step by step</h5>
      <ol className="feed" ref={list}>
        {entries.map((entry, index) => (
          <li
            key={index}
            className={[
              entry.kind,
              index === current ? "current" : "",
              index > current ? "upcoming" : "",
            ].join(" ")}
          >
            <button type="button" onClick={() => props.onSeek(entry.at)}>
              {entry.kind === "caption" ? (
                <>
                  <span className="who">Narrator</span>
                  <span className="said">{entry.text}</span>
                </>
              ) : (
                <>
                  <span className="who">
                    {entry.first === entry.last
                      ? `Step ${entry.first}`
                      : `Steps ${entry.first}–${entry.last}`}
                    {entry.first !== entry.last && (
                      <span className="times"> · {entry.last - entry.first + 1} times</span>
                    )}
                  </span>
                  {entry.said !== "" && <span className="said">{entry.said}</span>}
                  {entry.calls.map((call, order) => (
                    <Call key={order} call={call} />
                  ))}
                  {entry.rejected !== undefined && (
                    <span className="call failed">✗ {entry.rejected}</span>
                  )}
                </>
              )}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
};

const speeds = [1, 2, 4] as const;

export interface PlayerProps {
  readonly base: string;
  readonly label: string;
  readonly replay: Replay;
  /** One player alone in its demo gets a side panel with the run's story. */
  readonly solo: boolean;
  /** What the check requires, said beside a solo player's result. */
  readonly check: string | undefined;
  readonly reference: string | undefined;
  /** Changes to restart playback from the beginning, so a group starts together. */
  readonly startSignal: number;
}

export const Player = (props: PlayerProps): ReactNode => {
  const { base, label, replay, startSignal } = props;
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [now, setNow] = useState(replay.video.startsAt);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  // A long agent run is mostly the model thinking; start it at double speed.
  const [speed, setSpeed] = useState<number>(replay.video.durationMillis > 60_000 ? 2 : 1);
  const recorded = useMemo(() => track(replay.events), [replay]);
  const spans = useMemo(() => actionSpans(replay), [replay]);
  const entries = useMemo(() => story(replay), [replay]);
  const viewport = replay.viewports[0]?.width ?? replay.video.width;
  const { startsAt, durationMillis } = replay.video;

  useEffect(() => {
    let frame = 0;
    let shown = 0;

    const tick = (time: number) => {
      const element = video.current;
      const surface = canvas.current;

      if (element !== null && surface !== null) {
        const at = startsAt + element.currentTime * 1000;

        draw(surface, recorded, at, surface.clientWidth / viewport);
        if (time - shown > 80) {
          shown = time;
          setNow(at);
        }
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [recorded, startsAt, viewport]);

  useEffect(() => {
    if (video.current !== null) video.current.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    const element = video.current;

    if (element === null || startSignal === 0) return;
    element.currentTime = 0;
    void element.play();
  }, [startSignal]);

  const seek = (at: number) => {
    const element = video.current;

    if (element === null) return;
    element.currentTime = Math.min(durationMillis, Math.max(0, at - startsAt)) / 1000;
    setNow(startsAt + element.currentTime * 1000);
  };

  const toggle = () => {
    const element = video.current;

    if (element === null) return;
    if (element.paused) void element.play();
    else element.pause();
  };

  const status = statusAt(replay, spans, now);

  const caption = replay.moments.findLast(
    (moment) => moment.caption !== undefined && moment.at <= now,
  );

  const screen = (
    <div className="viewer">
      <div
        className="screen"
        style={{ aspectRatio: `${replay.video.width} / ${replay.video.height}` }}
        onClick={toggle}
      >
        <video
          ref={video}
          src={`${base}/${replay.video.file}`}
          muted
          playsInline
          preload="auto"
          onPlay={() => {
            setPlaying(true);
            setEnded(false);
          }}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setEnded(true);
          }}
          onLoadedMetadata={(event) => {
            event.currentTarget.playbackRate = speed;
          }}
        />
        <canvas ref={canvas} aria-hidden="true" />
        {status !== undefined && (
          <span className={`status ${status.tone}`} aria-live="off">
            {status.text}
          </span>
        )}
        {caption?.caption !== undefined && (
          <p className="subtitle">
            <span>{caption.caption}</span>
          </p>
        )}
        {!playing && (
          <button
            type="button"
            className="big-play"
            aria-label={ended ? "Watch again" : "Play"}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          >
            {ended ? <ReplayIcon /> : <PlayIcon />}
          </button>
        )}
      </div>
      <div className="controls">
        <button
          type="button"
          className="icon"
          aria-label={playing ? "Pause" : "Play"}
          onClick={toggle}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <Timeline replay={replay} now={now} spans={spans} onSeek={seek} />
        <span className="clock">
          {clock(now - startsAt, durationMillis)} / {clock(durationMillis, durationMillis)}
        </span>
        <div className="speed" role="group" aria-label="Playback speed">
          {speeds.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={speed === option}
              onClick={() => setSpeed(option)}
            >
              {option}×
            </button>
          ))}
        </div>
      </div>
      <Legend replay={replay} />
    </div>
  );

  return (
    <figure
      className={
        // A solo player with a story fits its panel to the video and scrolls the story inside.
        props.solo ? (entries.length > 0 ? "player solo fitted" : "player solo") : "player"
      }
    >
      <figcaption>
        <h4>{label}</h4>
        <Badge replay={replay} />
        <Stats replay={replay} />
      </figcaption>
      <div className="body">
        {screen}
        <aside className="panel">
          <Question replay={replay} base={base} onSeek={seek} />
          <Result replay={replay} check={props.check} reference={props.reference} />
          {props.solo && <Feed entries={entries} now={now} onSeek={seek} />}
        </aside>
      </div>
    </figure>
  );
};
