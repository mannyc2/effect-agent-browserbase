/**
 * Reading an address the way a person types one, for `Page.goto` and the browser tools alike.
 */

const scheme = /^[a-z][a-z0-9+.-]*:/i;

// `localhost:3000` and `example.com:8080/a` look like a scheme to the URL parser; a port decides.
const hostAndPort = /^[^\s/?#@:]+:\d+(?:[/?#]|$)/;

const loopback = /^(?:localhost|127(?:\.\d+){3}|\[::1\])(?:[:/?#]|$)/i;

/** The URL `input` names. Without a scheme it is a web address: HTTPS, or HTTP on loopback. */
export const parse = (input: string): URL | null => {
  const text = input.trim();

  if (scheme.test(text) && !hostAndPort.test(text)) return URL.parse(text);

  return URL.parse(`${loopback.test(text) ? "http" : "https"}://${text}`);
};
