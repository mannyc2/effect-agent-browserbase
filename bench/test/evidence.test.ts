// What each multi-frame task's pictures must cover, on synthetic frames with known paint times.
import { assert, describe, it } from "@effect/vitest";
import { BrowserPaint, Frame } from "effect-browser/Frame";

import { gapsWithin, precedesAnyJump, precedesJump } from "../Tasks.ts";

/** A native frame painted `millis` after an arbitrary epoch, mapped to the same host time. */
const painted = (millis: number) =>
  new Frame({
    page: "page-1",
    data: new Uint8Array(),
    timing: new BrowserPaint({
      timestamp: 1_700_000_000_000 + millis,
      hostTime: millis,
      uncertaintyMillis: 1,
    }),
    receivedAt: millis + 5,
    width: 1280,
    height: 720,
    document: 1,
    url: "http://bench.test/",
  });

const jump = 1_700_000_000_000 + 2500;

describe("evidence coverage", () => {
  it("requires a frame before the spike and none at or after it for the control", () => {
    const spanning = [painted(0), painted(1500), painted(3000)];
    const afterwards = [painted(2600), painted(3200), painted(4000)];
    const before = [painted(0), painted(1000), painted(2000)];

    assert.isUndefined(precedesJump(spanning, jump));
    assert.include(precedesJump(afterwards, jump) ?? "", "precedes the jump");
    assert.include(precedesJump(spanning, null) ?? "", "precedes the jump");
    assert.isUndefined(precedesAnyJump(before, jump));
    assert.isUndefined(precedesAnyJump(spanning, null));
    assert.include(precedesAnyJump(spanning, jump) ?? "", "include the jump");
  });

  it("rejects a gap wide enough to hide a whole cascade", () => {
    const steady = Array.from({ length: 12 }, (_, index) => painted(index * 800));
    const gapped = [...steady.slice(0, 5), ...steady.slice(8)];

    assert.isUndefined(gapsWithin(steady, 1800));
    assert.include(gapsWithin(gapped, 1800) ?? "", "3200ms gap");
  });
});
