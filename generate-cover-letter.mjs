#!/usr/bin/env node
/**
 * generate-cover-letter.mjs — Renders a cover letter payload to PDF.
 *
 * Usage:
 *   node generate-cover-letter.mjs --payload payload.json
 *   node generate-cover-letter.mjs --payload payload.json --out output/slug-cover.pdf
 *
 * Renders the payload as VOYAGER TeX, then compiles it through the shared
 * integrations/voyager/build.mjs entrypoint. `buildHtml` remains a non-PDF preview helper
 * for existing custom-template validation.
 *
 * `buildHtml` and `safeOutputPath` are exported as pure functions so the
 * template and --out path guard can be tested without compiling LaTeX.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve, join, relative, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { assertFacts } from "./verify-cv-facts.mjs";
import { resolveTemplate } from "./cv-templates.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { escapeLatex, sanitizeUrl } from "./lib/latex-escape.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = resolve(__dirname, "output");

/**
 * Resolve a requested cover-letter output path.
 *
 * Paths that stay inside `output/` keep their relative subdirectory (the
 * application-bundle layout integrations/voyager/build.mjs supports). Paths that
 * would escape `output/` — `..` traversal or an absolute path outside it —
 * are rejected instead of being silently flattened to `output/<basename>`.
 *
 * @param {string} raw - Caller-supplied --out / payload.output_path value.
 * @returns {string} Absolute path inside OUTPUT_ROOT.
 */
export function safeOutputPath(raw) {
  if (raw == null || String(raw).trim() === "") {
    throw new Error("Refusing to write the cover letter outside output/: (empty path)");
  }
  const trimmed = String(raw).trim();

  const asWritten = resolve(trimmed);
  if (containedInOutput(asWritten)) return asWritten;

  // Absolute paths and any `..` segment already chose a location; if that
  // location is not inside output/, refuse instead of rewriting to a basename.
  if (isAbsolute(trimmed) || /(^|[\\/])\.\.([\\/]|$)/.test(trimmed)) {
    throw new Error(`Refusing to write the cover letter outside output/: ${raw}`);
  }

  // Bare filename or a relative path that is not already under output/
  // (e.g. --out cover.pdf, or --out output/foo/bar.pdf from another cwd).
  const posix = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  const relativeToRoot = posix === "output" || posix === "output/"
    ? ""
    : posix.startsWith("output/")
      ? posix.slice("output/".length)
      : posix;
  const candidate = resolve(OUTPUT_ROOT, relativeToRoot);
  if (containedInOutput(candidate)) return candidate;

  throw new Error(`Refusing to write the cover letter outside output/: ${raw}`);
}

