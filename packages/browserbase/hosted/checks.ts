// The registry of guarded hosted checks. Each entry is one paid question: what it may spend,
// what it needs from the operator and the one claim a successful run supports.
//
// This file is plain data with erasable types only, so the dependency-free maintenance tools
// read the same declarations the checks enforce. `tools/hosted-run.sh` refuses any name that is
// not listed here, and `tools/test/hosted.test.mjs` holds every entry to the ceilings below in
// ordinary unpaid CI, before anything is spent.
//
// `question` names the hosted question the check narrows; docs/HOSTED.md defines the codes.
// A check narrows its question; it does not answer all of it, and `claim` says exactly how much.
// `evidence` points at the recorded run that established the claim, or is null while the claim
// is outstanding.

export interface Budget {
  /** Provider sessions the check may allocate. */
  readonly sessions: number;
  /** Elapsed bound on each session's policy, which fails the work rather than extending it. */
  readonly browserSeconds: number;
  /** Action bound on each session's policy. */
  readonly actions: number;
  /** Live frame capture, per session. */
  readonly captureSeconds: number;
  /** Largest single provider transfer, in either direction. */
  readonly transferBytes: number;
}

export interface Check {
  readonly question: "H1" | "H3" | "H4" | "H6" | "H7" | null;
  readonly claim: string;
  readonly evidence: string | null;
  readonly budget: Budget;
  /** Required beyond the gate's opt-in, API key and project. */
  readonly env: ReadonlyArray<string>;
  readonly optionalEnv: ReadonlyArray<string>;
  /** Needs a person at a Live View during the run, so it never runs unattended. */
  readonly operator: boolean;
  /** Produces documentation media that `tools/hosted-media.sh` encodes and bounds. */
  readonly media: boolean;
}

/** No single check may exceed these, whatever its entry says. */
export const ceiling: Budget = {
  sessions: 2,
  browserSeconds: 300,
  actions: 20,
  captureSeconds: 15,
  transferBytes: 512 * 1024 * 1024,
};

export const checks = {
  acceptance: {
    question: null,
    claim:
      "Allocation, CDP connect, navigation, live capture, Live View URL retrieval, confirmed release, and provider recording assembly and download through the artifactOrigins check.",
    evidence: "docs/STATUS.md#owner-authorized-hosted-acceptance-21-september-2026",
    budget: {
      sessions: 1,
      browserSeconds: 180,
      actions: 10,
      captureSeconds: 3,
      transferBytes: 512 * 1024 * 1024,
    },
    env: ["BROWSERBASE_ARTIFACT_ORIGINS"],
    optionalEnv: [],
    operator: false,
    media: false,
  },
  demo: {
    question: null,
    claim: "Documentation media only: a real session ran. It supports no correctness claim.",
    evidence: "docs/STATUS.md#maintainer-reported-hosted-execution",
    budget: { sessions: 1, browserSeconds: 120, actions: 10, captureSeconds: 15, transferBytes: 0 },
    env: [],
    optionalEnv: ["BROWSERBASE_DEMO_URL", "BROWSERBASE_DEMO_MILLIS"],
    operator: false,
    media: true,
  },
  handoff: {
    question: null,
    claim:
      "An operator can take over a session through Live View and release it, and resume then returns a fresh observation of the same session.",
    evidence: "docs/STATUS.md#owner-authorized-hosted-checks-21-september-2026",
    budget: { sessions: 1, browserSeconds: 300, actions: 10, captureSeconds: 0, transferBytes: 0 },
    env: [],
    optionalEnv: [],
    operator: true,
    media: false,
  },
  "context-durability": {
    question: "H1",
    claim:
      "A cookie and a localStorage marker written by a persisting session are readable by a later non-persisting session on the same context. Other stores and flush timing stay open.",
    evidence: "docs/STATUS.md#owner-authorized-hosted-checks-21-september-2026",
    budget: { sessions: 2, browserSeconds: 120, actions: 10, captureSeconds: 0, transferBytes: 0 },
    env: [],
    optionalEnv: [],
    operator: false,
    media: false,
  },
  "keepalive-reconnect": {
    question: "H4",
    claim:
      "A keep-alive session survives detach, reconnect observes the same page, and an init script registered before detach is ready on a fresh document after reconnect.",
    evidence: "docs/STATUS.md#owner-authorized-hosted-checks-21-september-2026",
    budget: { sessions: 1, browserSeconds: 120, actions: 10, captureSeconds: 0, transferBytes: 0 },
    env: [],
    optionalEnv: [],
    operator: false,
    media: false,
  },
  "extension-identity": {
    question: "H3",
    claim:
      "A registered MV3 extension keeps its project-qualified identity on retrieve, and when selected at launch its content script runs in the page.",
    evidence: "docs/STATUS.md#owner-authorized-hosted-checks-21-september-2026",
    budget: {
      sessions: 1,
      browserSeconds: 120,
      actions: 10,
      captureSeconds: 0,
      transferBytes: 64 * 1024,
    },
    env: [],
    optionalEnv: [],
    operator: false,
    media: false,
  },
  "upload-routing": {
    question: "H6",
    claim:
      "Bytes sent through the session upload API reach the remote file chooser at the receipt's path, with the same name, size and content.",
    evidence: "docs/STATUS.md#owner-authorized-hosted-checks-21-september-2026",
    budget: {
      sessions: 1,
      browserSeconds: 120,
      actions: 15,
      captureSeconds: 0,
      transferBytes: 64 * 1024,
    },
    env: [],
    optionalEnv: [],
    operator: false,
    media: false,
  },
  "replay-delivery": {
    question: "H7",
    claim:
      "A recorded session's replay playlist validates and its first media segment downloads through the artifactOrigins check. The recording's delivery kind is reported as observed, so a BYOS project shows up as such rather than as a failure.",
    evidence: "docs/STATUS.md#owner-authorized-hosted-checks-21-september-2026",
    budget: {
      sessions: 1,
      browserSeconds: 120,
      actions: 10,
      captureSeconds: 0,
      transferBytes: 64 * 1024 * 1024,
    },
    env: ["BROWSERBASE_ARTIFACT_ORIGINS"],
    optionalEnv: [],
    operator: false,
    media: false,
  },
  "live-capture": {
    question: null,
    claim:
      "At real round trips: how captured frames are paced while a page scrolls, whether the last picture before the page goes still reaches the host (saved beside a screenshot for comparison), what a viewport reading of a page under a transparent pass-through container returns and costs, and whether a page's debug websocket evaluates without credentials. It reports measurements; it establishes only that frames arrived, intervals stopped cleanly and the reading returned text.",
    evidence: null,
    budget: {
      sessions: 2,
      browserSeconds: 120,
      actions: 20,
      captureSeconds: 12,
      transferBytes: 0,
    },
    env: [],
    optionalEnv: [],
    operator: false,
    media: false,
  },
} as const satisfies Record<string, Check>;

export type CheckName = keyof typeof checks;
