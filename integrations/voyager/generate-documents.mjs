#!/usr/bin/env node

/**
 * Native paired resume + cover-letter renderer.
 *
 * The agent owns drafting. This script owns the boundary between an approved,
 * evidence-backed JSON draft and portable LaTeX artifacts. It deliberately
 * contains no model calls and never updates the application tracker.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, resolve } from 'path';
import { escapeLatex, sanitizeUrl } from '../../lib/latex-escape.mjs';
import { validatePayload } from '../../lib/cv-payload-schema.mjs';
import { compileVoyagerTex, DEFAULT_VOYAGER_CLASS } from './build.mjs';
import { validateFlags } from '../../lib/cli-flags.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';

const VARIANTS = new Set(['systems', 'platform', 'fullstack']);
const STYLE_FILE = 'style.cls';

// The canonical user-owned VOYAGER class is copied verbatim into every paired
// artifact so resume and cover-letter PDFs share the original design.
export const VOYAGER_STYLE = readFileSync(DEFAULT_VOYAGER_CLASS, 'utf8');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function required(value, label, errors) {
  if (!text(value)) errors.push(`${label} is required`);
}

function latexText(value) {
  return escapeLatex(text(value));
}

function latexUrl(value) {
  return sanitizeUrl(text(value));
}

function bullet(value) {
  return latexText(value).replace(/\*\*([^*]+?)\*\*/g, (_, inner) => `\\textbf{${inner}}`);
}

function link(url, label) {
  const safeUrl = latexUrl(url);
  const safeLabel = latexText(label);
  return safeUrl && safeLabel ? `\\candidateLink{${safeUrl}}{${safeLabel}}` : '';
}

function cvSection(name, body) {
  return body ? `\\begin{resumeSection}{${latexText(name)}}\n${body}\n\\end{resumeSection}` : '';
}

function renderEducation(entries) {
  return entries.map((item) => `\\educationEntry{${latexText(item.institution)}}{${latexText(item.dates)}}{${latexText(item.degree)}}`).join('\n\n');
}

function renderExperience(entries) {
  return entries.map((item) => {
    const company = latexUrl(item.url)
      ? `\\entryLink{${latexUrl(item.url)}}{${latexText(item.company)}}`
      : latexText(item.company);
    const bullets = (item.bullets || []).map((itemBullet) => `\\item ${bullet(itemBullet)}`).join('\n');
    return `\\begin{workExperienceEntry}{${company}}{${latexText(item.dates)}}{${latexText(item.role)}}{${latexText(item.location)}}\n${bullets}\n\\end{workExperienceEntry}`;
  }).join('\n\n');
}

function renderProjects(entries) {
  return entries.map((item) => {
    const name = latexUrl(item.url)
      ? `\\entryLink{${latexUrl(item.url)}}{${latexText(item.name)}}`
      : latexText(item.name);
    const bullets = (item.bullets || []).map((itemBullet) => `\\item ${bullet(itemBullet)}`).join('\n');
    return `\\begin{projectEntry}{${name}}{${latexText(item.context)}}\n${bullets}\n\\end{projectEntry}`;
  }).join('\n\n');
}

function renderAwards(entries) {
  return entries.map((item) => `\\textbf{${latexText(item.title)}}${item.org ? `, ${latexText(item.org)}` : ''}${item.year ? ` \\hfill ${latexText(item.year)}` : ''}`).join('\\\\\n');
}

function renderSkills(entries) {
  return entries.map((item) => `\\skillLine{${latexText(item.category)}}{${latexText(Array.isArray(item.items) ? item.items.join(', ') : item.items)}}`).join('\n');
}

