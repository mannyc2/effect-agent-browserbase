// The site's pages, in navigation order: one entry per markdown file in docs/. The app renders each
// at its route and the agent surface serves the same file as markdown, so a page's title and
// summary are written once, here, and its body once, in its file.

export interface Page {
  /** The file docs/<slug>.md; "index" is the home page. */
  readonly slug: string;
  readonly title: string;
  /** One sentence, for navigation, llms.txt and search results. */
  readonly summary: string;
  readonly section: "Start" | "Guides" | "Site";
}

export const site = {
  name: "effect-browser",
  tagline: "Browser automation for Effect agents, built to be watched.",
  origin: "https://effect-browser.dev",
  repository: "https://github.com/mannyc2/effect-agent-browserbase",
} as const;

export const pages: ReadonlyArray<Page> = [
  {
    slug: "index",
    title: "effect-browser",
    summary:
      "Browser automation for Effect agents: page control, compact outlines for models, screencast frames and moments, built to be watched.",
    section: "Start",
  },
  {
    slug: "get-started",
    title: "Get started",
    summary: "Install the packages and run a Yielded agent against a local Chromium.",
    section: "Start",
  },
  {
    slug: "run-the-demo",
    title: "Run the demo yourself",
    summary: "Record your own narrated take of the Polymarket demo on your machine.",
    section: "Start",
  },
  {
    slug: "moments-and-narration",
    title: "Moments and narration",
    summary:
      "What a page showed and what changed on it over a window, ready for a model, and the narrator that speaks over a run.",
    section: "Guides",
  },
  {
    slug: "watched-browsing",
    title: "Watched browsing",
    summary:
      "Presenter views that perform input at a person's pace, with cues, scoped authority and clean step cuts.",
    section: "Guides",
  },
  {
    slug: "agent-tools",
    title: "Agent tools",
    summary: "effect-agent-browser: issued pages as Yielded Agent's browser ports and tools.",
    section: "Guides",
  },
  {
    slug: "browserbase",
    title: "Browserbase",
    summary: "Hosted Browserbase sessions as the same Browser, with leases, contexts and release.",
    section: "Guides",
  },
  {
    slug: "for-agents",
    title: "For AI agents",
    summary: "Every page as markdown, llms.txt, a JSON index and the replays' data files.",
    section: "Site",
  },
  {
    slug: "deploying",
    title: "Deploying this site",
    summary: "The CAFE stack: a Foldkit app and a Worker on Cloudflare, deployed with Alchemy.",
    section: "Site",
  },
];

/** The route a page is served at. */
export const pathOf = (page: Pick<Page, "slug">) =>
  page.slug === "index" ? "/" : `/docs/${page.slug}`;

/** Where its markdown is served. */
export const markdownPathOf = (page: Pick<Page, "slug">) =>
  page.slug === "index" ? "/index.md" : `/docs/${page.slug}.md`;

/** The replay the site features. */
export const featuredReplay = "polymarket";
