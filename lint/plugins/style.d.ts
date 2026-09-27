// Adapted from danieljvdm/effect-agent@bcc2bb7 oxlint/plugin-style.d.ts under the MIT License; see
// LICENSE-effect-agent.
declare const styleOxlintPlugin: {
  readonly meta: { readonly name: "dev-kit-style" };
  readonly rules: {
    readonly "padding-line-between-statements": unknown;
  };
};

export default styleOxlintPlugin;
