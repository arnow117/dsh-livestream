import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const base = process.argv[2];
if (!base) {
  console.error('Usage: node test/coverage-diff.mjs <baseline-commit>');
  process.exit(1);
}
const baseCommit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const diff = execFileSync('git', ['diff', '--unified=0', baseCommit, '--', 'packages/dsh-livestream/src'], { cwd: root, encoding: 'utf8' });
const changed = new Map();
let file;
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) {
    file = resolve(root, line.slice(6));
    changed.set(file, new Set());
  } else if (line.startsWith('@@') && file) {
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (match) {
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let i = 0; i < count; i++) changed.get(file).add(start + i);
    }
  }
}
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'packages/dsh-livestream/src'], { cwd: root, encoding: 'utf8' });
for (const relative of untracked.split('\n').filter(Boolean)) {
  const path = resolve(root, relative);
  changed.set(path, new Set(readFileSync(path, 'utf8').split('\n').map((_, index) => index + 1)));
}
const coverage = JSON.parse(readFileSync(resolve(root, 'packages/dsh-livestream/coverage/feat-001/coverage-final.json'), 'utf8'));
let linesTotal = 0;
let linesCovered = 0;
let branchesTotal = 0;
let branchesCovered = 0;
for (const [path, lines] of changed) {
  const entry = coverage[path];
  if (!entry) throw new Error(`Missing coverage for ${path}`);
  const lineHits = new Map();
  for (const [id, location] of Object.entries(entry.statementMap)) {
    for (let line = location.start.line; line <= location.end.line; line++) {
      if (lines.has(line)) lineHits.set(line, Math.max(lineHits.get(line) ?? 0, entry.s[id]));
    }
  }
  const covered = [...lineHits.values()].filter((hit) => hit > 0).length;
  let branchCount = 0;
  let branchHits = 0;
  for (const [id, branch] of Object.entries(entry.branchMap)) {
    branch.locations.forEach((location, index) => {
      if (lines.has(location.start.line)) {
        branchCount++;
        if (entry.b[id][index] > 0) branchHits++;
      }
    });
  }
  linesTotal += lineHits.size;
  linesCovered += covered;
  branchesTotal += branchCount;
  branchesCovered += branchHits;
  console.log(`${path.slice(root.length + 1)}: lines ${covered}/${lineHits.size}, branches ${branchHits}/${branchCount}`);
}
if (linesTotal === 0 || branchesTotal === 0) {
  console.error(`No instrumented changed lines or branches (lines: ${linesTotal}, branches: ${branchesTotal}).`);
  process.exit(1);
}
const linePercent = linesCovered / linesTotal * 100;
const branchPercent = branchesCovered / branchesTotal * 100;
console.log(`Changed code: lines ${linesCovered}/${linesTotal} (${linePercent.toFixed(2)}%), branches ${branchesCovered}/${branchesTotal} (${branchPercent.toFixed(2)}%)`);
if (linePercent < 80 || branchPercent < 70) process.exitCode = 1;
