/**
 * In the page: the library's overlay, a layer over the page that it draws a caller's SVG into,
 * knowing nothing of what it shows. The layer is a closed shadow root on a host fixed over the
 * viewport, above the page's own layers, that takes no pointer events, so input passes through to
 * the page, and undoes the zoom the page sets on its root. Its styles are set through the CSSOM,
 * which a strict `style-src` allows, and with priority, so the page's styles cannot reach it. The
 * host is the library's own (see `names.inpage.ts`), so no reader reads it; the page's scripts can
 * find the host, never what it holds. A site that owns its page can `mount` a layer of its own,
 * whose root it renders into and whose parts may take the pointer. See `names.inpage.ts` for what a
 * page-side part may use.
 */
import type { Names } from "../reading/names.inpage.ts";

export const overlay = (names: Names) => {
  const svgNamespace = "http://www.w3.org/2000/svg";
  let host: HTMLElement | undefined;
  let root: ShadowRoot | undefined;

  const mount = (): ShadowRoot => {
    if (host === undefined || root === undefined) {
      host = document.createElement("div");
      root = host.attachShadow({ mode: "closed" });
      names.adopt(host);
      const sheet = new CSSStyleSheet();

      sheet.replaceSync(
        "svg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible }",
      );
      root.adoptedStyleSheets = [sheet];
    }
    const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;

    for (const [name, value] of Object.entries({
      all: "initial",
      display: "block",
      position: "fixed",
      left: "0",
      top: "0",
      width: "100vw",
      height: "100vh",
      "pointer-events": "none",
      "z-index": "2147483647",
      contain: "strict",
      zoom: String(1 / zoom),
    }))
      host.style.setProperty(name, value, "important");
    if (host.parentNode !== document.documentElement) document.documentElement.append(host);

    return root;
  };

  // The drawing's top-level parts, by their boxes in viewport CSS pixels; at most 32.
  const boxes = (drawing: Element) =>
    Array.from(drawing.children)
      .slice(0, 32)
      .map((part) => {
        const { x, y, width, height } = part.getBoundingClientRect();

        return { x, y, width, height };
      })
      .filter((box) => box.width > 0 && box.height > 0);

  /**
   * Draw an SVG document over the viewport, in place of what was drawn, or take the layer away
   * with null. Says where the drawing's parts are. Its scripts and handlers are dropped.
   */
  const draw = (markup: string | null) => {
    if (markup === null) {
      host?.remove();

      return [];
    }
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
    const drawing = parsed.documentElement;

    if (
      parsed.getElementsByTagName("parsererror").length > 0 ||
      drawing.namespaceURI !== svgNamespace ||
      drawing.localName !== "svg"
    )
      throw new Error("the overlay's markup is not an SVG document");
    for (const script of Array.from(drawing.getElementsByTagName("script"))) script.remove();
    for (const element of [drawing, ...Array.from(drawing.querySelectorAll("*"))])
      for (const attribute of Array.from(element.attributes))
        if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
    const shown = document.importNode(drawing, true);

    mount().replaceChildren(shown);

    return boxes(shown);
  };

  return { draw, mount };
};

export type Overlay = ReturnType<typeof overlay>;
