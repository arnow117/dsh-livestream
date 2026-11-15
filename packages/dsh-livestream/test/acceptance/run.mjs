/** Run the installed e2e runner with its project root and output in the task directory. */
import { copyFile, lstat, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.argv.slice(2).includes('--grep')) {
  throw new Error('select one independent scenario with --grep; each invocation needs a fresh task root');
}
const allowedRoot = '/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/feat010-internal-integration-103';
const requestedRoot = process.env.DSH_ACCEPTANCE_ROOT;
if (!requestedRoot) throw new Error('DSH_ACCEPTANCE_ROOT required');
const taskRoot = await realpath(requestedRoot);
const parent = await realpath(allowedRoot);
const within = relative(parent, taskRoot);
if (!within || within.startsWith('..') || within.startsWith('/')) throw new Error('task root is outside the authorized directory');

const dependencies = join(taskRoot, 'node_modules');
const expectedDependencies = await realpath(join(packageDir, 'node_modules'));
try {
  const info = await lstat(dependencies);
  if (!info.isSymbolicLink() || await realpath(dependencies) !== expectedDependencies) {
    throw new Error('task dependency link is not the expected installed dependency directory');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await symlink(expectedDependencies, dependencies, 'dir');
}
await mkdir(join(taskRoot, 'runner-home'), { recursive: true, mode: 0o700 });
await mkdir(join(taskRoot, 'tmp'), { recursive: true, mode: 0o700 });
await copyFile(join(packageDir, 'test/acceptance/acceptance.e2e.ts'), join(taskRoot, 'acceptance.e2e.ts'), constants.COPYFILE_EXCL);
const config = join(taskRoot, 'e2e-run.config.mjs');
const baseUrl = pathToFileURL(join(packageDir, 'e2e-acceptance.config.ts')).href;
await writeFile(config, `import base from ${JSON.stringify(baseUrl)};\nexport default { ...base, tests: 'acceptance.e2e.ts', targets: base.targets.map(target => ({ ...target, app: { ...target.app, command: { ...target.app.command, cwd: ${JSON.stringify(packageDir)}, log: target.name + '.fixture.log' } } })) };\n`, { flag: 'wx' });

const env = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  HOME: join(taskRoot, 'runner-home'),
  TMPDIR: join(taskRoot, 'tmp'),
  PLAYWRIGHT_BROWSERS_PATH: '/Users/mac/Library/Caches/ms-playwright',
  E2E_TELEMETRY_DISABLED: '1',
  DSH_ACCEPTANCE_ROOT: taskRoot,
  DSH_ACCEPTANCE_SENDER_MODE: process.env.DSH_ACCEPTANCE_SENDER_MODE ?? '',
  DSH_ACCEPTANCE_STANDARD_PACKAGE: process.env.DSH_ACCEPTANCE_STANDARD_PACKAGE ?? '',
  DSH_ACCEPTANCE_SDK_ROOT: process.env.DSH_ACCEPTANCE_SDK_ROOT ?? '',
  DSH_ACCEPTANCE_ARTIFACT: process.env.DSH_ACCEPTANCE_ARTIFACT ?? '',
  DSH_ACCEPTANCE_COURSE_ROOT: process.env.DSH_ACCEPTANCE_COURSE_ROOT ?? '',
};
const child = spawn(process.execPath, [join(packageDir, 'node_modules/e2e/dist/cli/bin.js'), 'run', '--config', config, ...process.argv.slice(2)], {
  cwd: taskRoot,
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
