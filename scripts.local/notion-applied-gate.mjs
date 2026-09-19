#!/usr/bin/env node
/** Thin alias — prefer: node notion-applied.mjs … */
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(process.execPath, [resolve(root, 'notion-applied.mjs'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
process.exit(r.status ?? 1);
