/**
 * Addresses: reading one the way a person types it, for `Page.goto` and the browser tools alike,
 * and reporting one without the parts that are credentials.
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

// A parameter named for a credential, compared in lowercase without separators: tokens, keys,
// signatures, passwords, sessions, assertions and authorization codes.
const secretName =
  /token|secret|passw|signature|credential|assertion|verifier|apikey|accesskey|privatekey|sess(?:ion)?id|jwt|hmac|authcode|samlresponse|^(?:key|code|sig|auth|authorization|pwd|pass|session|sid|ticket|otp)$/;

const isSecret = (parameter: string) =>
  secretName.test(
    ([...new URLSearchParams(parameter).keys()][0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""),
  );

// The parameters of a query, or of a fragment shaped like one, without the secret ones; the rest
// stay as they were written, in order.
const kept = (query: string) =>
  query
    .split("&")
    .filter((parameter) => !isSecret(parameter))
    .join("&");

/**
 * `url` as the library reports it: without userinfo, or the query parameters that carry
 * credentials, or those of a fragment written as a query, as some sign-ins return tokens; the rest
 * keeps its identity, such as a chart's `?ticker=ETH`. An address without a host, such as `data:`
 * or `about:blank`, is content or a fixed name, and stays as it is.
 */
export const redact = (url: string): string => {
  const parsed = URL.parse(url);

  if (parsed === null || parsed.host === "") return url;
  parsed.username = "";
  parsed.password = "";
  parsed.search = kept(parsed.search.slice(1));
  if (parsed.hash.includes("=")) {
    const fragment = parsed.hash.slice(1);
    const question = fragment.indexOf("?");
    // A route before the parameters, as in `#/inbox?token=…`, stays.
    const start = question >= 0 && question < fragment.indexOf("=") ? question + 1 : 0;

    parsed.hash = fragment.slice(0, start) + kept(fragment.slice(start));
  }

  return parsed.href;
};

/** An address inside text, as a failure's message quotes one. */
export const quoted = /[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi;

/** `text` with each address in it redacted. */
export const redactWithin = (text: string) => text.replace(quoted, (url) => redact(url));
