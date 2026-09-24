// Tests for resolvePdfPaths()/slugify() using Node's built-in test runner.
// Imports directly from pdf-paths.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/pdf-paths.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { slugify, resolvePdfPaths } from "../../src/lib/pdf-paths.mjs";

test("slugify: lowercases and hyphenates", () => {
  assert.equal(slugify("Jane Q. Smith"), "jane-q-smith");
});

test("slugify: trims leading/trailing hyphens", () => {
  assert.equal(slugify("  -Weird Name!- "), "weird-name");
});

// Given a career-ops root with a report on disk and a profile.yml naming the candidate
function makeRoot({ profileYaml } = {}) {
  const root = mkdtempSync(join(tmpdir(), "co-pdfpaths-"));
  mkdirSync(join(root, "config"), { recursive: true });
  if (profileYaml !== null) {
    writeFileSync(join(root, "config", "profile.yml"), profileYaml ?? 'candidate:\n  full_name: "Jane Smith"\n');
  }
  return root;
}

test("resolvePdfPaths: assigns the web PDF run a paired Voyager bundle", () => {
  // Given a root with a resolvable report and a named candidate
  const root = makeRoot();
  const report = join(root, "reports", "018-acme-2026-07-01.md");
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(report, "**Role:** Platform Engineer\n");
  const findReportFile = (input) => (input === "018" ? report : null);
  try {
    // When resolving paths for report #018
    const result = resolvePdfPaths("018", "2026-07-26", root, findReportFile);

    // Then it reserves resume, cover-letter, class, and manifest paths together.
    assert.equal(result.ok, true);
    assert.equal(result.paths.draft, join(root, "output", "018-acme-platform-engineer", "documents", "draft.web.json"));
    assert.equal(result.paths.cvTex, join(root, "output", "018-acme-platform-engineer", "cv", "tailored", "v001", "cv.tex"));
    assert.equal(result.paths.coverTex, join(root, "output", "018-acme-platform-engineer", "cover", "tailored", "v001", "cover.tex"));
    assert.equal(result.paths.finalPdf, join(root, "output", "018-acme-platform-engineer", "cv", "tailored", "v001", "cv.pdf"));
    assert.equal(result.paths.coverPdf, join(root, "output", "018-acme-platform-engineer", "cover", "tailored", "v001", "cover.pdf"));
    assert.equal(result.paths.style, join(root, "output", "018-acme-platform-engineer", "documents", "style.cls"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: path-traversal selector is rejected before any path is built", () => {
  // Given a findReportFile that would (via parseInt-based matching) resolve a
  // traversal-shaped selector to a real report, and a directory sentinel to
  // prove no scratch dir gets created for this input
  const root = makeRoot();
  const scratchDir = join(root, ".career-ops-web", "pdf-tmp");
  const findReportFile = () => join(root, "reports", "123-acme-2026-07-01.md");
  try {
    // When resolving paths for a crafted, non-canonical selector
    const result = resolvePdfPaths("123/../../etc/passwd", "2026-07-26", root, findReportFile);

    // Then it fails closed with a clear error, never calling findReportFile or touching disk
    assert.equal(result.ok, false);
    assert.match(result.error, /Invalid report selector/);
    assert.equal(existsSync(scratchDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: no matching report -> ok:false, no directories created", () => {
  // Given a root where findReportFile never resolves
  const root = makeRoot();
  const findReportFile = () => null;
  try {
    // When resolving paths for a report that doesn't exist
    const result = resolvePdfPaths("999", "2026-07-26", root, findReportFile);

    // Then it fails with a user-facing error and never touches the filesystem
    assert.equal(result.ok, false);
    assert.match(result.error, /No report #999 found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: does not depend on profile.yml for Voyager bundle paths", () => {
  // Given a root with a resolvable report but no profile.yml at all
  const root = makeRoot({ profileYaml: null });
  const findReportFile = (input) => (input === "5" ? join(root, "reports", "5-globex-2026-07-01.md") : null);
  try {
    // When resolving paths for report #5
    const result = resolvePdfPaths("5", "2026-07-26", root, findReportFile);

    // Then it still succeeds with the role fallback.
    assert.equal(result.ok, true);
    assert.equal(result.paths.finalPdf, join(root, "output", "005-globex-role", "cv", "tailored", "v001", "cv.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: ignores malformed profile.yml when resolving a Voyager bundle", () => {
  // Given a root with a resolvable report and an unparseable profile.yml
  const root = makeRoot({ profileYaml: "candidate: [unterminated" });
  const findReportFile = (input) => (input === "5" ? join(root, "reports", "5-globex-2026-07-01.md") : null);
  try {
    // When resolving paths for report #5
    const result = resolvePdfPaths("5", "2026-07-26", root, findReportFile);

    // Then it still succeeds, because profile data does not choose the path.
    assert.equal(result.ok, true);
    assert.equal(result.paths.finalPdf, join(root, "output", "005-globex-role", "cv", "tailored", "v001", "cv.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: report filename that doesn't match the expected pattern falls back to the default company slug", () => {
  // Given findReportFile resolves to a filename that doesn't match ^\d+-(.+)-YYYY-MM-DD.md$
  const root = makeRoot();
  const findReportFile = (input) => (input === "7" ? join(root, "reports", "not-the-expected-shape.md") : null);
  try {
    // When resolving paths for report #7
    const result = resolvePdfPaths("7", "2026-07-26", root, findReportFile);

    // Then it still succeeds, using the "company" fallback slug
    assert.equal(result.ok, true);
    assert.equal(result.paths.finalPdf, join(root, "output", "007-company-role", "cv", "tailored", "v001", "cv.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: profile name never changes the Voyager bundle key", () => {
  // Given a profile.yml with a candidate block but no usable full_name
  const root = makeRoot({ profileYaml: 'candidate:\n  full_name: ""\n  email: "jane@example.com"\n' });
  const findReportFile = (input) => (input === "5" ? join(root, "reports", "5-globex-2026-07-01.md") : null);
  try {
    // When resolving paths for report #5
    const result = resolvePdfPaths("5", "2026-07-26", root, findReportFile);

    // Then it still succeeds with the stable report/company/role key.
    assert.equal(result.ok, true);
    assert.equal(result.paths.finalPdf, join(root, "output", "005-globex-role", "cv", "tailored", "v001", "cv.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
