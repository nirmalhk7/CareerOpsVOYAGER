#!/usr/bin/env node
/**
 * career-ops → JobPrompter bridge (user-layer; do not edit VOYAGER).
 *
 * Usage:
 *   node scripts.local/jobprompter-from-report.mjs reports/042-acme-2026-09-16.md
 *   node scripts.local/jobprompter-from-report.mjs 042
 *
 * Extracts **URL:** and ## Job Description (archived verbatim) from a report,
 * writes a temp JD file, runs `jobprompter generate`, prints paths.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts.local/jobprompter-from-report.mjs <report.md|NNN>');
  process.exit(2);
}

function findReport(spec) {
  const direct = resolve(ROOT, spec);
  if (existsSync(direct) && direct.endsWith('.md')) return direct;
  const reportsDir = join(ROOT, 'reports');
  if (!existsSync(reportsDir)) {
    throw new Error('reports/ missing — evaluate a JD first');
  }
  const pad = String(spec).replace(/^#/, '').padStart(3, '0');
  const hits = readdirSync(reportsDir).filter(
    (f) => f.startsWith(`${pad}-`) && f.endsWith('.md'),
  );
  if (hits.length === 0) throw new Error(`No report matching ${spec} in reports/`);
  hits.sort();
  return join(reportsDir, hits[hits.length - 1]);
}

function extractUrlAndJd(md) {
  const urlMatch = md.match(/\*\*URL:\*\*\s*(\S+)/);
  if (!urlMatch) throw new Error('Report missing **URL:** header');
  const url = urlMatch[1].replace(/[)\].,]+$/, '');
  const jdHeader = /^##\s+Job Description(?:\s*\(archived verbatim\))?/im;
  const start = md.search(jdHeader);
  if (start < 0) throw new Error('Report missing ## Job Description (archived verbatim)');
  const fromHeader = md.slice(start);
  const nextSection = fromHeader.search(/\n##\s+(?!Job Description)/);
  const block = nextSection > 0 ? fromHeader.slice(0, nextSection) : fromHeader;
  const jdText = block.replace(/^##\s+Job Description[^\n]*\n+/i, '').trim();
  if (jdText.length < 40) throw new Error('Archived JD section is empty or too short');
  return { url, jdText };
}

function resolveJobprompter() {
  const fromEnv = process.env.JOBPROMPTER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const which = spawnSync('which', ['jobprompter'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const fallback = `${process.env.HOME}/.local/bin/jobprompter`;
  if (existsSync(fallback)) return fallback;
  throw new Error('jobprompter not found on PATH (expected ~/.local/bin/jobprompter)');
}

const reportPath = findReport(arg);
const md = readFileSync(reportPath, 'utf8');
const { url, jdText } = extractUrlAndJd(md);
const dir = mkdtempSync(join(tmpdir(), 'career-ops-jp-'));
const jdFile = join(dir, 'jd.md');
writeFileSync(jdFile, jdText, 'utf8');

const bin = resolveJobprompter();
console.log(`Report: ${reportPath}`);
console.log(`URL: ${url}`);
console.log(`JD temp: ${jdFile}`);
console.log(`Running: ${bin} generate --url … --jd-file …`);

const result = spawnSync(bin, ['generate', '--url', url, '--jd-file', jdFile], {
  encoding: 'utf8',
  cwd: ROOT,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  console.error(`jobprompter exited ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log(`\nDone. (career-ops did not modify JobPrompter/VOYAGER source files.)`);
console.log(`Source report: ${basename(reportPath)}`);
