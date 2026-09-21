import type { Frame } from "playwright-core";

import type {
  CaptureBinding,
  CaptureInvalidation,
  CaptureSource,
  CaptureTarget,
  NativeFrame,
} from "./Driver.ts";
import { failure, sanitize } from "./NativeCalls.ts";
import type { Entry, Targets } from "./Targets.ts";

interface CaptureWatcher {
  readonly frameId: string;
  readonly invalidate: (reason: CaptureInvalidation) => void;
  readonly document?: () => void;
}

/**
 * Screencast sources bound to one page and frame, and the watchers that learn when that binding
 * stops describing what the page shows. A main-frame change invalidates every watcher on the page.
 */
export const makeCaptureSources = (targets: Targets) => {
  const { current, entries, frameId } = targets;
  const captureWatchers = new Map<string, Set<CaptureWatcher>>();

  const invalidate = (entry: Entry, reason: CaptureInvalidation, frame?: Frame): void => {
    const watchers = captureWatchers.get(entry.id);

    if (watchers === undefined) return;
    const changedFrameId = frame === undefined ? undefined : frameId(frame);
    const mainFrameId = frameId(entry.page.mainFrame());

    for (const watcher of [...watchers]) {
      if (
        frame !== undefined &&
        changedFrameId !== mainFrameId &&
        changedFrameId !== watcher.frameId
      )
        continue;
      // The page's screencast keeps running across a main-frame navigation. An interval that
      // follows its page is told a new document began; one bound to a document ends, as before.
      if (
        watcher.document !== undefined &&
        reason === "target-changed" &&
        changedFrameId === mainFrameId &&
        watcher.frameId === mainFrameId
      )
        watcher.document();
      else watcher.invalidate(reason);
    }
  };

  const forget = (entry: Entry) => {
    captureWatchers.delete(entry.id);
  };

  const clear = () => {
    captureWatchers.clear();
  };

  const capture = (target?: CaptureTarget): Promise<CaptureBinding> =>
    sanitize(async () => {
      let entry: Entry;
      let captureFrame: Frame;

      if (target === undefined) {
        const selectedTarget = current();

        entry = selectedTarget.entry;
        captureFrame = selectedTarget.frame;
      } else {
        const requested = entries.get(target.pageId);

        if (requested === undefined || requested.page.isClosed())
          throw failure("not-found", "undispatched");
        if ((await targets.targetId(requested)) !== target.targetId)
          throw failure("stale", "undispatched");
        entry = requested;
        captureFrame = entry.page.mainFrame();
      }
      const page = entry.page;
      const targetId = await targets.targetId(entry);
      const watchedFrameId = frameId(captureFrame);

      // The maintained API is required; older Playwright versions fail explicitly, never silently emulate it.
      if (page.screencast === undefined) throw failure("unsupported");
      let watcherSet: Set<CaptureWatcher> | undefined;
      let watcher: CaptureWatcher | undefined;

      const source: CaptureSource = {
        start: ({ receive, quality, size, invalidate, document }) =>
          sanitize(async () => {
            watcherSet = captureWatchers.get(entry.id) ?? new Set<CaptureWatcher>();
            captureWatchers.set(entry.id, watcherSet);
            watcher = {
              frameId: watchedFrameId,
              invalidate,
              ...(document === undefined ? {} : { document }),
            };
            watcherSet.add(watcher);
            try {
              await page.screencast.start({
                quality,
                ...(size === undefined ? {} : { size }),
                onFrame: (frame: NativeFrame) => {
                  receive(frame);
                },
              });
            } catch (error) {
              watcherSet.delete(watcher);
              watcher = undefined;
              if (watcherSet.size === 0) captureWatchers.delete(entry.id);
              throw error;
            }
          }),
        stop: () =>
          sanitize(async () => {
            if (watcher !== undefined && watcherSet !== undefined) {
              watcherSet.delete(watcher);
              watcher = undefined;
              if (watcherSet.size === 0) captureWatchers.delete(entry.id);
            }
            // A closed target cannot produce more frames; its page channel rejects stop.
            if (page.isClosed()) return;
            try {
              await page.screencast.stop();
            } catch (error) {
              // Closure can race the stop request. A live target still requires quarantine.
              if (!page.isClosed()) throw error;
            }
          }),
      };

      return { pageId: entry.id, targetId, frameId: watchedFrameId, source };
    });

  return { invalidate, forget, clear, capture };
};
