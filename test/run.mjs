import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// quota.js resolves its storage from the home directory at import time, so the
// quota suite runs against a throwaway one. Nothing touches ~/.rep4rep-cli.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rep4rep-test-'));

const suites = [
    { file: 'runner.test.mjs', env: {} },
    { file: 'steam.test.mjs', env: {} },
    { file: 'accounts.test.mjs', env: {} },
    { file: 'quota.test.mjs', env: { HOME: sandbox, USERPROFILE: sandbox } },
];

let failures = 0;

for (const { file, env } of suites) {
    console.log(`\n--- ${file} ---`);
    const res = spawnSync(process.execPath, [path.join(here, file)], {
        stdio: 'inherit',
        env: { ...process.env, ...env },
    });
    if (res.status !== 0) failures++;
}

fs.rmSync(sandbox, { recursive: true, force: true });

if (failures) {
    console.error(`\n${failures} suite(s) failed`);
    process.exit(1);
}
console.log('\nall suites passed');
