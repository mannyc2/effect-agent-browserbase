/**
 * In the page: what the input guard decides on. It inspects an input's targets for the facts a
 * policy weighs, such as a form submission or a secret field, binds an approval to them, and
 * checks before each press that the approved target would still receive it. See `reading/names.inpage.ts` for what a page-side part may use.
 */
import { Schema } from "effect";

import type { Names } from "../reading/names.inpage.ts";
import { type Evidence, type EvidenceReader, EvidenceSchema } from "./evidence.inpage.ts";
import type { Targets } from "./targets.inpage.ts";

export const Fact = Schema.Literals([
  "form-submit",
  "cross-origin",
  "download",
  "upload",
  "secret",
  "scripted",
  "opaque",
]);

export type Fact = typeof Fact.Type;

export interface InputPlan {
  readonly action: string;
  readonly targets: ReadonlyArray<string | { readonly x: number; readonly y: number } | null>;
  readonly submit: boolean;
  readonly keys: string | null;
  readonly destination: string | null;
}

export interface InspectedTarget {
  readonly ref: string;
  readonly element: string;
  readonly role: string | null;
  readonly name: string;
  readonly cursor: string;
  readonly href?: string | undefined;
  /** A field the DOM marks as holding a password, a one-time code or a card's details. */
  readonly secret: boolean;
  readonly fingerprint: string;
}

export interface PreparedInput {
  readonly url: string;
  readonly targets: ReadonlyArray<InspectedTarget | null>;
  readonly facts: ReadonlyArray<Fact>;
  readonly destination?: string | undefined;
  readonly evidence: Evidence;
}

/** A refusal; a stale target is named by its index in the plan. */
export interface InputFailure {
  readonly error: string;
  readonly detail: string;
  readonly index?: number | undefined;
}

export type PreparedInputResult = PreparedInput | InputFailure;

export type ValidatedInputResult = { readonly ok: true } | InputFailure;

