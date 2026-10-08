/**
 * Addresses: reading one the way a person types it, for `Page.goto` and the browser tools alike,
 * and reporting one without the values that are credentials, by one rule that the page script runs
 * too, for the outline's links.
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

/**
 * The rule that reports an address without its credentials. The page script runs it too, so it
 * stays self-contained, as `names.inpage.ts` says a page-side part must.
 */
export const addresses = () => {
  // What a credential's value reads as, as a secret field's text does (`Page.redacted`).
  const withheld = "••••••••" as const;

  // A parameter's name, compared in lowercase without separators, says it is a credential: a token,
  // secret, password, signature, assertion, session id or one-time code, or a code or key of a kind
  // that signs someone in or signs a request, such as `verification_code` or `api_key`.
  const credential =
    /token|secret|passw|passcode|passphrase|signature|credential|assertion|verifier|bearer|jwt|hmac|apikey|accesskey|privatekey|sess(?:ion)?id|saml(?:response|art)|(?:sig|otp)$|(?:auth|api|access|private|secret|signing|client|encryption|licen[cs]e|session|master|app|device|verification|verify|confirmation|confirm|activation|activate|reset|recovery|login|security|magic|onetime|mfa|2fa|sms|email|otp|oob)(?:code|key)$|^(?:auth|authorization|pwd|pass)$/;

  // These names as often say what an address is about, such as a stock code, a support ticket or a
  // conference session. Under them a value is a credential when it looks generated, at least 16
  // characters with letters and digits, as tokens, session ids and authorization codes do.
  const ambiguous = /^(?:code|key|session|sid|ticket)$/;

  const secret = (name: string, value: string) => {
    const bare = name.toLowerCase().replace(/[^a-z0-9]/g, "");

    return (
      value !== "" &&
      (credential.test(bare) ||
        (ambiguous.test(bare) && value.length >= 16 && /\d/.test(value) && /[a-z]/i.test(value)))
    );
  };

  // Parameters as written, each credential's value withheld: a query's, a fragment's written as a
  // query, or a path's segments', as a Java session id is.
  const masked = (parameters: string, separator: string) =>
    parameters
      .split(separator)
      .map((parameter) => {
        const [name = "", value = ""] = [...new URLSearchParams(parameter)][0] ?? [];

        return secret(name, value)
          ? `${parameter.slice(0, parameter.indexOf("=") + 1)}${withheld}`
          : parameter;
      })
      .join(separator);

  /**
   * `url` as the library reports it: without userinfo, and with each credential's value withheld,
   * so the rest keeps its identity, such as a chart's `?ticker=ETH`. An address without a host,
   * such as `data:` or `about:blank`, is content or a fixed name, and stays as it is.
   */
  const redact = (url: string): string => {
    const parsed = URL.parse(url);

    if (parsed === null || parsed.host === "") return url;
    parsed.username = "";
    parsed.password = "";
    parsed.pathname = masked(parsed.pathname, ";");
    parsed.search = masked(parsed.search.slice(1), "&");
    if (parsed.hash.includes("=")) {
      const fragment = parsed.hash.slice(1);
      const question = fragment.indexOf("?");
      // A route before the parameters, as in `#/inbox?token=…`, stays.
      const start = question >= 0 && question < fragment.indexOf("=") ? question + 1 : 0;

      parsed.hash = fragment.slice(0, start) + masked(fragment.slice(start), "&");
    }

    return parsed.href.replaceAll(encodeURIComponent(withheld), withheld);
  };

  return { withheld, redact };
};

export const { withheld, redact } = addresses();

/** An address inside text, as a failure's message quotes one. */
export const quoted = /[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi;

/** `text` with each address in it redacted. */
export const redactWithin = (text: string) => text.replace(quoted, (url) => redact(url));
