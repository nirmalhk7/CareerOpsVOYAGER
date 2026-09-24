import { test } from "node:test";
import assert from "node:assert/strict";
import { OPEN_MARK, CLOSE_MARK, parseVoyagerDraftEnvelope } from "../../src/lib/voyager-draft.mjs";

test("Voyager draft envelope accepts one complete JSON field map", () => {
  const result = parseVoyagerDraftEnvelope(`${OPEN_MARK}\n{"candidate":{"name":"Jane"},"cv":{},"cover":{}}\n${CLOSE_MARK}`);
  assert.equal(result.ok, true);
  assert.equal(result.draft.candidate.name, "Jane");
});

test("Voyager draft envelope rejects malformed JSON before any file is written", () => {
  const result = parseVoyagerDraftEnvelope(`${OPEN_MARK}\n{"candidate":\n${CLOSE_MARK}`);
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});
