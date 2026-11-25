/**
 * In the page: element poses. A pose moves, turns and scales one of the page's own elements about
 * a point in the viewport, through the CSS `translate`, `rotate` and `scale` properties, which
 * apply around the element's `transform`, so the page's own transform still holds beneath. Each is
 * a Web Animation with no end and one value: it sets no attribute and starts none of the page's
 * transitions, the page clock's holding leaves its value as it is, and `ready` waits only for
 * animations that end. Taking poses off cancels them. See `names.inpage.ts` for what a page-side
 * part may use.
 */
import type { Names } from "../reading/names.inpage.ts";

export interface PoseRequest {
  readonly ref: string;
  readonly dx: number;
  readonly dy: number;
  readonly sx: number;
  readonly sy: number;
  /** Degrees, clockwise. */
  readonly rotate: number;
  /** In the viewport, or null for the middle of where the page draws it. */
  readonly origin: { readonly x: number; readonly y: number } | null;
}

type Prepared =
  | { readonly stale: string }
  | { readonly invalid: string }
  | { readonly apply: () => void };

interface Applied {
  readonly x: number;
  readonly y: number;
  readonly rotate: number;
  readonly sx: number;
  readonly sy: number;
}

export const pose = (names: Names) => {
  const posed = new Map<
    HTMLElement,
    { animation: Animation; effect: KeyframeEffect; applied: Applied }
  >();

  // Elements of a same-origin frame come from another realm, so a property decides, not instanceof.
  const isHtml = (element: Element): element is HTMLElement => "offsetWidth" in element;

  // Where the element's border box is laid out in the viewport, and its transform origin there,
  // from where it is drawn: its corners, about the origin, through the page's transform and then
  // the pose last set. Exact unless an ancestor is transformed.
  const laidOut = (element: HTMLElement, applied: Applied | undefined) => {
    const style = getComputedStyle(element);
    const [cx = 0, cy = 0] = style.transformOrigin.split(" ").map(Number.parseFloat);
    const own = style.transform === "none" ? new DOMMatrix() : new DOMMatrix(style.transform);

    const whole =
      applied === undefined
        ? own
        : new DOMMatrix()
            .translate(applied.x, applied.y)
            .rotate(applied.rotate)
            .scale(applied.sx, applied.sy)
            .multiply(own);

    const drawn = element.getBoundingClientRect();
    const plain = whole.isIdentity;
    const width = plain ? drawn.width : element.offsetWidth;
    const height = plain ? drawn.height : element.offsetHeight;
    let left = Infinity;
    let top = Infinity;

    for (const [x, y] of [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ] as const) {
      const corner = whole.transformPoint({ x: x - cx, y: y - cy });

      left = Math.min(left, corner.x + cx);
      top = Math.min(top, corner.y + cy);
    }
    const origin = { x: drawn.x - left + cx, y: drawn.y - top + cy };
    // The middle of the box as the page's own transform draws it.
    const middle = own.transformPoint({ x: width / 2 - cx, y: height / 2 - cy });

    return { origin, middle: { x: origin.x + middle.x, y: origin.y + middle.y } };
  };

  const apply = (element: HTMLElement, request: PoseRequest) => {
    const known = posed.get(element);
    const { origin, middle } = laidOut(element, known?.applied);
    const about = request.origin ?? middle;
    const away = { x: about.x - origin.x, y: about.y - origin.y };

    const turned = new DOMMatrix()
      .rotate(request.rotate)
      .scale(request.sx, request.sy)
      .transformPoint(away);

    // Turning and scaling about the element's own origin, then moving it by the difference, turns
    // and scales it about `about`.
    const applied = {
      x: request.dx + away.x - turned.x,
      y: request.dy + away.y - turned.y,
      rotate: request.rotate,
      sx: request.sx,
      sy: request.sy,
    };

    const frame = {
      translate: `${applied.x}px ${applied.y}px`,
      rotate: `${applied.rotate}deg`,
      scale: `${applied.sx} ${applied.sy}`,
    };

    if (known === undefined) {
      const effect = new KeyframeEffect(element, [frame, frame], {
        duration: Infinity,
        fill: "both",
      });

      const animation = new Animation(effect, document.timeline);

      animation.play();
      posed.set(element, { animation, effect, applied });
    } else {
      known.effect.setKeyframes([frame, frame]);
      known.applied = applied;
    }
  };

  const takeOff = (element: HTMLElement) => {
    posed.get(element)?.animation.cancel();
    posed.delete(element);
  };

  /**
   * The elements `requests` name, or the first that names none in the current document, or one
   * that is not an HTML element; then, to apply them, a function that poses them and takes poses
   * off every other element.
   */
  const prepare = (requests: ReadonlyArray<PoseRequest>): Prepared => {
    const elements: Array<HTMLElement> = [];

    for (const request of requests) {
      const element = names.lookup(request.ref);

      if (element === undefined) return { stale: request.ref };
      if (!isHtml(element)) return { invalid: `${request.ref} is not an HTML element` };
      elements.push(element);
    }

    return {
      apply: () => {
        for (const element of Array.from(posed.keys()))
          if (!elements.includes(element)) takeOff(element);
        requests.forEach((request, index) => {
          const element = elements[index];

          if (element !== undefined) apply(element, request);
        });
      },
    };
  };

  const set = (requests: ReadonlyArray<PoseRequest>) => {
    const prepared = prepare(requests);

    if ("apply" in prepared) {
      prepared.apply();

      return {};
    }

    return prepared;
  };

  const clear = () => {
    for (const element of Array.from(posed.keys())) takeOff(element);
  };

  return { prepare, set, clear };
};

export type Posing = ReturnType<typeof pose>;
