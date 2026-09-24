import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileVoyagerTex } from '../integrations/voyager/build.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nVOYAGER PDF builder');

const root = mkdtempSync(join(tmpdir(), 'career-ops-voyager-'));
const stylePath = join(root, 'style.cls');
const resumePath = join(root, 'resume.tex');
const coverPath = join(root, 'coverletter.tex');
const resumePdf = join(root, 'output', 'resume.pdf');
const coverPdf = join(root, 'output', 'coverletter.pdf');
const htmlPath = join(root, 'preview.html');
const htmlPdf = join(root, 'output', 'preview.pdf');
const script = fileURLToPath(new URL('../integrations/voyager/build.mjs', import.meta.url));

const style = String.raw`\ProvidesClass{style}
\LoadClass{article}
\newif\if@coverletter
\@coverletterfalse
\DeclareOption{resume}{\@coverletterfalse}
\DeclareOption{coverletter}{\@coverlettertrue}
\ProcessOptions\relax
`;

try {
  writeFileSync(stylePath, style);
  writeFileSync(resumePath, String.raw`\documentclass[resume]{style}
\begin{document}
Resume body
\end{document}
`);
  writeFileSync(coverPath, String.raw`\documentclass[coverletter]{style}
\begin{document}
Cover letter body
\end{document}
`);

  const originalResume = readFileSync(resumePath, 'utf8');
  const originalCover = readFileSync(coverPath, 'utf8');

  const [resume, cover] = await Promise.all([
    compileVoyagerTex({ texPath: resumePath, classPath: stylePath, outputPath: resumePdf }),
    compileVoyagerTex({ texPath: coverPath, classPath: stylePath, outputPath: coverPdf }),
  ]);

  assert.equal(resume.documentType, 'resume');
  assert.equal(cover.documentType, 'coverletter');
  assert.ok(existsSync(resumePdf));
  assert.ok(existsSync(coverPdf));
  assert.equal(readFileSync(resumePath, 'utf8'), originalResume);
  assert.equal(readFileSync(coverPath, 'utf8'), originalCover);
  pass('one Voyager class renders matching resume and cover-letter PDFs without changing either source');

  writeFileSync(htmlPath, '<!doctype html><html><body><h1>legacy HTML</h1></body></html>');
  const htmlAttempt = spawnSync(process.execPath, [script, '--html', htmlPath, htmlPdf], {
    encoding: 'utf8',
    env: { ...process.env, CAREER_OPS_ROOT: root },
  });
  assert.notEqual(htmlAttempt.status, 0);
  assert.match(htmlAttempt.stderr, /Usage:/);
  assert.equal(existsSync(htmlPdf), false);
  pass('central builder rejects the removed HTML compatibility path');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(root, { recursive: true, force: true });
}
