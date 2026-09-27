// Adapted from danieljvdm/effect-agent@bcc2bb7 oxlint/plugin-style.js under the MIT License; see
// LICENSE-effect-agent.
import stylisticPlugin from "@stylistic/eslint-plugin";

export default {
  meta: { name: "dev-kit-style" },
  rules: {
    "padding-line-between-statements": stylisticPlugin.rules["padding-line-between-statements"],
  },
};
