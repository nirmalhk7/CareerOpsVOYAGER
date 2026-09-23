import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { pass, fail } from './helpers.mjs';
import { applicationArtifactPaths, ensureApplicationArtifactDirs } from '../application-artifacts.mjs';
import { validateDocumentDraft, renderVoyagerTex } from '../integrations/voyager/generate-documents.mjs';

console.log('\nPaired document drafts');

const root = mkdtempSync(join(tmpdir(), 'career-ops-documents-'));
const script = fileURLToPath(new URL('../integrations/voyager/generate-documents.mjs', import.meta.url));

function validDraft(paths) {
  return {
    schema_version: 1,
    report: { number: '007', company: 'Acme AI', role: 'Platform Engineer', url: 'https://jobs.example.test/7' },
    candidate: {
      name: 'Jane Example',
      contact_line: 'Boulder, CO | jane@example.com',
      email: { url: 'mailto:jane@example.com', display: 'jane@example.com' },
      linkedin: { url: 'https://linkedin.com/in/jane', display: 'linkedin.com/in/jane' },
      github: { url: 'https://github.com/jane', display: 'github.com/jane' },
      portfolio_url: 'https://jane.example',
    },
    variant: 'platform',
    evidence: [{ requirement: 'Kubernetes', source: 'cv.md:42', strength: 'strong' }],
    cv: {
      education: [{ institution: 'Example U', degree: 'BS Computer Science', location: 'Boulder, CO', dates: '2026' }],
      experience: [{ company: 'Acme', role: 'Engineer', location: 'Remote', dates: '2024 - Present', bullets: ['Built reliable services with 25% lower latency.'] }],
      projects: [{ name: 'Platform Tool', context: 'Go, Kubernetes', dates: '2025', bullets: ['Automated deploys.'] }],
      awards: [],
      skills: [{ category: 'Platform', items: 'Kubernetes, Go' }],
    },
    cover: {
      greeting: 'Dear Acme AI Hiring Team,',
      subject: 'Platform Engineer Application',
      opening: 'I build platform systems for teams shipping production software.',
      body: 'I would bring Kubernetes and automation experience grounded in the evidence above.',
      closing: 'I would welcome a conversation about the role.',
    },
    paths: {
      cv_tex: paths.cv.tailored.tex,
      cover_tex: paths.cover.tailored.tex,
      manifest: paths.documents.manifest,
      style: join(paths.documents.root, 'style.cls'),
    },
  };
}

try {
  const paths = ensureApplicationArtifactDirs(applicationArtifactPaths({ reportNum: 7, company: 'Acme AI', role: 'Platform Engineer', root }));
  const draft = validDraft(paths);

  const valid = validateDocumentDraft(draft);
  if (valid.errors.length === 0) pass('valid paired draft passes structural validation');
  else fail(`valid paired draft rejected: ${valid.errors.join('; ')}`);

  const invalid = structuredClone(draft);
  invalid.evidence = [];
  const rejected = validateDocumentDraft(invalid);
  if (rejected.errors.some((error) => /evidence/.test(error))) pass('document drafts require evidence mapping');
  else fail(`missing evidence was accepted: ${JSON.stringify(rejected)}`);

  const rendered = renderVoyagerTex(draft);
  if (rendered.cv.includes('Jane Example')
      && rendered.cover.includes('Platform Engineer Application')
      && !rendered.cv.includes('Nirmal Khedkar')
      && rendered.style.includes('VOYAGER document style')) {
    pass('VOYAGER LaTeX rendering uses Career Ops draft data, not legacy identity');
  } else {
    fail('VOYAGER LaTeX rendering did not produce the expected personalized documents');
  }

  const draftPath = join(root, 'draft.json');
  writeFileSync(draftPath, JSON.stringify(draft));
  const blocked = spawnSync(process.execPath, [script, 'render', '--draft', draftPath], { encoding: 'utf8' });
  if (blocked.status === 1 && /--approved/.test(blocked.stderr) && !existsSync(paths.cv.tailored.tex)) {
    pass('render refuses to write documents without explicit approval');
  } else {
    fail(`unapproved render did not stop safely: ${JSON.stringify({ status: blocked.status, stderr: blocked.stderr })}`);
  }

  const preview = spawnSync(process.execPath, [script, 'preview', '--draft', draftPath], { encoding: 'utf8' });
  const previewData = JSON.parse(preview.stdout);
  if (preview.status === 0 && previewData.variant === 'platform' && previewData.evidence_count === 1) {
    pass('preview returns a compact review payload without rendering artifacts');
  } else {
    fail(`preview failed: ${JSON.stringify({ status: preview.status, stdout: preview.stdout, stderr: preview.stderr })}`);
  }

  const approved = spawnSync(process.execPath, [script, 'render', '--draft', draftPath, '--approved'], { encoding: 'utf8', timeout: 30_000 });
  const canonicalStyle = readFileSync(fileURLToPath(new URL('../careers/VOYAGER/src/docsparser/style.cls', import.meta.url)), 'utf8');
  if (approved.status === 0
      && existsSync(paths.cv.tailored.tex.replace(/\.tex$/, '.pdf'))
      && existsSync(paths.cover.tailored.tex.replace(/\.tex$/, '.pdf'))
      && readFileSync(draft.paths.style, 'utf8') === canonicalStyle
      && JSON.parse(approved.stdout).validation.cv.documentType === 'resume'
      && JSON.parse(approved.stdout).validation.cover.documentType === 'coverletter') {
    pass('approved paired render uses the canonical VOYAGER class for both PDFs');
  } else {
    fail(`approved Voyager render failed: ${JSON.stringify({ status: approved.status, stdout: approved.stdout, stderr: approved.stderr })}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
