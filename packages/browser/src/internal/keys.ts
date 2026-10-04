/**
 * Key names as people and models write them, mapped to the names Playwright's keyboard takes.
 */

const aliases: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  win: "Meta",
  super: "Meta",
  mod: "ControlOrMeta",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  spacebar: "Space",
  " ": "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
};

const named = new Set(Object.values(aliases));

/** `"ctrl+a"` becomes `"Control+a"`; returns undefined for something that is not a key. */
export const normalize = (keys: string): string | undefined => {
  const parts = keys
    .trim()
    .split(/\s*\+\s*/)
    .filter((part) => part !== "");

  if (parts.length === 0 || parts.length > 4) return undefined;
  const out: Array<string> = [];

  for (const part of parts) {
    const alias = aliases[part.toLowerCase()];

    if (alias !== undefined) out.push(alias);
    else if (named.has(part) || /^F([1-9]|1[0-2])$/.test(part) || [...part].length === 1)
      out.push(part);
    else if (/^(Key[A-Z]|Digit[0-9]|Numpad[0-9])$/.test(part)) out.push(part);
    else return undefined;
  }

  return out.join("+");
};