/** Validate the portable paired-document schema before it reaches LaTeX. */
export function validateDocumentDraft(draft) {
  const errors = [];
  const warnings = [];
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return { errors: ['draft must be an object'], warnings };
  if (draft.schema_version !== 1) errors.push('schema_version must be 1');
  if (!/^\d+$/.test(text(draft.report?.number))) errors.push('report.number must be numeric');
  required(draft.report?.company, 'report.company', errors);
  required(draft.report?.role, 'report.role', errors);
  if (!/^https?:\/\//.test(text(draft.report?.url))) errors.push('report.url must be an http(s) URL');
  required(draft.candidate?.name, 'candidate.name', errors);
  required(draft.candidate?.contact_line, 'candidate.contact_line', errors);
  if (!VARIANTS.has(draft.variant)) errors.push(`variant must be one of: ${[...VARIANTS].join(', ')}`);
  if (!Array.isArray(draft.evidence) || draft.evidence.length === 0) {
    errors.push('evidence must contain at least one requirement-to-source mapping');
  } else {
    draft.evidence.forEach((item, index) => {
      required(item?.requirement, `evidence[${index}].requirement`, errors);
      required(item?.source, `evidence[${index}].source`, errors);
      required(item?.strength, `evidence[${index}].strength`, errors);
    });
  }
  const cvResult = validatePayload(draft.cv, 'tex');
  errors.push(...cvResult.errors.map((item) => `cv.${item}`));
  warnings.push(...cvResult.warnings.map((item) => `cv.${item}`));
  for (const field of ['greeting', 'subject', 'opening', 'body', 'closing']) required(draft.cover?.[field], `cover.${field}`, errors);
  for (const field of ['cv_tex', 'cover_tex', 'manifest', 'style']) required(draft.paths?.[field], `paths.${field}`, errors);
  return { errors, warnings };
}

/** Stable source fingerprint used to decide whether a draft can be reused. */
export function documentDraftFingerprint(draft) {
  const copy = structuredClone(draft);
  delete copy.paths;
  delete copy.generated_at;
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

/** Render portable VOYAGER-style LaTeX from Career Ops data. No I/O. */
export function renderVoyagerTex(draft) {
  const candidate = draft.candidate;
  const profileLinks = [
    link(candidate.linkedin?.url, candidate.linkedin?.display),
    link(candidate.portfolio_url, candidate.portfolio_display || candidate.portfolio_url.replace(/^https?:\/\//, '')),
    link(candidate.github?.url, candidate.github?.display),
  ].filter(Boolean).join(' \\\\ ');
  const contact = [
    text(candidate.contact_line),
    link(candidate.email?.url, candidate.email?.display),
  ].filter(Boolean).join(' \\\\ ');
  const cv = draft.cv;
  const sections = [
    cvSection('Relevant Industry Experience', renderExperience(cv.experience || [])),
    cvSection('Projects and Achievements', renderProjects(cv.projects || [])),
    cvSection('Education', renderEducation(cv.education || [])),
    cvSection('Awards and Honors', renderAwards(cv.awards || [])),
    cvSection('Technical Skills', renderSkills(cv.skills || [])),
  ].filter(Boolean).join('\n\n');
  const header = [
    `\\candidateName{${latexText(candidate.name)}}`,
    `\\profileLinks{${profileLinks}}`,
    `\\contactInfo{${contact}}`,
    `\\resumeHeadline{${latexText(draft.headline || draft.report.role)}}`,
  ].join('\n');
  const cvTex = `\\documentclass[resume]{style}\n${header}\n\\begin{document}\n${sections}\n\\end{document}\n`;
  const cover = draft.cover;
  const coverTex = `\\documentclass[coverletter]{style}\n${header}\n\\begin{document}\n\\coverLetterDate\n\\coverLetterGreeting{${latexText(cover.greeting)}}\n\\coverLetterSubject{${latexText(cover.subject)}}\n${latexText(cover.opening)}\n\n${latexText(cover.body)}\n\n${latexText(cover.closing)}\n\\coverLetterSignature{${latexText(candidate.email?.display || '')}}\n\\end{document}\n`;
  return { cv: cvTex, cover: coverTex, style: VOYAGER_STYLE };
}

function writeRenderedDocuments(draft, rendered) {
  const paths = draft.paths;
  for (const target of [paths.cv_tex, paths.cover_tex, paths.style]) mkdirSync(dirname(resolve(target)), { recursive: true });
  writeFileSync(paths.style, rendered.style, 'utf8');
  writeFileSync(paths.cv_tex, rendered.cv, 'utf8');
  writeFileSync(paths.cover_tex, rendered.cover, 'utf8');
  // LaTeX resolves \documentclass relative to each generated document.
  copyFileSync(paths.style, resolve(dirname(paths.cv_tex), STYLE_FILE));
  copyFileSync(paths.style, resolve(dirname(paths.cover_tex), STYLE_FILE));
}

async function renderApprovedDraft(draft) {
  const verdict = validateDocumentDraft(draft);
  if (verdict.errors.length) throw new Error(`Invalid document draft:\n${verdict.errors.map((item) => `- ${item}`).join('\n')}`);
  const rendered = renderVoyagerTex(draft);
  writeRenderedDocuments(draft, rendered);
  const [cv, cover] = await Promise.all([
    compileVoyagerTex({ texPath: draft.paths.cv_tex, classPath: resolve(draft.paths.style), outputPath: resolve(draft.paths.cv_tex).replace(/\.tex$/i, '.pdf') }),
    compileVoyagerTex({ texPath: draft.paths.cover_tex, classPath: resolve(draft.paths.style), outputPath: resolve(draft.paths.cover_tex).replace(/\.tex$/i, '.pdf') }),
  ]);
  const manifest = {
    schema_version: 1,
    report: draft.report,
    variant: draft.variant,
    fingerprint: documentDraftFingerprint(draft),
    generated_at: new Date().toISOString(),
    template: 'voyager',
    evidence: draft.evidence,
    validation: { warnings: verdict.warnings, cv, cover },
    paths: draft.paths,
  };
  mkdirSync(dirname(resolve(draft.paths.manifest)), { recursive: true });
  writeFileSync(draft.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

const USAGE = `Usage:
  node integrations/voyager/generate-documents.mjs preview --draft draft.json
  node integrations/voyager/generate-documents.mjs render --draft draft.json --approved`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  validateFlags(args.slice(1), ['--draft', '--approved', '--help', '-h'], USAGE, { valueFlags: ['--draft'], requireOperand: true });
  if (args.includes('--help') || args.includes('-h') || !command) {
    console.error(USAGE);
    process.exitCode = command ? 0 : 1;
    return;
  }
  const draftIndex = args.indexOf('--draft');
  const draftPath = draftIndex >= 0 ? args[draftIndex + 1] : '';
  if (!draftPath) throw new Error('--draft is required');
  let draft;
  try {
    draft = JSON.parse(readFileSync(resolve(draftPath), 'utf8'));
  } catch (error) {
    throw new Error(`Could not read draft: ${error.message}`);
  }
  const verdict = validateDocumentDraft(draft);
  if (command === 'preview') {
    console.log(JSON.stringify({
      valid: verdict.errors.length === 0,
      errors: verdict.errors,
      warnings: verdict.warnings,
      report: draft.report,
      variant: draft.variant,
      evidence_count: Array.isArray(draft.evidence) ? draft.evidence.length : 0,
      fingerprint: documentDraftFingerprint(draft),
    }, null, 2));
    process.exitCode = verdict.errors.length ? 1 : 0;
    return;
  }
  if (command !== 'render') throw new Error(`Unknown command: ${command}`);
  if (!args.includes('--approved')) throw new Error('render requires --approved after explicit user approval');
  const manifest = await renderApprovedDraft(draft);
  console.log(JSON.stringify(manifest, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`generate-documents: ${error.message}`);
    process.exitCode = 1;
  });
}
