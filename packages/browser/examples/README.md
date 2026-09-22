# Chromium compositions

`chromium.ts` exports two complete Effect compositions: launch an owned Chromium and capture a frame, or borrow an existing loopback CDP browser and confirm connection cleanup without terminating its process. The application supplies the URL or redacted endpoint and runs the Effect. Merely importing the example starts nothing.

The [Agent examples](../../agent-browser/examples/chromium.ts) use this same browser through the common maintained Toolkit. The [caller encoding example](../../browserbase/examples/record-video.ts) demonstrates consuming live frames with a caller-installed FFmpeg; encoding is not part of the browser runtime.
