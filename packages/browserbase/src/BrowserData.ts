import { Schema } from "effect";

import { Identifier } from "./References.ts";
import { PositiveInt } from "./Transfers.ts";

export class Viewport extends Schema.Class<Viewport>("BrowserbaseViewport")(
  Schema.Struct({
    width: PositiveInt.check(Schema.isLessThanOrEqualTo(4096)),
    height: PositiveInt.check(Schema.isLessThanOrEqualTo(4096)),
  }).check(
    Schema.makeFilter((v) => v.width * v.height <= 8_388_608, {
      title: "at most 8,388,608 viewport pixels",
    }),
  ),
) {}

/** Page/frame IDs are connection-local; targetId is a separate Chromium identity. */

export class Target extends Schema.Class<Target>("BrowserbaseTarget")({
  generation: Schema.Natural,
  pageId: Identifier,
  frameId: Identifier,
}) {}

export class PageInfo extends Schema.Class<PageInfo>("BrowserbasePageInfo")({
  pageId: Identifier,
  targetId: Identifier,
  url: Schema.String.check(Schema.isMaxLength(8192)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  selected: Schema.Boolean,
}) {}

export class FrameInfo extends Schema.Class<FrameInfo>("BrowserbaseFrameInfo")({
  frameId: Identifier,
  parentFrameId: Schema.NullOr(Identifier),
  url: Schema.String.check(Schema.isMaxLength(8192)),
  name: Schema.String.check(Schema.isMaxLength(256)),
}) {}

/** Explicit opt-out: this integration does not claim whole-browser network containment. */
export class BrowserPolicy extends Schema.Class<BrowserPolicy>("BrowserbaseBrowserPolicy")({
  network: Schema.Struct({ _tag: Schema.Literal("Unrestricted") }),
  maxActions: PositiveInt.check(Schema.isLessThanOrEqualTo(1000)),
  maxElapsedMillis: PositiveInt.check(Schema.isLessThanOrEqualTo(21_600_000)),
  maxReturnedBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(8 * 1024 * 1024)),
}) {}

export const TargetUrl = Schema.NonEmptyString.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return (
        ["http:", "https:"].includes(url.protocol) &&
        url.hostname !== "" &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }),
);

export const Selector = Schema.NonEmptyString.check(Schema.isMaxLength(1024));

export class NavigateRequest extends Schema.Class<NavigateRequest>("BrowserbaseNavigateRequest")({
  url: TargetUrl,
}) {}

export class ReadTextRequest extends Schema.Class<ReadTextRequest>("BrowserbaseReadTextRequest")({
  selector: Schema.optionalKey(Selector),
}) {}

export class ClickRequest extends Schema.Class<ClickRequest>("BrowserbaseClickRequest")({
  selector: Selector,
}) {}

export class FillRequest extends Schema.Class<FillRequest>("BrowserbaseFillRequest")({
  selector: Selector,
  value: Schema.String.check(Schema.isMaxLength(65536)),
}) {}

export class ScrollRequest extends Schema.Class<ScrollRequest>("BrowserbaseScrollRequest")({
  deltaX: Schema.Int.check(Schema.isBetween({ minimum: -100000, maximum: 100000 })),
  deltaY: Schema.Int.check(Schema.isBetween({ minimum: -100000, maximum: 100000 })),
}) {}

export class ScreenshotRequest extends Schema.Class<ScreenshotRequest>(
  "BrowserbaseScreenshotRequest",
)({ fullPage: Schema.Boolean }) {}

export class NavigationResult extends Schema.Class<NavigationResult>("BrowserbaseNavigationResult")(
  { url: TargetUrl },
) {}

export class ActionResult extends Schema.Class<ActionResult>("BrowserbaseActionResult")({
  url: TargetUrl,
}) {}

export class TextResult extends Schema.Class<TextResult>("BrowserbaseTextResult")({
  text: Schema.String.check(Schema.isMaxLength(8 * 1024 * 1024)),
}) {}

export class ScreenshotResult extends Schema.Class<ScreenshotResult>("BrowserbaseScreenshotResult")(
  {
    mediaType: Schema.Literal("image/png"),
    bytes: Schema.Uint8Array,
  },
) {}

export const AutomationOptions = Schema.Struct({
  actionTimeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 })),
  ),
  maxPages: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 }))),
  initialPage: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ targetId: Identifier }),
      Schema.Struct({ newPage: Schema.Literal(true) }),
    ]),
  ),
  popupPolicy: Schema.optionalKey(Schema.Literals(["retain", "close", "pause"])),
  dialogPolicy: Schema.optionalKey(Schema.Literals(["dismiss", "pause"])),
  pageControl: Schema.optionalKey(Schema.Boolean),
});

export type AutomationOptions = typeof AutomationOptions.Type;
