// What tests read PNG frames with: playwright-core's bundled decoder, which its untyped entry
// exports. This merges with `src/stillness/utilsBundle.d.ts`.
declare module "playwright-core/lib/utilsBundle" {
  export const PNG: {
    readonly sync: {
      read(data: Buffer): {
        readonly width: number;
        readonly height: number;
        readonly data: Uint8Array;
      };
    };
  };
}
