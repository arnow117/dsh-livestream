import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const output = '.e2e/feat-003-correction-1-voice-build';
await mkdir(output, { recursive: true });
await build({ entryPoints: ['test/e2e/client.tsx'], outfile: `${output}/client.js`, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' });
await build({
  entryPoints: ['test/e2e/server.ts'], outdir: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', splitting: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [{
    name: 'fake-audio-io',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/audioProcess$/ }, () => ({ path: 'audio-io', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export async function runAudioProcess(command, args) { globalThis.__audioCalls.push({backend:'macos', command, args}); }
        export async function encodeSpeech(_input, _output, text) { return {audio:new Uint8Array([1,2,3]), words:[]}; }
      ` }));
    },
  }],
});
const child = spawn(process.execPath, [`${output}/server.js`, process.argv[2]], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
