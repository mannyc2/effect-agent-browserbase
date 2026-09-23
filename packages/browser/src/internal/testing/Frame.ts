// This module imports nothing. The public testing entry re-exports it, and a declaration
// bundled from the engine would carry the engine's native type graph into a consumer that
// installs no Playwright.

/** A valid 64×48 baseline JPEG, the bytes a scripted capture frame carries by default. */
export const jpegFrame = (): Uint8Array =>
  Uint8Array.from(
    atob(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyVLf2qdLf2q6lv7VOlv7UoyMadcpJb+1Tpb+1XUt/ap0t/atoyPSp1yklv7VYS39qupb+1Tpb+1bxkejTrlJLf2qdLf2q6lv7VOlv7VtGR6NOuYKW/tU6W/tV1Lf2qwlv7V4kZH5fTrlFLf2qwlv7VdS39qnS39q2jI9GnXKSW/tU6W/tV1Lf2qdLf2raMj0adcpJb+1Tpb+1Xkt/ap0t/at4yPRp1zBS39qnS39qupb+1Tpb+1eHGR+X065SS39qnS39qupb+1Tpb+1bxkejTrlJLf2qwlv7VdS39qnS39q2jI9GnXKSW/tU6W/tV1Lf2qdLf2raMj0adc//2Q==",
    ),
    (character) => character.charCodeAt(0),
  );
