import assert from "node:assert/strict";
import { test } from "node:test";
import { GRAPHIFY_PIN } from "../src/core/backend-registry.ts";
import { GRAPHIFY_IMAGE_GLOB_EXCLUDES, isGraphifyModalityRejection } from "../scripts/navigation-freshen.mjs";

test("image exclusions cover the pinned Graphify release's detected image formats", () => {
  assert.equal(GRAPHIFY_PIN, "0.9.23", "review Graphify image formats before changing the pin");
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg"]) {
    assert.ok(GRAPHIFY_IMAGE_GLOB_EXCLUDES.includes(`**/*.${ext}`), `missing **/*.${ext}`);
  }
  assert.ok(GRAPHIFY_IMAGE_GLOB_EXCLUDES.every(glob => glob.startsWith("**/*.")), "globs are any-depth file patterns");
});

test("modality classifier matches the exact gateway rejection and ignores generic 400s", () => {
  const exact = `HTTP 400 invalid_request_error
  messages[1]: unknown variant \`image_url\`, expected \`text\``;
  assert.equal(isGraphifyModalityRejection(exact), true, "exact image_url rejection is classified");
  assert.equal(isGraphifyModalityRejection(`400 invalid_request_error messages[1]: unknown variant \`image_url\`, expected \`text\``), true, "single-line variant matches");
  assert.equal(isGraphifyModalityRejection("HTTP 400 invalid_request_error: invalid api key"), false, "generic 400 stays generic");
  assert.equal(isGraphifyModalityRejection(""), false, "empty output is not a modality rejection");
  assert.equal(isGraphifyModalityRejection("rate limit exceeded, retry later"), false, "rate limit stays generic");
});