/** True when absPath is a file (not output/ itself) still inside OUTPUT_ROOT. */
function containedInOutput(absPath) {
  const rel = relative(OUTPUT_ROOT, absPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Assert that a payload object contains the required keys. */
function _require(obj, keys, context) {
  for (const key of keys) {
    if (!obj || typeof obj !== "object" || !(key in obj)) {
      throw new Error(`Missing required field: ${context}.${key}`);
    }
  }
}

/** Escape user-provided text before inserting it into generated HTML. */
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Add an HTTPS scheme to a profile URL when it is omitted. */
function asUrl(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/** Build the escaped contact line shown in the cover-letter header. */
function buildContactLine(candidate) {
  const parts = [];
  if (candidate.location) parts.push(escapeHtml(candidate.location));
  if (candidate.email) {
    const email = escapeHtml(candidate.email);
    parts.push(`<a href="mailto:${email}">${email}</a>`);
  }
  if (candidate.phone) parts.push(escapeHtml(candidate.phone));
  if (candidate.linkedin) {
    const display = candidate.linkedin.replace(/^https?:\/\//i, "");
    parts.push(`<a href="${escapeHtml(asUrl(candidate.linkedin))}">${escapeHtml(display)}</a>`);
  }
  if (candidate.github) {
    const display = candidate.github.replace(/^https?:\/\//i, "");
    parts.push(`<a href="${escapeHtml(asUrl(candidate.github))}">${escapeHtml(display)}</a>`);
  }
  return parts.join(" &nbsp;|&nbsp; ");
}

/** Build the optional credentials line from the candidate payload. */
function buildCredentialsBlock(candidate) {
  const credentials = candidate.credentials || [];
  if (!credentials.length) return "";
  return `<div class="credentials">${credentials.map(escapeHtml).join(" &nbsp;|&nbsp; ")}</div>`;
}

/** Build the escaped company, city, and date line for the letter. */
function buildDateline(letter) {
  const parts = [letter.company, letter.city, letter.date].filter(Boolean).map(escapeHtml);
  return parts.join(" &nbsp;&nbsp; ");
}

/** Build the optional achievements list for the letter body. */
function buildAchievementsBlock(achievements) {
  if (!achievements || !achievements.length) return "";
  const items = achievements.map(ach => {
    // Trim a caller-supplied trailing comma (cover.md's own bullet-format
    // example shows the lead ending in a comma) so it never doubles up with
    // the comma this function always appends.
    const lead = escapeHtml((ach.lead || "").replace(/,\s*$/, ""));
    const impact = escapeHtml(ach.impact || "");
    return `    <li><b>${lead},</b> ${impact}</li>`;
  }).join("\n");
  return `<ul class="achievements">\n${items}\n  </ul>`;
}

/** Build the optional footnotes block with escaped links. */
function buildFootnotesBlock(footnotes) {
  if (!footnotes || !footnotes.length) return "";
  const lines = footnotes.map(fn => {
    if (typeof fn === "object" && fn !== null) {
      const marker = escapeHtml(fn.marker || "");
      const text = escapeHtml(fn.text || "");
      const url = fn.url
        ? ` <a href="${escapeHtml(fn.url)}">${escapeHtml(fn.url)}</a>`
        : "";
      return `    <p>${marker} ${text}${url}</p>`;
    }
    return `    <p>${escapeHtml(fn)}</p>`;
  }).join("\n");
  return `<div class="footnotes">\n${lines}\n  </div>`;
}

/**
 * Build the optional sign-off block: a valediction over the signing name.
 *
 * Accepts either a plain string (used verbatim as the valediction) or an
 * object `{ valediction, name }`. `name` defaults to the candidate name so a
 * payload can set only the valediction. Returns "" when unset, which keeps
 * every pre-existing payload rendering byte-identical.
 */
function buildSignatureBlock(signature, candidateName) {
  if (!signature) return "";
  const isObject = typeof signature === "object" && signature !== null;
  const valediction = isObject ? signature.valediction : signature;
  const name = (isObject ? signature.name : "") || candidateName || "";
  if (!valediction && !name) return "";
  // Each value is escaped independently; the <br> separator is template markup
  // emitted between them, never injected into escaped content.
  const lines = [valediction, name].filter(Boolean).map(escapeHtml);
  return `<p class="signature">${lines.join("<br>")}</p>`;
}

// Resolve the cover-letter template through the shared resolver so a
// `cover_letter.template` profile default, an explicit `payload.template`, and
// installed template packs are all honored. Any resolver failure (no profile,
// no templates dir, bad config) falls back to the base template, preserving the
// original hardcoded behavior.
export function resolveCoverTemplatePath(payload = {}, opts = {}) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const base = resolve(scriptDir, "templates", "cover-letter-template.html");
  try {
    return resolveTemplate("cover", payload.template, { format: "html", fallback: true, ...opts });
  } catch {
    return base;
  }
}

export function buildHtml(payload, templatePath) {
  _require(payload, ["candidate", "letter"], "payload");
  const candidate = payload.candidate;
  const letter = payload.letter;
  _require(candidate, ["name"], "candidate");
  _require(letter, ["role_title", "opening", "profile_intro"], "letter");

  const resolvedPath = templatePath || resolveCoverTemplatePath(payload);
  let html = readFileSync(resolvedPath, "utf-8");

  // Optional salutation (e.g. "Dear Jane Smith,"). Omitted -> no salutation,
  // preserving the original behavior for payloads that don't set it.
  const greetingBlock = letter.greeting ? `<p class="greeting">${escapeHtml(letter.greeting)}</p>` : "";
  const closingBlock = letter.closing ? `<p>${escapeHtml(letter.closing)}</p>` : "";
  const languageClosingBlock = letter.language_closing
    ? `<p class="language-closing">${escapeHtml(letter.language_closing)}</p>`
    : "";
  const problemsBlock = letter.problems_section ? `<p>${escapeHtml(letter.problems_section)}</p>` : "";

  // Optional sign-off (e.g. valediction "Sincerely," over the signing name).
  // Omitted -> no signature, preserving behavior for payloads that don't set it.
  // The name falls back to the candidate name so a payload can set only the
  // valediction. The <br> is emitted around escaped values, never inside one.
  const signatureBlock = buildSignatureBlock(letter.signature, candidate.name);

  const replacements = {
    "{{NAME}}": escapeHtml(candidate.name),
    "{{CONTACT_LINE}}": buildContactLine(candidate),
    "{{CREDENTIALS_BLOCK}}": buildCredentialsBlock(candidate),
    "{{ROLE_TITLE}}": escapeHtml(letter.role_title),
    "{{DATELINE}}": buildDateline(letter),
    "{{GREETING_BLOCK}}": greetingBlock,
    "{{OPENING}}": escapeHtml(letter.opening),
    "{{PROFILE_INTRO}}": escapeHtml(letter.profile_intro),
    "{{ACHIEVEMENTS_BLOCK}}": buildAchievementsBlock(letter.achievements),
    "{{PROBLEMS_BLOCK}}": problemsBlock,
    "{{CLOSING_BLOCK}}": closingBlock,
    "{{LANGUAGE_CLOSING_BLOCK}}": languageClosingBlock,
    "{{SIGNATURE_BLOCK}}": signatureBlock,
    "{{FOOTNOTES_BLOCK}}": buildFootnotesBlock(letter.footnotes),
  };

  // Single-pass substitution: each {{TOKEN}} is replaced exactly once against
  // the original template. A single regex pass (rather than iterative
  // split/join) ensures a substituted value that itself contains a {{TOKEN}}
  // sequence is left literal instead of being re-interpreted as a placeholder.
  //
  // A token with no entry in the map is a template the renderer cannot fill —
  // a custom cover-letter template (KINDS.cover in cv-templates.mjs) carrying a
  // typo'd or unsupported token. Collect those DURING the pass rather than
  // scanning the result: a scan of the output cannot tell a template token from
  // the same sequence appearing inside a substituted value, which is exactly
  // what the single pass above is careful to leave literal.
  const unresolved = new Set();
  const rendered = html.replace(/\{\{[A-Z_]+\}\}/g, (token) => {
    const value = replacements[token];
    if (value == null) {
      unresolved.add(token);
      return token;
    }
    return value;
  });

  // Fail loudly, matching build-cv-html.mjs and build-cv-latex.mjs. Shipping a
  // letter with a literal {{TOKEN}} in it is worse than not producing one.
  if (unresolved.size) {
    throw new Error(`Unresolved placeholders: ${[...unresolved].join(', ')}`);
  }
  return rendered;
}

function latexText(value) {
  return escapeLatex(String(value || "").trim());
}

function latexLink(url, label) {
  const safeUrl = sanitizeUrl(String(url || "").trim());
  const safeLabel = latexText(label);
  return safeUrl && safeLabel ? `\\candidateLink{${safeUrl}}{${safeLabel}}` : "";
}

function coverParagraphs(letter) {
  const achievements = (letter.achievements || [])
    .map((item) => [item?.lead, item?.impact].filter(Boolean).join(", "))
    .filter(Boolean);
  return [
    letter.opening,
    letter.profile_intro,
    ...achievements,
    letter.problems_section,
    letter.closing,
    letter.language_closing,
  ].filter(Boolean).map(latexText).join("\n\n");
}

/**
 * Render a standalone cover-letter payload into the user's VOYAGER TeX
 * contract. PDF generation must compile this source through build-voyager;
 * the older HTML template remains a non-PDF preview helper only.
 */
export function renderVoyagerCoverTex(payload) {
  _require(payload, ["candidate", "letter"], "payload");
  const candidate = payload.candidate;
  const letter = payload.letter;
  _require(candidate, ["name"], "candidate");
  _require(letter, ["role_title", "opening", "profile_intro"], "letter");

  const profileLinks = [
    candidate.linkedin && latexLink(asUrl(candidate.linkedin), candidate.linkedin.replace(/^https?:\/\//i, "")),
    candidate.github && latexLink(asUrl(candidate.github), candidate.github.replace(/^https?:\/\//i, "")),
  ].filter(Boolean).join(" \\\\ ");
  const contact = [
    candidate.location && latexText(candidate.location),
    candidate.phone && latexText(candidate.phone),
    candidate.email && latexLink(`mailto:${candidate.email}`, candidate.email),
  ].filter(Boolean).join(" \\\\ ");
  // style.cls owns the "Dear … Hiring Team," wrapper. Its macro argument is
  // only the company name, not a fully written salutation.
  const greetingTarget = letter.company || "the";
  const signature = typeof letter.signature === "object" ? letter.signature.name : "";
  return `\\documentclass[coverletter]{style}
\\candidateName{${latexText(candidate.name)}}
\\profileLinks{${profileLinks}}
\\contactInfo{${contact}}
\\begin{document}
\\coverLetterDate
\\coverLetterGreeting{${latexText(greetingTarget)}}
\\coverLetterSubject{${latexText(letter.role_title)}}
${coverParagraphs(letter)}
\\coverLetterSignature{${latexText(signature || candidate.email || candidate.name)}}
\\end{document}
`;
}

/** Parse a payload, run the fact gate, and render the cover-letter PDF. */
async function main() {
  const { values: args } = parseArgs({
    options: {
      payload: { type: "string" },
      out:     { type: "string" },
      help:    { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (args.help || !args.payload) {
    console.log(`
Usage:
  node generate-cover-letter.mjs --payload payload.json [--out output/path.pdf]

  --payload   Path to the JSON payload file (required)
  --out       Override output path from payload (optional)
`);
    process.exit(args.help ? 0 : 1);
  }

  const payloadPath = resolve(args.payload);
  if (!existsSync(payloadPath)) {
    console.error(`ERROR: payload file not found: ${payloadPath}`);
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(payloadPath, "utf-8"));

  if (args.out) {
    payload.output_path = args.out;
  }

  if (!payload.output_path) {
    const company = (payload.letter?.company || "company").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const role    = (payload.letter?.role_title || "role").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    payload.output_path = join(OUTPUT_ROOT, `${company}-${role}-cover.pdf`);
  } else {
    try {
      payload.output_path = safeOutputPath(payload.output_path);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (!existsSync(OUTPUT_ROOT)) mkdirSync(OUTPUT_ROOT, { recursive: true });

  try {
    const factText = [
      payload.letter?.opening,
      payload.letter?.profile_intro,
      payload.letter?.problems_section,
      payload.letter?.closing,
      payload.letter?.language_closing,
      ...(payload.letter?.achievements || []).flatMap((item) => [item?.lead, item?.impact]),
    ].filter(Boolean).join("\n");
    // Cover letters are candidate-facing documents too. Reuse the CV fact
    // validator before importing Playwright or writing a PDF so a failed gate
    // cannot leave behind a misleading artifact.
    const factCheck = assertFacts(factText, { label: "cover letter" });
    // Ahead of the verdict, because it qualifies it: with no config the phrase
    // lists are empty, so a silent gate here covers metrics and facts only.
    if (factCheck.configMissing) {
      console.error("No config/cv-facts.json — forbidden/advisory phrase checks did not run.");
    }
    if (factCheck.verdict === "warn") {
      console.error(`CV fact check warning: cover letter`);
      for (const phrase of factCheck.warnings) {
        console.error(`  - advisory phrase: ${phrase}`);
      }
    }
    // Imported only after fact validation so a failed gate cannot create a PDF
    // artifact. The central builder receives VOYAGER TeX and the original class.
    const { compileVoyagerTex } = await import("./integrations/voyager/build.mjs");
    const outputPath = resolve(payload.output_path);
    const texPath = outputPath.replace(/\.pdf$/i, ".tex");
    writeFileSync(texPath, renderVoyagerCoverTex(payload), "utf8");
    await compileVoyagerTex({ texPath, outputPath });
    console.log(`\nCover letter PDF: ${payload.output_path}`);
  } catch (err) {
    console.error("ERROR generating cover letter PDF:");
    console.error(err.message);
    process.exit(1);
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
