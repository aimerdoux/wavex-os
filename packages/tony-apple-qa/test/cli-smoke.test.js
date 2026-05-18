import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const cliPath = resolve(packageRoot, 'bin/tony-apple-qa.js');
const packageJson = JSON.parse(
  await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
);

test('tony-apple-qa --version prints the package version', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliPath,
    '--version',
  ]);

  assert.equal(stderr, '');
  assert.equal(stdout.trim(), packageJson.version);
});
