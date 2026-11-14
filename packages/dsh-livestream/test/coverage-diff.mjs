import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// The buffer is deliberately bounded: the previous default was too small for
// this repository's source diff. No shell or unbounded child output is used.
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const git = (args, options = {}) => execFileSync('git', args, {
  encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, ...options,
});
const root = git(['rev-parse', '--show-toplevel']).trim();
const [base, reportArg, flag, scopeArg, provenanceFlag, provenanceArg] = process.argv.slice(2);
if (!base || (flag !== undefined && (flag !== '--scope' || !scopeArg || provenanceFlag !== '--provenance' || !provenanceArg)) || process.argv.length > 8) {
  console.error('Usage: node test/coverage-diff.mjs <baseline-commit> [coverage-report] [--scope scope.json --provenance receipt.json]');
  process.exit(1);
}
const baseCommit = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], { cwd: root }).trim();
const sourceRoot = 'packages/dsh-livestream/src';
const sourceDir = resolve(root, sourceRoot);
const changedNames = new Set(git(['diff', '--name-only', '-z', baseCommit, '--', sourceRoot], { cwd: root }).split('\0').filter(Boolean));
for (const name of git(['ls-files', '--others', '--exclude-standard', '-z', '--', sourceRoot], { cwd: root }).split('\0').filter(Boolean)) {
  changedNames.add(name);
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourcePath = (name) => {
  const path = resolve(root, name);
  if (!name.startsWith(sourceRoot + '/') || relative(sourceDir, path).startsWith('..' + sep) || path === sourceDir) {
    throw new Error(`Outside source scope: ${name}`);
  }
  return path;
};
const regularBytes = (path) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error(`Unsafe source file: ${path}`);
  return readFileSync(path);
};
const addedLines = (diff) => {
  const lines = new Set();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('@@')) continue;
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let index = 0; index < count; index++) lines.add(start + index);
  }
  return lines;
};
const diffFiles = (before, after) => {
  try {
    return git(['diff', '--no-index', '--no-ext-diff', '--unified=0', '--', before, after], { cwd: root });
  } catch (error) {
    if (error.status === 1 && typeof error.stdout === 'string') return error.stdout;
    throw error;
  }
};
const changed = new Map();
const excluded = [];
if (scopeArg) {
  const scope = JSON.parse(readFileSync(resolve(root, scopeArg), 'utf8'));
  if (scope.version !== 1 || scope.baseCommit !== baseCommit || !Array.isArray(scope.files)) throw new Error('Invalid scope manifest');
  const names = new Set();
  const requiredShared = new Set(['body/show.ts', 'console/console.tsx', 'core/hub.ts',
    'core/platforms/douyin/douyinSource.ts', 'dsh/index.ts', 'dsh/runtime.ts', 'dsh/agent.ts']
    .map((name) => `${sourceRoot}/${name}`));
  for (const item of scope.files) {
    if (!item || typeof item.path !== 'string' || names.has(item.path) || !changedNames.has(item.path)) throw new Error('Invalid or duplicate scoped path');
    names.add(item.path);
    const path = sourcePath(item.path);
    const isV8 = /\.(?:[cm]?js|tsx?)$/.test(path) && !path.endsWith('.d.ts');
    const required = requiredShared.has(item.path) || (item.path.startsWith(sourceRoot + '/publicChat/') && isV8);
    if (required && item.kind !== 'feature-v8') throw new Error(`Feature source excluded: ${item.path}`);
    if (item.kind !== 'feature-v8') {
      if (!['other-feature', 'feature-non-v8', 'nonruntime'].includes(item.kind) || typeof item.reason !== 'string' || !item.reason ||
        typeof item.evidence !== 'string' || !item.evidence) throw new Error(`Unexplained exclusion: ${item.path}`);
      excluded.push(item);
      continue;
    }
    if (!isV8) throw new Error(`Not a V8 source: ${item.path}`);
    const bytes = regularBytes(path);
    if (digest(bytes) !== item.currentSha256) throw new Error(`Source changed: ${item.path}`);
    let lines;
    if (item.baselineFile === null) {
      try {
        git(['cat-file', '-e', `${baseCommit}:${item.path}`], { cwd: root, stdio: 'pipe' });
        throw new Error(`Existing source needs a baseline: ${item.path}`);
      } catch (error) {
        if (error.status !== 1 && error.status !== 128) throw error;
      }
      lines = new Set(bytes.toString('utf8').split('\n').map((_, index) => index + 1));
    } else {
      if (typeof item.baselineFile !== 'string' || !isAbsolute(item.baselineFile) || !/^[a-f0-9]{64}$/.test(item.baselineSha256 ?? '')) {
        throw new Error(`Invalid baseline: ${item.path}`);
      }
      if (digest(regularBytes(item.baselineFile)) !== item.baselineSha256) throw new Error(`Baseline changed: ${item.path}`);
      lines = addedLines(diffFiles(item.baselineFile, path));
    }
    changed.set(path, lines);
  }
  if (names.size !== changedNames.size || [...changedNames].some((name) => !names.has(name))) {
    throw new Error('Scope does not classify every changed source path');
  }
  for (const name of requiredShared) if (changedNames.has(name) && !names.has(name)) throw new Error(`Missing shared feature path: ${name}`);
  for (const item of excluded) console.log(`EXCLUDED ${item.kind}: ${item.path} — ${item.reason}; evidence: ${item.evidence}`);
} else {
  const diff = git(['diff', '--unified=0', baseCommit, '--', sourceRoot], { cwd: root });
  let file;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = sourcePath(line.slice(6));
      changed.set(file, new Set());
    } else if (line === '+++ /dev/null') {
      file = undefined;
    } else if (line.startsWith('@@') && file) {
      for (const number of addedLines(line)) changed.get(file).add(number);
    }
  }
  for (const name of git(['ls-files', '--others', '--exclude-standard', '-z', '--', sourceRoot], { cwd: root }).split('\0').filter(Boolean)) {
    const path = sourcePath(name);
    changed.set(path, new Set(regularBytes(path).toString('utf8').split('\n').map((_, index) => index + 1)));
  }
}
const report = reportArg ?? 'packages/dsh-livestream/coverage/feat-001/coverage-final.json';
const reportBytes = regularBytes(resolve(root, report));
const coverage = JSON.parse(reportBytes);
if (scopeArg) {
  const scopeBytes = regularBytes(resolve(root, scopeArg));
  const receipt = JSON.parse(regularBytes(resolve(root, provenanceArg)));
  const expectedMembers = JSON.parse(scopeBytes).files.filter((item) => item.kind === 'feature-v8')
    .map((item) => ({ path: item.path, sha256: item.currentSha256 }));
  if (receipt.version !== 1 || receipt.scopeSha256 !== digest(scopeBytes) || receipt.reportSha256 !== digest(reportBytes)
    || JSON.stringify(receipt.members) !== JSON.stringify(expectedMembers)
    || !Array.isArray(receipt.command) || !receipt.command.length || typeof receipt.startedAt !== 'string'
    || typeof receipt.finishedAt !== 'string' || typeof receipt.cwd !== 'string') {
    throw new Error('Coverage provenance mismatch');
  }
  for (const [path] of changed) {
    if (!coverage[path] || coverage[path].path !== path) throw new Error(`Coverage member mismatch: ${path}`);
  }
}
let linesTotal = 0;
let linesCovered = 0;
let branchesTotal = 0;
let branchesCovered = 0;
const missing = [];
for (const [path, lines] of changed) {
  const entry = coverage[path];
  if (!entry) { missing.push(path); console.error(`MISSING coverage: ${path}`); continue; }
  const lineHits = new Map();
  for (const [id, location] of Object.entries(entry.statementMap)) {
    // Match istanbul-lib-coverage's getLineCoverage: statement start line,
    // with the largest hit count for statements sharing that line.
    const line = location.start.line;
    if (lines.has(line)) lineHits.set(line, Math.max(lineHits.get(line) ?? 0, entry.s[id]));
  }
  const covered = [...lineHits.values()].filter((hit) => hit > 0).length;
  let branchCount = 0;
  let branchHits = 0;
  for (const [id, branch] of Object.entries(entry.branchMap)) {
    const decisionLine = branch.line ?? branch.loc?.start.line;
    branch.locations.forEach((location, index) => {
      if (lines.has(decisionLine) || lines.has(location.start.line)) {
        branchCount++;
        if (entry.b[id][index] > 0) branchHits++;
      }
    });
  }
  linesTotal += lineHits.size;
  linesCovered += covered;
  branchesTotal += branchCount;
  branchesCovered += branchHits;
  const uninstrumented = [...lines].filter((line) => !lineHits.has(line)).length;
  console.log(`${relative(root, path)}: lines ${covered}/${lineHits.size}, branches ${branchHits}/${branchCount}; changed lines without V8 statements ${uninstrumented}`);
  if (lines.size && !lineHits.size) { missing.push(path); console.error(`MISSING measurable changed lines: ${path}`); }
}
if (missing.length || linesTotal === 0 || branchesTotal === 0) {
  console.error(`INCONCLUSIVE: missing=${missing.length}, measured lines=${linesTotal}, measured branches=${branchesTotal}`);
  process.exit(1);
}
const linePercent = linesCovered / linesTotal * 100;
const branchPercent = branchesCovered / branchesTotal * 100;
console.log(`Changed code: lines ${linesCovered}/${linesTotal} (${linePercent.toFixed(2)}%), branches ${branchesCovered}/${branchesTotal} (${branchPercent.toFixed(2)}%)`);
if (linePercent < 80 || branchPercent < 70) process.exitCode = 1;
