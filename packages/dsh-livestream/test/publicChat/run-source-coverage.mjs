/** Run a source coverage command while binding its report to unchanged input bytes. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [scopeName, reportName, receiptName, separator, ...command] = process.argv.slice(2);
if (!scopeName || !reportName || !receiptName || separator !== '--' || command.length === 0) {
  throw new Error('Usage: node run-source-coverage.mjs <scope> <report> <receipt> -- <command> [args...]');
}
const root = realpathSync(resolve(import.meta.dirname, '../../../..'));
const scopePath = resolve(scopeName);
const reportPath = resolve(reportName);
const receiptPath = resolve(receiptName);
if (existsSync(reportPath) || existsSync(receiptPath)) throw new Error('Coverage output already exists');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function regularFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error(`Unsafe file: ${path}`);
  return readFileSync(path);
}
const scopeBytes = regularFile(scopePath);
const scope = JSON.parse(scopeBytes);
if (scope.version !== 1 || !Array.isArray(scope.files)) throw new Error('Invalid scope');
const members = scope.files.filter((item) => item.kind === 'feature-v8');
if (!members.length || new Set(members.map((item) => item.path)).size !== members.length) throw new Error('Invalid members');
function verifySources() {
  return members.map((item) => {
    const path = resolve(root, item.path);
    if (!path.startsWith(`${root}/packages/dsh-livestream/src/`)) throw new Error(`Invalid member: ${item.path}`);
    const sha256 = digest(regularFile(path));
    if (sha256 !== item.currentSha256) throw new Error(`Source changed: ${item.path}`);
    return { path: item.path, sha256 };
  });
}
const before = verifySources();
const startedAt = new Date().toISOString();
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: process.env });
if (result.error || result.signal || result.status !== 0) {
  throw new Error(`Coverage command failed: ${result.error?.message ?? result.signal ?? result.status}`);
}
const after = verifySources();
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Source changed during coverage run');
const reportBytes = regularFile(reportPath);
const report = JSON.parse(reportBytes);
for (const item of members) {
  const path = resolve(root, item.path);
  if (!report[path] || report[path].path !== path) throw new Error(`Missing or wrong coverage member: ${item.path}`);
}
const receipt = {
  version: 1, scopeSha256: digest(scopeBytes), reportSha256: digest(reportBytes),
  startedAt, finishedAt: new Date().toISOString(), command, cwd: process.cwd(), members: after,
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`source coverage receipt: ${receiptPath}`);
