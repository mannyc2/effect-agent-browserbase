import { type Config, Layer } from "effect";

import { BrowserbaseAgents } from "./Agents.ts";
import { BrowserbaseCertificates } from "./Certificates.ts";
import { BrowserbaseClient, type ClientOptions } from "./Client.ts";
import { BrowserbaseContexts } from "./Contexts.ts";
import { BrowserbaseDownloads } from "./Downloads.ts";
import type { ClientError } from "./Errors.ts";
import { BrowserbaseExtensions } from "./Extensions.ts";
import { BrowserbaseFunctions } from "./Functions.ts";
import { BrowserbasePageFetch } from "./PageFetch.ts";
import { BrowserbaseProjects } from "./Projects.ts";
import { BrowserbaseRecordings } from "./Recordings.ts";
import { BrowserbaseReplays } from "./Replays.ts";
import { BrowserbaseSearch } from "./Search.ts";
import { BrowserbaseSessions } from "./Sessions.ts";
import { BrowserbaseUploads } from "./Uploads.ts";
import { BrowserbaseWebhooks } from "./Webhooks.ts";

/** Every resource service this package owns, on one account's authority. */
export type Services =
  | BrowserbaseAgents
  | BrowserbaseCertificates
  | BrowserbaseClient
  | BrowserbaseContexts
  | BrowserbaseDownloads
  | BrowserbaseExtensions
  | BrowserbaseFunctions
  | BrowserbasePageFetch
  | BrowserbaseProjects
  | BrowserbaseRecordings
  | BrowserbaseReplays
  | BrowserbaseSearch
  | BrowserbaseSessions
  | BrowserbaseUploads
  | BrowserbaseWebhooks;

/**
 * The services that read one Client. Sessions is provided first and kept in the output,
 * because the artifact services read it and a caller composing this Layer should not have
 * to know which ones do.
 */
const services = Layer.mergeAll(
  BrowserbaseAgents.layer,
  BrowserbaseCertificates.layer,
  BrowserbaseContexts.layer,
  BrowserbaseDownloads.layer,
  BrowserbaseExtensions.layer,
  BrowserbaseFunctions.layer,
  BrowserbasePageFetch.layer,
  BrowserbaseProjects.layer,
  BrowserbaseRecordings.layer,
  BrowserbaseReplays.layer,
  BrowserbaseSearch.layer,
  BrowserbaseUploads.layer,
  BrowserbaseWebhooks.layer,
).pipe(Layer.provideMerge(BrowserbaseSessions.layer));

/**
 * One account for every resource operation, so credentials are composed once rather than
 * per service. Building it performs no I/O, allocates nothing and loads no native peer;
 * `BrowserbaseBrowser.layer` is deliberately separate, because a browser fixes budgets and
 * a connection lifetime that an account does not.
 */
export const layer = (options: ClientOptions): Layer.Layer<Services, ClientError> =>
  services.pipe(Layer.provideMerge(BrowserbaseClient.layer(options)));

/** The same bundle, taking account authority from the application's `ConfigProvider`. */
export const layerConfig = (
  options: Omit<ClientOptions, "projectId" | "apiKey"> = {},
): Layer.Layer<Services, ClientError | Config.ConfigError> =>
  services.pipe(Layer.provideMerge(BrowserbaseClient.layerConfig(options)));
