// The demo site: one tab per claim, each demo's replays side by side, and how each is checked.
// Replays load up front, so a demo with any replay not yet packed can be left off the built site.
import { Schema } from "effect";
import { useEffect, useState } from "react";

import { type Demo, type Section, sections } from "./catalog.ts";
import { Player } from "./Player.tsx";
import { Replay } from "./Replay.ts";

const decode = Schema.decodeUnknownSync(Replay);

/** A replay by id, or null when it is absent or does not decode. */
const load = (id: string): Promise<Replay | null> =>
  fetch(`replays/${id}/replay.json`)
    .then((response) =>
      response.ok && response.headers.get("content-type")?.includes("json") === true
        ? response.json()
        : Promise.reject(new Error(`${id} is not packed`)),
    )
    .then(
      (json: unknown) => decode(json),
      () => null,
    );

type Loaded = ReadonlyMap<string, Replay | null>;

const useReplays = (): Loaded | undefined => {
  const [loaded, setLoaded] = useState<Loaded>();

  useEffect(() => {
    let current = true;

    const ids = [
      ...new Set(sections.flatMap((section) => section.demos.flatMap((demo) => demo.replays))),
    ].map((replay) => replay.id);

    void Promise.all(ids.map(async (id) => [id, await load(id)] as const)).then((entries) => {
      if (current) setLoaded(new Map(entries));
    });

    return () => {
      current = false;
    };
  }, []);

  return loaded;
};

/** A demo is shown once every replay in it is packed; the dev server also lists the rest. */
const complete = (demo: Demo, loaded: Loaded) =>
  demo.replays.every((replay) => (loaded.get(replay.id) ?? null) !== null);

const DemoView = (props: {
  readonly demo: Demo;
  readonly section: Section;
  readonly loaded: Loaded;
}) => {
  const { demo } = props;
  const [startSignal, setStartSignal] = useState(0);
  const solo = demo.replays.length === 1;

  return (
    <article className="demo" id={demo.id}>
      <header>
        <div>
          <h3>{demo.title}</h3>
          <p>{demo.blurb}</p>
        </div>
        {!solo && (
          <button type="button" className="together" onClick={() => setStartSignal((n) => n + 1)}>
            Play both
          </button>
        )}
      </header>
      <div className={solo ? "players" : "players pair"}>
        {demo.replays.map((ref) => {
          const replay = props.loaded.get(ref.id);

          return replay === undefined || replay === null ? null : (
            <Player
              key={ref.id}
              base={`replays/${ref.id}`}
              label={ref.label}
              replay={replay}
              solo={solo}
              check={solo ? demo.check : undefined}
              reference={props.section.reference}
              startSignal={startSignal}
            />
          );
        })}
      </div>
      {!solo && (
        <p className="check shared">
          <strong>How it's checked:</strong> {demo.check}
        </p>
      )}
    </article>
  );
};

/** Dev server only: the demos the built site leaves off, and the commands that record them. */
const Missing = (props: { readonly demos: ReadonlyArray<Demo>; readonly loaded: Loaded }) =>
  props.demos.length === 0 ? null : (
    <aside className="missing">
      <strong>Dev only: not on the built site until recorded and packed</strong>
      {props.demos.map((demo) => (
        <div key={demo.id}>
          <span>{demo.title}</span>
          {demo.replays
            .filter((replay) => (props.loaded.get(replay.id) ?? null) === null)
            .map((replay) => (
              <code key={replay.id}>
                {replay.id}: {replay.record}
              </code>
            ))}
        </div>
      ))}
    </aside>
  );

const fromHash = () => window.location.hash.slice(1);

export const App = () => {
  const loaded = useReplays();
  const [active, setActive] = useState(fromHash);

  useEffect(() => {
    const follow = () => setActive(fromHash());

    window.addEventListener("hashchange", follow);

    return () => window.removeEventListener("hashchange", follow);
  }, []);

  const visible =
    loaded === undefined
      ? []
      : sections.filter(
          (section) => import.meta.env.DEV || section.demos.some((demo) => complete(demo, loaded)),
        );

  const section = visible.find((candidate) => candidate.id === active) ?? visible[0];

  return (
    <>
      <header className="top">
        <span className="brand">effect-browser</span>
        <span className="tagline">recorded demos</span>
        <a href="https://github.com/mannyc2/effect-agent-browserbase">GitHub</a>
      </header>
      <main>
        <section className="hero">
          <h1>Real browser sessions, recorded and checked.</h1>
          <p className="lede">
            Each video is a real Chromium session driven by effect-browser, either by an AI agent or
            by a fixed script. The pointer, clicks and keystrokes drawn over it are the exact input
            that was sent. When a run ends, its answer is checked against the page&apos;s own data,
            not taken on the agent&apos;s word.
          </p>
        </section>
        {loaded === undefined ? (
          <p className="loading">Loading recordings…</p>
        ) : (
          <>
            <nav className="tabs" aria-label="Demos">
              {visible.map((candidate) => (
                <a
                  key={candidate.id}
                  href={`#${candidate.id}`}
                  aria-current={candidate === section ? "page" : undefined}
                >
                  {candidate.title}
                </a>
              ))}
            </nav>
            {section !== undefined && (
              <section className="section" aria-labelledby={`${section.id}-title`}>
                <h2 id={`${section.id}-title`}>{section.title}</h2>
                <p className="lede">{section.lede}</p>
                {section.demos
                  .filter((demo) => complete(demo, loaded))
                  .map((demo) => (
                    <DemoView key={demo.id} demo={demo} section={section} loaded={loaded} />
                  ))}
                {import.meta.env.DEV && (
                  <Missing
                    demos={section.demos.filter((demo) => !complete(demo, loaded))}
                    loaded={loaded}
                  />
                )}
              </section>
            )}
          </>
        )}
      </main>
      <footer className="foot">
        The browser&apos;s own screencast has no cursor, so the pointer, click ripples and status
        line are drawn in your browser from the recorded input. The pages are self-contained test
        sites with fixed data, so every run can be checked exactly.
      </footer>
    </>
  );
};
