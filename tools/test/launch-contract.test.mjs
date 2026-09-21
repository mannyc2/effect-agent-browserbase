import assert from "node:assert/strict";
import { test } from "node:test";
import { blockBody, checkLaunchContract, checkOpenApiContract, declaredFields, specBlock, specKeys, stripComments } from "../verify-launch-contract.mjs";

// Synthetic sources of the same shape, not a copy of the upstream resource: these cover
// the parsing rules offline, while the network check confirms the committed transcription.
const upstream = `
export interface SessionCreateParams {
  /**
   * Documentation with a stray brace { and a link https://example.test/a//b
   */
  browserSettings?: SessionCreateParams.BrowserSettings;

  keepAlive?: boolean;

  proxies?:
    | boolean
    | Array<SessionCreateParams.Rule>;

  api_timeout?: number;

  userMetadata?: { [key: string]: unknown };
}

export namespace SessionCreateParams {
  export interface BrowserSettings {
    advancedStealth?: boolean;

    blockAds?: boolean;

    context?: BrowserSettings.Context;

    viewport?: {
      width?: number;
      height?: number;
    };
  }

  export namespace BrowserSettings {
    export interface Context {
      id: string;
      persist?: boolean;
    }
  }
}
`;

const contract = () => ({
  contractSource: { repository: "example/sdk", revision: "a".repeat(40), version: "1.0.0", resource: "src/sessions.ts", sha256: "digest" },
  sessionCreateFields: ["browserSettings", "keepAlive", "proxies", "timeout", "userMetadata"],
  browserSettingsFields: ["blockAds", "context", "viewport"],
  deliberatelyExcluded: ["browserSettings.advancedStealth"],
  sessionCreateRenames: { api_timeout: "timeout" },
});

test("comments are removed without consuming a protocol separator", () => {
  const stripped = stripComments("const a = 1; // note\nconst b = 'https://example.test/x';\n/** { */\nconst c = 2;\n");
  assert.equal(stripped.includes("note"), false);
  assert.equal(stripped.includes("https://example.test/x"), true);
  assert.equal(stripped.includes("{"), false);
});

test("declarations are delimited by brace depth rather than indentation", () => {
  const body = blockBody(stripComments(upstream), "export namespace SessionCreateParams {");
  assert.equal(body.includes("export interface BrowserSettings {"), true);
  assert.equal(body.includes("export interface SessionCreateParams {"), false);
  assert.throws(() => blockBody(upstream, "export interface Missing {"), /no longer declares/);
});

test("only directly declared members are collected", () => {
  const create = declaredFields(blockBody(stripComments(upstream), "export interface SessionCreateParams {"));
  assert.deepEqual(create, ["browserSettings", "keepAlive", "proxies", "api_timeout", "userMetadata"]);
  const settings = declaredFields(blockBody(blockBody(stripComments(upstream), "export namespace SessionCreateParams {"), "export interface BrowserSettings {"));
  // `width` and `height` belong to the nested viewport type, and `id` to a sibling namespace.
  assert.deepEqual(settings, ["advancedStealth", "blockAds", "context", "viewport"]);
});

test("a faithful transcription of the pinned bytes is accepted", () => {
  const checked = checkLaunchContract(upstream, "digest", contract());
  assert.deepEqual(checked.excluded, ["advancedStealth"]);
  assert.deepEqual(checked.create, ["browserSettings", "keepAlive", "proxies", "timeout", "userMetadata"]);
});

test("a revision that no longer serves the reviewed bytes is refused", () => {
  assert.throws(() => checkLaunchContract(upstream, "other", contract()), /recorded digest/);
});

test("an added, dropped or wrongly excluded field is drift, not an incidental edit", () => {
  const dropped = contract();
  dropped.sessionCreateFields = dropped.sessionCreateFields.filter((field) => field !== "keepAlive");
  assert.throws(() => checkLaunchContract(upstream, "digest", dropped), /Session create fields drifted/);

  const added = contract();
  added.browserSettingsFields = [...added.browserSettingsFields, "solveCaptchas"];
  assert.throws(() => checkLaunchContract(upstream, "digest", added), /Browser settings fields drifted/);

  // Excluding a field upstream does not declare would quietly hide a future rename.
  const phantom = contract();
  phantom.deliberatelyExcluded = ["browserSettings.extensionId"];
  assert.throws(() => checkLaunchContract(upstream, "digest", phantom), /Browser settings fields drifted/);
});

test("an unapplied rename is drift rather than a near-matching name", () => {
  const unrenamed = contract();
  unrenamed.sessionCreateRenames = {};
  assert.throws(() => checkLaunchContract(upstream, "digest", unrenamed), /Session create fields drifted/);
});

const specification = `openapi: 3.0.0
paths:
  /v1/sessions:
    get:
      operationId: Sessions_list
    post:
      operationId: Sessions_create
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                timeout:
                  type: integer

                keepAlive:
                  type: boolean
                proxies:
                  type: boolean
                userMetadata:
                  type: object
                browserSettings:
                  type: object
                  properties:
                    advancedStealth:
                      type: boolean
                    blockAds:
                      type: boolean
                    context:
                      type: object
                      properties:
                        id:
                          type: string
                    viewport:
                      type: object
  /v1/contexts:
    post:
      operationId: Contexts_create
`;

const properties = ["paths", "/v1/sessions", "post", "requestBody", "content", "application/json", "schema", "properties"];

test("a specification subtree is read by indentation and stops at its sibling", () => {
  const block = specBlock(specification.split("\n"), properties);
  // `id` belongs to the nested context object, and the sibling path is not part of the block.
  assert.deepEqual(specKeys(block), ["timeout", "keepAlive", "proxies", "userMetadata", "browserSettings"]);
  assert.equal(block.some((line) => line.includes("Contexts_create")), false);
  assert.throws(() => specBlock(specification.split("\n"), ["paths", "/v1/missing"]), /no longer declares/);
});

test("the published specification is checked as the wire contract", () => {
  const checked = checkOpenApiContract(specification, contract());
  assert.deepEqual([...checked.settings].sort(), ["advancedStealth", "blockAds", "context", "viewport"]);
  // The specification states the request field directly, so no rename is applied to it.
  assert.equal(checked.create.includes("timeout"), true);
});

test("a field the provider adds to the specification is drift, not a silent gap", () => {
  const added = specification.replace("                keepAlive:\n", "                keepAlive:\n                  type: boolean\n                region:\n");
  assert.throws(() => checkOpenApiContract(added, contract()), /Session create fields drifted from the published specification/);

  const settings = specification.replace("                    blockAds:\n", "                    blockAds:\n                      type: boolean\n                    solveCaptchas:\n");
  assert.throws(() => checkOpenApiContract(settings, contract()), /Browser settings fields drifted from the published specification/);
});

test("the committed contract carries a checkable citation", async () => {
  const contractModule = await import("../../packages/browserbase/src/internal/provider/Contract.ts");
  assert.match(contractModule.contractSource.sha256, /^[0-9a-f]{64}$/);
  assert.match(contractModule.contractSource.revision, /^[0-9a-f]{40}$/);
  assert.match(contractModule.contractSource.spec, /^https:\/\/.*openapi.*\.yaml$/);
  assert.equal(contractModule.sessionCreateRenames.api_timeout, "timeout");
  assert.equal(contractModule.sessionCreateFields.includes("timeout"), true);
  assert.equal(contractModule.sessionCreateFields.includes("api_timeout"), false);
  for (const excluded of contractModule.deliberatelyExcluded) assert.match(excluded, /^browserSettings\./);
});
