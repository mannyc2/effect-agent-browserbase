/**
 * Key aliases for Playwright and printable US key descriptions for pipelined Chromium typing.
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

/** Parse and validate the whole chord before sending any down events. */
export const parts = (keys: string): ReadonlyArray<string> | undefined => {
  const tokens: Array<string> = [];
  let building = "";

  // Like Playwright, a plus without a preceding token is the literal plus key: Control++.
  for (const character of keys) {
    if (character === "+" && building.trim() !== "") {
      tokens.push(building);
      building = "";
    } else building += character;
  }
  tokens.push(building);
  if (tokens.length > 4) return undefined;
  const out: Array<string> = [];

  for (const token of tokens) {
    const part = token === " " ? "Space" : token.trim();
    const lower = part.toLowerCase();
    const alias = Object.hasOwn(aliases, lower) ? aliases[lower] : undefined;

    if (alias !== undefined) out.push(alias);
    else if (
      named.has(part) ||
      /^F([1-9]|1[0-2])$/.test(part) ||
      /^(Key[A-Z]|Digit[0-9]|Numpad[0-9])$/.test(part) ||
      description(part) !== undefined
    )
      out.push(part);
    else return undefined;
  }

  return out;
};

/** `"ctrl+a"` becomes `"Control+a"`; returns undefined for something that is not a key. */
export const normalize = (keys: string): string | undefined => parts(keys)?.join("+");

interface Description {
  readonly code: string;
  readonly keyCode: number;
  readonly key: string;
  readonly text: string;
}

const punctuation: ReadonlyArray<readonly [string, string, number]> = [
  ["`~", "Backquote", 192],
  ["-_", "Minus", 189],
  ["=+", "Equal", 187],
  ["\\|", "Backslash", 220],
  ["[{", "BracketLeft", 219],
  ["]}", "BracketRight", 221],
  [";:", "Semicolon", 186],
  ["'\"", "Quote", 222],
  [",<", "Comma", 188],
  [".>", "Period", 190],
  ["/?", "Slash", 191],
  [" ", "Space", 32],
];

/**
 * Match Playwright's pinned US layout for literal typing. Uppercase and shifted punctuation
 * carry their literal text without synthesizing Shift. Newlines also use insertText so a text
 * payload cannot submit a form; only an explicit Enter or submit option may do that.
 */
export const description = (character: string): Description | undefined => {
  if (character.length !== 1) return undefined;
  if (/^[A-Za-z]$/.test(character)) {
    const upper = character.toUpperCase();

    return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), key: character, text: character };
  }
  const digit = "0123456789".indexOf(character);
  const number = digit === -1 ? ")!@#$%^&*(".indexOf(character) : digit;

  if (number !== -1)
    return { code: `Digit${number}`, keyCode: 48 + number, key: character, text: character };
  const symbol = punctuation.find(([characters]) => characters.includes(character));

  return symbol === undefined
    ? undefined
    : { code: symbol[1], keyCode: symbol[2], key: character, text: character };
};