/** A point where a target, by its index in the plan, is about to receive a press. */
export interface Press {
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

export interface ValidationOptions {
  /** Require focus on the first target. */
  readonly focused?: boolean;
  /** After the pointer's own events have run, each target must still receive its press. */
  readonly presses?: ReadonlyArray<Press>;
}

export const guard = (names: Names, targets: Targets, evidence: EvidenceReader) => {
  const {
    activeElement,
    clean,
    describe,
    inCurrentDocument,
    interactiveRoles,
    isButton,
    isDisabled,
    isHtml,
    isInput,
    isLabel,
    isRoot,
    isSecret,
    isSelect,
    isTextArea,
    lookup,
    nameOf,
    parentOf,
    refFor,
    roleOf,
  } = names;

  const { controlOf, details, hitAt, hrefAttribute, linkOf, receives, within } = targets;
  const { evidenceOf, isField, isFilled } = evidence;

  /**
   * The element whose activation behaviour a click or key on `element` runs, as the browser
   * resolves it along the composed path: a link, button, input, summary or a label's control.
   */
  const activationTarget = (element: Element): Element | undefined => {
    for (let node: Element | null = element; node !== null; node = parentOf(node)) {
      if (
        hrefAttribute(node) !== null ||
        node.tagName === "BUTTON" ||
        node.tagName === "SUMMARY" ||
        (isInput(node) && node.type !== "hidden")
      )
        return node;
      if (isLabel(node) && node.control !== null) return node.control;
    }

    return undefined;
  };

  /**
   * A control between a press's hit and the approved target that is not the target's own
   * activation, such as a link or button a hover handler nested into it. The approval inspected
   * the target, so that control would act unapproved.
   */
  const nestedControl = (element: Element, hit: Element): Element | undefined => {
    // A container of the target is covered by the target's own facts.
    if (!within(element, hit)) return undefined;
    const own = activationTarget(element);

    for (
      let node: Element | null = hit;
      node !== null && node !== element;
      node = parentOf(node) ?? node.ownerDocument.defaultView?.frameElement ?? null
    )
      if (
        node !== own &&
        (hrefAttribute(node) !== null ||
          node.tagName === "BUTTON" ||
          node.tagName === "SUMMARY" ||
          (isInput(node) && node.type !== "hidden") ||
          isSelect(node) ||
          isTextArea(node) ||
          (isLabel(node) && node.control !== null && node.control !== own) ||
          activatingRoles.has(roleOf(node) ?? ""))
      )
        return node;

    return undefined;
  };

  const textEntry = (element: Element): boolean =>
    (isInput(element) &&
      ![
        "button",
        "reset",
        "submit",
        "image",
        "checkbox",
        "radio",
        "file",
        "range",
        "color",
        "hidden",
      ].includes(element.type)) ||
    isTextArea(element) ||
    (isHtml(element) && element.isContentEditable);

  const activatingRoles = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "treeitem",
  ]);

  // Typed text goes wherever focus is, and a typed space or letter can press a focused button,
  // toggle a box, follow a link or change a select. Only fields, or elements that are none of
  // these (a page or a canvas game), may receive text.
  const typingRefusal = (element: Element, explicit: boolean): string | undefined =>
    textEntry(element)
      ? undefined
      : explicit
        ? `${describe(element)} is not a text field`
        : activationTarget(element) !== undefined ||
            isSelect(element) ||
            activatingRoles.has(roleOf(element) ?? "")
          ? `focus is on ${describe(element)}, which typed text could activate or change; type into a text field by ref, or use press for keys`
          : undefined;

  const isSubmitter = (element: Element): element is HTMLButtonElement | HTMLInputElement =>
    (isButton(element) && element.type === "submit") ||
    (isInput(element) && (element.type === "submit" || element.type === "image"));

  // form.elements omits image submitters. Walk the whole root in tree order so an Enter
  // submission uses the real default button, including controls associated from outside the form.
  const defaultSubmitter = (form: HTMLFormElement) => {
    const root = form.getRootNode();

    return isRoot(root)
      ? Array.from(root.querySelectorAll("button,input")).find(
          (candidate): candidate is HTMLButtonElement | HTMLInputElement =>
            isSubmitter(candidate) && candidate.form === form,
        )
      : undefined;
  };

  const sensitive =
    /password|passwd|secret|credential|token|username|user.?name|login|sign.?in|one.?time|otp|security|auth|email|e-mail|url|website|phone|tel(?:ephone)?|account|card|payment|billing|order|trade|quantity|amount|price|postal|zip|address|iban|routing|cc-/i;

  // Attributes that say what a field is for. They bind an approval and decide prose eligibility.
  const purpose = (control: Element, form: HTMLFormElement | null) => [
    control.getAttribute("id"),
    control.getAttribute("name"),
    control.getAttribute("inputmode"),
    control.getAttribute("autocomplete"),
    control.getAttribute("aria-label"),
    form?.getAttribute("id"),
    form?.getAttribute("name"),
    form?.getAttribute("aria-label"),
  ];

  /** Free prose only: never numbers, addresses, credentials, payment or order fields. */
  const proseEligible = (control: Element): boolean => {
    const form = isTextArea(control) ? control.form : null;
    const submitter = form === null ? undefined : defaultSubmitter(form);
    const inputMode = control.getAttribute("inputmode");

    return (
      (isTextArea(control) || (isHtml(control) && control.isContentEditable)) &&
      !isDisabled(control) &&
      !control.hasAttribute("readonly") &&
      control.getAttribute("aria-readonly") !== "true" &&
      (inputMode === null || inputMode === "" || inputMode === "text") &&
      ![
        ...purpose(control, form),
        nameOf(control, roleOf(control)),
        submitter === undefined ? null : nameOf(submitter, roleOf(submitter)),
      ].some((value) => value !== null && value !== undefined && sensitive.test(value))
    );
  };

  // What an approval binds of a URL. A fragment that names a place on the page, which scroll-spy
  // and feed pages rewrite as they scroll, is left out. A hash route (#/… or #!…) stays: it
  // selects what the page's controls act on.
  const boundUrl = (url: string): string => {
    const hash = url.indexOf("#");

    return hash === -1 || /^#[/!]/.test(url.slice(hash)) ? url : url.slice(0, hash);
  };

  const inspectInput = (element: Element, plan: InputPlan) => {
    const metadata = details(element, element, 0, 0);
    // Facts are about what the input activates, such as the submit button around a painted label.
    const control = activationTarget(element) ?? element;

    const form =
      isInput(control) || isButton(control) || isTextArea(control) || isSelect(control)
        ? control.form
        : null;

    // The chord's last key, which may be the plus key itself: Control++.
    const key = plan.keys === null ? undefined : /(?:^|\+)(\+|[^+]+)$/.exec(plan.keys)?.[1];
    const enter = key === "Enter";

    const activation =
      plan.action === "click" || (plan.action === "press" && (enter || key === "Space"));

    // Enter submits a form from any input but buttons, file and color pickers, including
    // checkboxes, radios and ranges.
    const fieldEnter =
      isInput(control) &&
      !["button", "reset", "submit", "image", "file", "color", "hidden"].includes(control.type) &&
      ((plan.action === "press" && enter) || (plan.action === "type" && plan.submit));

    const submits = form !== null && ((activation && isSubmitter(control)) || fieldEnter);

    const submitter = isSubmitter(control)
      ? control
      : form === null
        ? undefined
        : defaultSubmitter(form);

    const formDestination =
      form === null
        ? undefined
        : submitter?.hasAttribute("formaction") === true
          ? submitter.formAction
          : form.action;

    const formMethod =
      form === null
        ? undefined
        : submitter?.hasAttribute("formmethod") === true
          ? submitter.formMethod
          : form.method;

    const formTarget =
      form === null
        ? undefined
        : submitter?.hasAttribute("formtarget") === true
          ? submitter.formTarget
          : form.target;

    const link = linkOf(element);
    const href = link === undefined ? null : hrefAttribute(link);
    // A dialog form only closes its dialog; the page's script decides what that means.
    const sends = submits && formMethod !== "dialog";
    // Only activation follows a link or opens a file chooser; hovering or scrolling over a
    // control does neither.
    const destination = sends ? formDestination : activation ? metadata.href : undefined;
    const acts = plan.action !== "hover" && plan.action !== "scroll";

    // What the browser itself does on activation: follow a link, submit or reset a form, choose
    // a file or a value, toggle a box or a disclosure, or focus a field. Anything else is the
    // page's script.
    const builtIn =
      sends ||
      (href !== null && !/^\s*(?:#\s*|javascript:[^]*)$/i.test(href)) ||
      (isInput(control) && !["button", "submit", "image", "reset"].includes(control.type)) ||
      ((isInput(control) || isButton(control)) && control.type === "reset" && form !== null) ||
      control.tagName === "SUMMARY" ||
      control.closest("select") !== null ||
      textEntry(control);

    const facts: Array<Fact> = [];

    // Facts come from structure only. What a name or the text around it says is evidence for a
    // judge, never a fact: words change meaning with context and language.
    if (sends) facts.push("form-submit");
    if (activation && link?.hasAttribute("download") === true) facts.push("download");
    if (activation && isInput(control) && control.type === "file") facts.push("upload");
    if (
      (plan.action === "type" && isSecret(control)) ||
      (sends &&
        form !== null &&
        Array.from(form.elements).some(
          (field) => isField(field) && isSecret(field) && isFilled(field),
        ))
    )
      facts.push("secret");
    if (activation && !builtIn) facts.push("scripted");
    if (acts && (metadata.role === "canvas" || metadata.role === "iframe" || metadata.name === ""))
      facts.push("opaque");

    // Bind what decides the consequence and the control's identity. Names bind interactive
    // controls only: other text, such as a live price or a page's own text, may change freely.
    const role = metadata.role;

    const boundName =
      role !== null &&
      (interactiveRoles.has(role) || role === "canvas" || role === "iframe") &&
      !(isHtml(element) && element.isContentEditable)
        ? metadata.name
        : null;

    // Approval and prose eligibility share the same immutable inspection. A focus or scroll
    // handler changing these attributes must not leave an old permission behind.
    const fingerprint = JSON.stringify([
      purpose(control, form),
      proseEligible(control),
      element.tagName,
      element.id,
      role,
      boundName,
      metadata.href,
      control === element ? null : refFor(control),
      isInput(control) || isButton(control) ? control.type : control.tagName,
      control.matches(":disabled") || isDisabled(control),
      control.getAttribute("readonly"),
      control.getAttribute("aria-readonly"),
      isHtml(control) && control.isContentEditable,
      control.getAttribute("name"),
      control.getAttribute("accept"),
      control.hasAttribute("multiple"),
      link?.getAttribute("download"),
      form === null ? null : refFor(form),
      form === null ? null : boundUrl(form.action),
      form?.method,
      form?.target,
      submitter === undefined ? null : refFor(submitter),
      formDestination === undefined ? undefined : boundUrl(formDestination),
      formMethod,
      formTarget,
      submitter?.formNoValidate,
      form?.noValidate,
    ]);

    const inspected: InspectedTarget = {
      ref: refFor(element),
      element: metadata.element,
      role: metadata.role,
      name: metadata.name,
      cursor: metadata.cursor,
      ...(metadata.href === undefined ? {} : { href: metadata.href }),
      secret: isSecret(control),
      fingerprint,
    };

    return {
      inspected,
      facts,
      destination,
      explain: () => evidenceOf(element, form, formMethod, formDestination),
    };
  };

  // Approval preparation only reads the DOM. In particular, an offscreen ref must not scroll
  // before the policy has had a chance to deny it.
  const inspect = (
    plan: InputPlan,
  ): (Omit<PreparedInput, "evidence"> & { readonly explain: () => Evidence }) | InputFailure => {
    const targets: Array<InspectedTarget | null> = [];
    const facts = new Set<Fact>();
    let destination = plan.destination ?? undefined;
    let explain = (): Evidence => ({ title: clean(document.title, 120) });

    for (const [index, target] of plan.targets.entries()) {
      let element: Element | null | undefined;

      if (target === null) {
        element = activeElement();
      } else if (typeof target === "string") {
        element = lookup(target);
        if (element === undefined)
          return { error: "stale", detail: target + " is not on the page any more", index };
      } else {
        if (
          !Number.isFinite(target.x) ||
          !Number.isFinite(target.y) ||
          target.x < 0 ||
          target.y < 0 ||
          target.x >= window.innerWidth ||
          target.y >= window.innerHeight
        )
          return { error: "outside", detail: "the point is outside the viewport" };
        const hit = hitAt(document, target.x, target.y);

        element = hit === null ? null : controlOf(hit);
        if (element === null)
          return { error: "offscreen", detail: "nothing is painted at the point" };
      }

      if (element === null) {
        targets.push(null);
        continue;
      }
      if (!inCurrentDocument(element))
        return { error: "stale", detail: "the input target belongs to a replaced document", index };
      const refusal = plan.action === "type" ? typingRefusal(element, target !== null) : undefined;

      if (refusal !== undefined) return { error: "untypeable", detail: refusal };
      const inspected = inspectInput(element, plan);

      if (index === 0) explain = inspected.explain;
      targets.push(inspected.inspected);
      for (const fact of inspected.facts) facts.add(fact);
      destination ??= inspected.destination;
      if (inspected.destination !== undefined) {
        try {
          if (new URL(inspected.destination, location.href).origin !== location.origin)
            facts.add("cross-origin");
        } catch {
          return { error: "outside", detail: "the input destination is not a valid URL" };
        }
      }
    }

    if (destination !== undefined) {
      try {
        destination = new URL(destination, location.href).href;
        if (new URL(destination).origin !== location.origin) facts.add("cross-origin");
      } catch {
        return { error: "outside", detail: "the input destination is not a valid URL" };
      }
    }

    return {
      url: boundUrl(location.href),
      targets,
      facts: [...facts],
      ...(destination === undefined ? {} : { destination }),
      explain,
    };
  };

  // Evidence is read once, for the policy. Validation binds the facts and the targets, not the
  // text around them, which live pages change freely.
  const prepareInput = (plan: InputPlan): PreparedInputResult => {
    const inspected = inspect(plan);

    if ("error" in inspected) return inspected;
    const { explain, ...prepared } = inspected;

    return { ...prepared, evidence: explain() };
  };

  const validate = (
    plan: InputPlan,
    prepared: PreparedInput,
    options: ValidationOptions,
  ): ValidatedInputResult => {
    const current = inspect(plan);

    if ("error" in current)
      return current.error === "stale" ? current : { error: "changed", detail: current.detail };
    if (
      current.url !== prepared.url ||
      (current.destination === undefined || prepared.destination === undefined
        ? current.destination !== prepared.destination
        : boundUrl(current.destination) !== boundUrl(prepared.destination)) ||
      JSON.stringify(current.facts) !== JSON.stringify(prepared.facts) ||
      current.targets.length !== prepared.targets.length ||
      current.targets.some((target, index) => {
        const previous = prepared.targets[index];

        return target === null
          ? previous !== null
          : previous === null ||
              previous === undefined ||
              target.ref !== previous.ref ||
              target.fingerprint !== previous.fingerprint;
      })
    )
      return {
        error: "changed",
        detail: "the page or input target changed while the policy was deciding",
      };

    if (options.focused === true) {
      const active = activeElement();
      const expected = prepared.targets[0];

      if (
        active === null ||
        expected === null ||
        expected === undefined ||
        refFor(active) !== expected.ref
      )
        return { error: "changed", detail: "focus moved away from the approved element" };
    }

    for (const press of options.presses ?? []) {
      const expected = prepared.targets[press.index];

      const element =
        expected === null || expected === undefined ? undefined : lookup(expected.ref);

      const hit = hitAt(document, press.x, press.y);

      if (element === undefined || hit === null || !receives(element, hit))
        return {
          error: "changed",
          detail: `the approved target is no longer under the pointer at (${press.x}, ${press.y})`,
        };

      const nested = nestedControl(element, hit);

      if (nested !== undefined)
        return {
          error: "changed",
          detail: `${describe(nested)} inside the approved target would receive the press at (${press.x}, ${press.y})`,
        };
    }

    return { ok: true };
  };

  // Chromium delivers pointer moves with the next frame. A press check waits until the frame
  // after it, so it sees what the page did when the pointer arrived, such as a menu opened over
  // the target. A hidden document draws no frames, and its moves wait for the press instead.
  const validateInput = (
    plan: InputPlan,
    prepared: PreparedInput,
    options: ValidationOptions = {},
  ): ValidatedInputResult | Promise<ValidatedInputResult> => {
    if ((options.presses ?? []).length === 0) return validate(plan, prepared, options);
    const { promise, resolve } = Promise.withResolvers<void>();

    if (document.visibilityState === "hidden") resolve();
    else requestAnimationFrame(() => requestAnimationFrame(() => resolve()));

    return promise.then(() => validate(plan, prepared, options));
  };

  return { prepareInput, proseEligible, textEntry, typingRefusal, validateInput };
};

export type Guard = ReturnType<typeof guard>;

const InputPreparationError = Schema.Struct({
  error: Schema.String,
  detail: Schema.String,
  index: Schema.optional(Schema.Finite),
});

export const PreparedInputResultSchema = Schema.Union([
  Schema.Struct({
    url: Schema.String,
    targets: Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          ref: Schema.String,
          element: Schema.String,
          role: Schema.NullOr(Schema.String),
          name: Schema.String,
          cursor: Schema.String,
          href: Schema.optional(Schema.String),
          secret: Schema.Boolean,
          fingerprint: Schema.String,
        }),
      ),
    ),
    facts: Schema.Array(Fact),
    destination: Schema.optional(Schema.String),
    evidence: EvidenceSchema,
  }),
  InputPreparationError,
]);

export const ValidatedInputResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  InputPreparationError,
]);
