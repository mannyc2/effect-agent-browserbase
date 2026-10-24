// What `motion.ts` uses of playwright-core's bundled JPEG decoder, which its untyped entry exports.
declare module "playwright-core/lib/utilsBundle" {
  export const jpegjs: {
    decode(
      data: Uint8Array,
      options: { useTArray: true },
    ): { readonly width: number; readonly height: number; readonly data: Uint8Array };
  };
}
