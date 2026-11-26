# Filming a page

effect-browser can film a page frame by frame: each frame shows the page at its film time, however long the last one took to picture, and each input reaches the page on the frame it belongs to. The parts are modules of their own, so a caller can use any of them alone.

## Where things are

`Layout.measure(page, picks)` reads where picked things are, as data, in one call to the page:

- a box for each pick, in the viewport and in the document, unrounded;
- boxes for the words it asks for, so a caller can find the top of a line of text;
- the viewport, the scroll and the device scale it was read at.

`Layout.rehearse` measures what exists only after an interaction, such as an open menu, and always puts the page back.

## Drawing over a page

`Overlay.make(page)` leases one layer above the page for a scope, and draws a caller's SVG into it. Screenshots and live views show it. The library's readers never read it: `Snapshot.find`, `Layout.measure`, the change record, `ready` and stillness all leave it out.

## The page's own time

A browser opened with `pageTime` installs a clock in each page before its own scripts. `PageTime.hold(page)` holds the page's timers, animation frames, clocks and animations for a scope. Then `advance(by, { scroll, poses, overlay })` moves them on and, in the same call, scrolls the page, poses its elements and draws the overlay. A CSS transition caught partway is the same picture every run.

## Filming, with input on its frame

`Film.frames(page, options)` is a stream of shots. At each film time it asks the caller for the scroll, poses and overlay of that frame, sends the inputs due on it, and takes a screenshot. A click, a key, a drag or a hover lands on its frame, and the page answers on that frame. A link that loads a new document is a passage: the film holds its time while the page loads, reads the new page's layout, and goes on. Each shot carries the host time its picture was taken. What an input changed comes from `Change.read`, each change with the box to frame it by, on the same clock, so the first shot at or after a change is the first that shows it.

The frames are pictures, and encoding them is the caller's. `Frame.paint` sets an attached browser's device pixels per CSS pixel for sharper frames, and hides scrollbars.

## Moving the page's own elements

`Pose.make(page)` moves, turns and scales the page's own elements about a point, as data, through CSS `translate`, `rotate` and `scale`. The page lays out as it did, readers and clicks find a posed element where it is drawn, and the change record does not report a pose. The scope's end takes every pose off. Posing an element to nothing after a clipped screenshot of it lifts it off the page.

## A site that owns its page

`effect-browser/Site` runs the same readers, change record, overlay and poses in a site's own bundle, on its own document. It has no protocol and loads no `effect`, and is about 16 KB gzipped. A site acts through its own app and notes each act, so the changes it brings name it as their cause. It can render a character into a layer of its own that no reader reads. What needs the protocol stays out: trusted input, screenshots, filming and held time.

The package README's [Filming a page](https://github.com/mannyc2/effect-agent-browserbase/blob/main/packages/browser/README.md#filming-a-page) and [A site that owns its page](https://github.com/mannyc2/effect-agent-browserbase/blob/main/packages/browser/README.md#a-site-that-owns-its-page) sections show the code, and `packages/browser/examples/film.ts` films a small site end to end, locally or on Browserbase.
