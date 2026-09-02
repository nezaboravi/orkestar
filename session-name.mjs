#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function herdrSessionName(project) {
  const absolute = fs.realpathSync(path.resolve(project));
  const identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const slug = path.basename(absolute)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 16) || 'project';
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 8);
  return `lenka-${slug}-${hash}`;
}

const invokedFile = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
if (invokedFile === fileURLToPath(import.meta.url)) {
  const project = process.argv[2];
  if (!project) {
    console.error('ERROR: project path is required');
    process.exitCode = 1;
  } else {
    console.log(herdrSessionName(project));
  }
}

export { herdrSessionName };
