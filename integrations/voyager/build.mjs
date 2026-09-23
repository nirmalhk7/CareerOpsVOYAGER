#!/usr/bin/env node

/**
 * Compile a VOYAGER resume or cover letter with the canonical VOYAGER class.
 *
 * This is deliberately a Node-only boundary: it invokes the same `latexmk`
 * command used by VOYAGER's Makefile and never reaches into its Python/Jinja
 * renderer.  The caller supplies already-rendered TeX plus its class file.
 *
 * Usage:
 *   node integrations/voyager/build.mjs <input.tex> <output.pdf> [--class path/to/style.cls]
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, delimiter, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../../lib/is-main-module.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VOYAGER_CLASS = resolve(SCRIPT_DIR, '..', '..', 'careers', 'VOYAGER', 'src', 'docsparser', 'style.cls');

function readDocumentType(texPath) {
  const source = readFileSync(texPath, 'utf8');
  const declaration = source.match(/\\documentclass(?:\[([^\]]*)\])?\{([^}]+)\}/);
  if (!declaration) throw new Error(`${basename(texPath)} is missing a \\documentclass declaration`);

  const options = declaration[1] || '';
  const documentType = options.split(',').map((option) => option.trim()).find((option) => option === 'resume' || option === 'coverletter');
  if (!documentType) throw new Error(`${basename(texPath)} must declare the VOYAGER resume or coverletter option`);

  return { source, className: declaration[2].trim(), documentType };
}

function compactCompilerOutput(error) {
  const output = [error?.stdout, error?.stderr]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .join('\n')
    .trim();
  return output ? `\n${output.slice(-4000)}` : '';
}

/**
 * Compile one rendered VOYAGER TeX document using the supplied `.cls` file.
 *
 * The TeX and class source files are read but never written.  LaTeX auxiliary
 * output is directed next to the requested PDF, which keeps the source assets
 * pristine while preserving the original VOYAGER resume/cover-letter design.
 */
export async function compileVoyagerTex({ texPath, classPath = DEFAULT_VOYAGER_CLASS, outputPath }) {
  if (!texPath || !outputPath) throw new Error('texPath and outputPath are required');

  const absoluteTex = resolve(texPath);
  const absoluteClass = resolve(classPath);
  const absoluteOutput = resolve(outputPath);

  if (extname(absoluteTex).toLowerCase() !== '.tex') throw new Error('texPath must point to a .tex file');
  if (extname(absoluteClass).toLowerCase() !== '.cls') throw new Error('classPath must point to a .cls file');
  if (extname(absoluteOutput).toLowerCase() !== '.pdf') throw new Error('outputPath must point to a .pdf file');
  if (!existsSync(absoluteTex)) throw new Error(`TeX source not found: ${absoluteTex}`);
  if (!existsSync(absoluteClass)) throw new Error(`VOYAGER class not found: ${absoluteClass}`);

  const { className, documentType } = readDocumentType(absoluteTex);
  if (basename(absoluteClass) !== `${className}.cls`) {
    throw new Error(`Class mismatch: ${basename(absoluteTex)} requests ${className}.cls, received ${basename(absoluteClass)}`);
  }

  const outputDir = dirname(absoluteOutput);
  mkdirSync(outputDir, { recursive: true });
  const jobName = basename(absoluteOutput, '.pdf');
  const texInputs = [dirname(absoluteClass), process.env.TEXINPUTS || ''].join(delimiter);

  try {
    // Mirrors careers/VOYAGER/Makefile's `latexmk -pdf` flow. `-outdir` keeps
    // PDFs and auxiliary files out of the caller's canonical TeX/class inputs.
    execFileSync('latexmk', [
      '-pdf',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-file-line-error',
      `-outdir=${outputDir}`,
      `-jobname=${jobName}`,
      absoluteTex,
    ], {
      cwd: dirname(absoluteTex),
      env: { ...process.env, TEXINPUTS: texInputs },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120_000,
    });
  } catch (error) {
    throw new Error(`VOYAGER ${documentType} compilation failed for ${basename(absoluteTex)}.${compactCompilerOutput(error)}`);
  }

  if (!existsSync(absoluteOutput)) throw new Error(`VOYAGER compilation did not create ${absoluteOutput}`);
  return {
    compiled: true,
    documentType,
    tex: absoluteTex,
    class: absoluteClass,
    pdf: absoluteOutput,
    sizeKB: Number((statSync(absoluteOutput).size / 1024).toFixed(1)),
  };
}

function usage() {
  return 'Usage: node integrations/voyager/build.mjs <input.tex> <output.pdf> [--class path/to/style.cls]';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }

  const classIndex = args.indexOf('--class');
  if (classIndex !== -1 && !args[classIndex + 1]) throw new Error('--class requires a .cls path');
  const positionals = args.filter((arg, index) => arg !== '--class' && index !== classIndex + 1);
  if (positionals.length !== 2 || args.some((arg) => arg.startsWith('--') && arg !== '--class')) throw new Error(usage());

  const result = await compileVoyagerTex({
    texPath: positionals[0],
    outputPath: positionals[1],
    classPath: classIndex === -1 ? DEFAULT_VOYAGER_CLASS : args[classIndex + 1],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`build-voyager: ${error.message}`);
    process.exitCode = 1;
  });
}
