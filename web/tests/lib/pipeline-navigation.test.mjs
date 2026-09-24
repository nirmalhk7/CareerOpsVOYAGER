import { test } from "node:test";
import assert from "node:assert/strict";
import { pipelineDetailHref, pipelineReturnHref } from "../../src/lib/pipeline-navigation.mjs";

test("returns to the exact pipeline view that opened a report", () => {
  const detail = pipelineDetailHref("27", "tab=EVALUATED&sort=date&dir=1");

  assert.equal(detail, "/pipeline/27?from=%2Fpipeline%3Ftab%3DEVALUATED%26sort%3Ddate%26dir%3D1");
  assert.equal(pipelineReturnHref("/pipeline?tab=EVALUATED&sort=date&dir=1"), "/pipeline?tab=EVALUATED&sort=date&dir=1");
});

test("falls back to the pipeline root for an unsafe return target", () => {
  assert.equal(pipelineReturnHref("https://example.com"), "/pipeline");
  assert.equal(pipelineReturnHref("/settings"), "/pipeline");
  assert.equal(pipelineReturnHref(null), "/pipeline");
});
