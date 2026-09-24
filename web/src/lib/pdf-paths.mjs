/**
 * pdf-paths.mjs — deterministic scratch + final paths for a web "pdf" run (#2172).
 *
 * Plain .mjs (same pattern as clean-chips.mjs / tracker-table.mjs) so this can
 * be unit-tested with `node --test`, no TypeScript build step. `careerOpsRoot`
 * and `findReportFile` are passed in rather than imported from career-ops.ts,
 * keeping this module free of TypeScript dependencies.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Lowercase, non-alphanumeric runs -> single hyphen, trimmed.
 * @param {string} s
 * @returns {string}
 */
export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * @typedef {Object} PdfPaths
 * @property {string} draft - Where the backend writes the agent's structured Voyager draft.
 * @property {string} cvTex - Bundle-local resume TeX source.
 * @property {string} coverTex - Bundle-local cover-letter TeX source.
 * @property {string} finalPdf - Bundle-local resume PDF.
 * @property {string} coverPdf - Bundle-local cover-letter PDF.
 * @property {string} style - Bundle-local copy of the user's VOYAGER class.
 * @property {string} manifest - Paired-document generation manifest.
 */

/**
 * Precompute the paired Voyager bundle paths for a web "pdf" run. The backend
 * owns naming, writing, and rendering; the agent never chooses a filesystem path.
 *
 * Framework-agnostic: returns a result instead of constructing a Response, so
 * the caller (a Next.js route today) decides how to surface `ok: false`.
 *
 * Side effect: creates `.career-ops-web/pdf-tmp/` under `root` if it doesn't
 * exist yet (the backend writes the parsed envelope there, #2185) — this is
 * NOT a pure path computation, despite the name.
 *
 * @param {string} input - The report number (e.g. "018").
 * @param {string} today - YYYY-MM-DD.
 * @param {string} root - careerOpsRoot().
 * @param {(input: string) => string | null} findReportFile - career-ops.ts's findReportFile.
 * @returns {{ok: true, paths: PdfPaths} | {ok: false, error: string}}
 */
export function resolvePdfPaths(input, today, root, findReportFile) {
  // Reject anything but a bare report number before it ever reaches a path.
  // findReportFile()'s parseInt-based matching can still resolve a crafted
  // selector like "123/../../etc/passwd" to a legitimate report file, but the
  // raw string is also used verbatim below to build cv-web-${input}.html —
  // path.join would then honor those ".." segments and escape scratchDir.
  if (!/^\d+$/.test(input)) {
    return { ok: false, error: `Invalid report selector: "${input}"` };
  }
  const reportFile = findReportFile(input);
  if (!reportFile) {
    return { ok: false, error: `No report #${input} found — evaluate this posting first.` };
  }
  const companyMatch = path.basename(reportFile).match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
  const companySlug = companyMatch ? companyMatch[1] : "company";
  let roleSlug = "role";
  let role = "Role";
  let url = "";
  try {
    const report = fs.readFileSync(reportFile, "utf8");
    const foundRole = report.match(/^\*\*Role:\*\*\s*(.+)$/mi)?.[1]?.trim();
    if (foundRole) {
      role = foundRole;
      roleSlug = slugify(role) || "role";
    }
    url = report.match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/mi)?.[1] ?? "";
  } catch (err) {
    if (err?.code !== "ENOENT") console.warn(`resolvePdfPaths: could not read report role, defaulting to role: ${err.message}`);
  }
  const bundle = path.join(root, "output", `${String(Number(input)).padStart(3, "0")}-${companySlug}-${roleSlug}`);
  const version = "v001";
  const documents = path.join(bundle, "documents");
  const cv = path.join(bundle, "cv", "tailored", version);
  const cover = path.join(bundle, "cover", "tailored", version);
  return {
    ok: true,
    paths: {
      draft: path.join(documents, "draft.web.json"),
      cvTex: path.join(cv, "cv.tex"),
      coverTex: path.join(cover, "cover.tex"),
      finalPdf: path.join(cv, "cv.pdf"),
      coverPdf: path.join(cover, "cover.pdf"),
      style: path.join(documents, "style.cls"),
      manifest: path.join(documents, "manifest.json"),
      report: { number: String(Number(input)).padStart(3, "0"), company: companySlug, role, url },
    },
  };
}
