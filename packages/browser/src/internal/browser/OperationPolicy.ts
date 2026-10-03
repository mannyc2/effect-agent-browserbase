import type { BrowserOperation } from "../../Errors.ts";

/**
 * What the owner spends on an operation: a browser action, a host read, or nothing (inventory,
 * lifecycle, recovery and inspection that sends no input).
 */
export type Charge = "action" | "host-read" | "none";

/**
 * The static facts of one operation confined to one exact page: it takes that page's permit, and
 * an unknown outcome is contained by closing that page.
 */
export interface PagePolicy {
  readonly work: "page";
  /** Dispatching it can change the document, so it retires the page's observations. */
  readonly mutation: boolean;
  readonly charge: Charge;
  /** A page held by `PageControl.suspend` is refused before any native work, never woken. */
  readonly refuseHeld: boolean;
  /** It depends on an initialized document, so it waits for the current one's readiness. */
  readonly ready: boolean;
  /**
   * Recovery work stops or closes what is already in flight: it has its own bounded admission,
   * so a pending navigation's reservation does not refuse it.
   */
  readonly recovery: boolean;
  /** A pending native wait on the page refuses it, as it refuses every mutation. */
  readonly refuseWhileWaiting: boolean;
}

/**
 * Work on the page inventory: it takes the registry permit, and an unknown outcome fences the
 * owner, since no single page could absorb it.
 */
export interface RegistryPolicy {
  readonly work: "registry";
  readonly mutation: boolean;
  readonly charge: Charge;
}

/**
 * `lifecycle`, `capture` and `boundary` operations are admitted elsewhere (the owner's phase
 * changes, the capture module, or a refusal at the public boundary) and never take the page or
 * registry execution path.
 */
export type OperationPolicy =
  | PagePolicy
  | RegistryPolicy
  | { readonly work: "lifecycle" | "capture" | "boundary" };

const onPage = (facts: {
  readonly mutation: boolean;
  readonly charge: Charge;
  readonly refuseHeld: boolean;
  readonly ready: boolean;
  readonly recovery?: true;
  readonly refuseWhileWaiting?: true;
}): PagePolicy => ({
  work: "page",
  recovery: false,
  refuseWhileWaiting: false,
  ...facts,
});

const registry = (facts: {
  readonly mutation: boolean;
  readonly charge: Charge;
}): RegistryPolicy => ({ work: "registry", ...facts });

const lifecycle = { work: "lifecycle" } as const;
const capture = { work: "capture" } as const;
const boundary = { work: "boundary" } as const;

/** Every operation's policy. A new operation does not compile until its row decides it. */
export const OperationPolicies = {
  // configuration and lifetime: the owner's own phase changes
  configure: boundary,
  launch: lifecycle,
  connect: lifecycle,
  reconnect: lifecycle,
  detach: lifecycle,
  disconnect: lifecycle,
  close: lifecycle,
  handoff: lifecycle,
  resume: lifecycle,
  "live-view": lifecycle,
  // targets
  target: registry({ mutation: false, charge: "none" }),
  handle: boundary,
  "list-pages": registry({ mutation: false, charge: "none" }),
  "describe-page": onPage({ mutation: false, charge: "none", refuseHeld: false, ready: false }),
  "list-frames": onPage({ mutation: false, charge: "none", refuseHeld: false, ready: false }),
  "select-page": registry({ mutation: false, charge: "none" }),
  // Opening a tab changes the inventory, not any page's document.
  "new-page": registry({ mutation: true, charge: "none" }),
  "close-page": onPage({
    mutation: true,
    charge: "none",
    refuseHeld: false,
    ready: false,
    recovery: true,
  }),
  resize: onPage({ mutation: true, charge: "none", refuseHeld: true, ready: false }),
  // reading
  ready: onPage({ mutation: false, charge: "none", refuseHeld: false, ready: false }),
  observe: onPage({
    mutation: false,
    charge: "action",
    refuseHeld: true,
    ready: true,
    refuseWhileWaiting: true,
  }),
  checkpoint: onPage({ mutation: false, charge: "host-read", refuseHeld: true, ready: true }),
  "control-facts": onPage({ mutation: false, charge: "host-read", refuseHeld: true, ready: true }),
  revalidate: onPage({ mutation: false, charge: "none", refuseHeld: true, ready: true }),
  "read-text": onPage({ mutation: false, charge: "action", refuseHeld: true, ready: true }),
  screenshot: onPage({ mutation: false, charge: "action", refuseHeld: true, ready: true }),
  wait: onPage({ mutation: false, charge: "action", refuseHeld: true, ready: true }),
  resolve: onPage({ mutation: false, charge: "host-read", refuseHeld: true, ready: false }),
  // A plan's own reads (preconditions and postconditions) are host reads of its page.
  run: onPage({ mutation: false, charge: "host-read", refuseHeld: true, ready: false }),
  settled: onPage({ mutation: false, charge: "action", refuseHeld: true, ready: false }),
  // input
  navigate: onPage({ mutation: true, charge: "action", refuseHeld: true, ready: false }),
  "navigate-stop": onPage({
    mutation: true,
    charge: "none",
    refuseHeld: false,
    ready: false,
    recovery: true,
  }),
  click: onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  fill: onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  "fill-form": onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  "select-option": onPage({ mutation: true, charge: "action", refuseHeld: true, ready: false }),
  scroll: onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  "click-and-wait": onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  "download-action": onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  "select-files": onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  "file-chooser": onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  "action-result": boundary,
  // native pointer input
  "pointer-move": onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  "pointer-click": onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  hover: onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  wheel: onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  // native key input
  press: onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  type: onPage({ mutation: true, charge: "action", refuseHeld: true, ready: true }),
  // page control acts on a held page, so it never refuses one
  "page-control": boundary,
  "page-state": onPage({ mutation: false, charge: "none", refuseHeld: false, ready: false }),
  "page-suspend": onPage({
    mutation: false,
    charge: "none",
    refuseHeld: false,
    ready: false,
    refuseWhileWaiting: true,
  }),
  "page-resume": onPage({
    mutation: false,
    charge: "none",
    refuseHeld: false,
    ready: false,
    refuseWhileWaiting: true,
  }),
  // capture
  capture,
  "capture-start": capture,
  "capture-stop": capture,
  "capture-consume": capture,
} as const satisfies Record<BrowserOperation, OperationPolicy>;

type Policies = typeof OperationPolicies;

/** Operations confined to one exact page. */
export type PageOperation = {
  readonly [K in BrowserOperation]: Policies[K] extends PagePolicy ? K : never;
}[BrowserOperation];

/** Operations on the page inventory. */
export type RegistryOperation = {
  readonly [K in BrowserOperation]: Policies[K] extends RegistryPolicy ? K : never;
}[BrowserOperation];

/** Operations the session executes through its one page and registry path. */
export type ExecutedOperation = PageOperation | RegistryOperation;

export const policyOf = (operation: ExecutedOperation): PagePolicy | RegistryPolicy =>
  OperationPolicies[operation];
