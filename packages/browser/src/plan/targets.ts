/** Find a recorded subject and verify where its point still lands before replay input. */
import { Duration, Effect, Schedule } from "effect";

import { InvalidRequest, undispatched } from "../BrowserError.ts";
import { type Box, type Subject } from "../BrowserEvent.ts";
import type { Page, Found, Point, Target } from "../Page.ts";
import { choose, Drifted } from "./choose.ts";

const invalid = (detail: string) => undispatched("replay", new InvalidRequest({ detail }));

/**
 * The one element on the page that a subject names, by role, name and context (see `Plan`),
 * looking again for two seconds while the page may still be drawing it.
 */
export const locate = (page: Page, subject: Subject) =>
  page
    .find({
      name: subject.name,
      scope: "document",
      ...(subject.role === null ? {} : { role: subject.role }),
    })
    .pipe(
      Effect.flatMap((found) => choose(subject, found)),
      Effect.retry({
        schedule: Schedule.spaced(Duration.millis(250)),
        times: 8,
        while: (error) => error._tag !== "BrowserError",
      }),
      Effect.withSpan("Plan.locate", { attributes: { role: subject.role ?? "" } }),
    );

/**
 * Where the step acts: the element its subject names, or, for a step recorded at a point, the same
 * place within that element, as long as a press there reaches that element and not one over it.
 * An element out of view is first brought into it, by hovering it, as a press by ref would be.
 */
export const aim = (page: Page, subject: Subject | undefined, point?: Point, recorded?: Box) => {
  if (subject === undefined) return Effect.fail(invalid("the step names no element"));
  if (point === undefined) return Effect.map(locate(page, subject), ({ ref }): Target => ref);

  const reach = ({ ref, box }: Found) => {
    const at =
      recorded === undefined || recorded.width <= 0 || recorded.height <= 0
        ? point
        : {
            x: box.x + ((point.x - recorded.x) / recorded.width) * box.width,
            y: box.y + ((point.y - recorded.y) / recorded.height) * box.height,
          };

    return Effect.map(page.find({ at }), ([reached]) => (reached?.ref === ref ? at : undefined));
  };

  const missed = new Drifted({ detail: "a press at the subject's point reaches another element" });

  return locate(page, subject).pipe(
    Effect.flatMap((found) =>
      Effect.flatMap(reach(found), (at) =>
        at !== undefined
          ? Effect.succeed<Target>(at)
          : page.hover(found.ref).pipe(
              Effect.andThen(locate(page, subject)),
              Effect.flatMap(reach),
              Effect.flatMap((again) =>
                again === undefined ? Effect.fail(missed) : Effect.succeed<Target>(again),
              ),
            ),
      ),
    ),
  );
};
