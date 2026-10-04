/**
 * The one error every Browserbase API call fails with. `reason` says what went wrong.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

/** The API key is missing, wrong or not allowed to do this (401 or 403). */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  detail: Schema.String,
}) {
  override get message() {
    return `unauthorized: ${this.detail}`;
  }
}

/** No session, context or other resource has that id (404). */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  detail: Schema.String,
}) {
  override get message() {
    return `not found: ${this.detail}`;
  }
}

/** Too many concurrent sessions or requests for the plan (429). Wait, then try again. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  detail: Schema.String,
}) {
  override get message() {
    return `rate limited: ${this.detail}`;
  }
}

/** Any other answer that is not a success, including a redirect, which is never followed. */
export class Status extends Schema.TaggedError<Status>()("Status", {
  status: Schema.Finite,
  detail: Schema.String,
}) {
  override get message() {
    return `status ${this.status}: ${this.detail}`;
  }
}

/**
 * No answer arrived: the request could not be sent, or the connection failed. A request that
 * creates something may still have created it.
 */
export class Transport extends Schema.TaggedError<Transport>()("Transport", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** The answer did not have the expected shape. */
export class Decode extends Schema.TaggedError<Decode>()("Decode", {
  detail: Schema.String,
}) {
  override get message() {
    return `unexpected response: ${this.detail}`;
  }
}

/** The request was refused before sending, such as an id that is not an id. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

export const Reason = Schema.Union([
  Unauthorized,
  NotFound,
  RateLimited,
  Status,
  Transport,
  Decode,
  InvalidRequest,
]);

export type Reason = typeof Reason.Type;

export class BrowserbaseError extends Schema.TaggedError<BrowserbaseError>()("BrowserbaseError", {
  operation: Schema.String,
  reason: Reason,
}) {
  override get message() {
    return `Browserbase ${this.operation} failed: ${this.reason.message}`;
  }
}

/** True for failures worth retrying after a pause: no answer, a rate limit or a server error. */
export const isTransient = (error: BrowserbaseError): boolean =>
  error.reason._tag === "Transport" ||
  error.reason._tag === "RateLimited" ||
  (error.reason._tag === "Status" && (error.reason.status >= 500 || error.reason.status === 408));
