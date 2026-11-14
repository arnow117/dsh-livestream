import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Build input rejection must happen before a previously owned output is changed. */
describe('packaged public-chat build inputs', () => {
  for (const scenario of ['missing', 'symlink', 'new-dependency'] as const) {
    it(`rejects a ${scenario} source before replacing output`, () => {
      const taskRoot = process.env.DSH_PUBLIC_CHAT_FIXTURE_ROOT;
      const builtRoot = process.env.DSH_PUBLIC_CHAT_BUILT_ROOT;
      if (!taskRoot || !builtRoot) throw new Error('isolated build fixture required');
      const root = fs.mkdtempSync(join(taskRoot, 'build-assets-'));
      try {
        fs.mkdirSync(join(root, 'src'), { recursive: true });
        fs.cpSync(join(builtRoot, 'chunks'), join(root, 'src/publicChat'), {
          recursive: true,
          filter(source) {
            const name = source.slice(join(builtRoot, 'chunks').length + 1);
            return !name || !name.endsWith('.js') && !name.endsWith('.map');
          },
        });
        const native = join(root, 'src/registration/nativeCli');
        fs.mkdirSync(native, { recursive: true });
        for (const name of ['registration-native', 'NOTICE.md', 'UPSTREAM-LICENSE']) {
          fs.copyFileSync(resolve('src/registration/nativeCli', name), join(native, name));
        }
        fs.copyFileSync(resolve('build.mjs'), join(root, 'build.mjs'));
        fs.symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
        const asset = join(root, 'src/publicChat/controller.ts');
        if (scenario === 'new-dependency') {
          fs.writeFileSync(join(root, 'src/publicChat/extra.ts'), 'export const fixture = 1;\n');
          fs.appendFileSync(asset, "\nimport './extra';\n");
        } else {
          fs.unlinkSync(asset);
          if (scenario === 'symlink') fs.symlinkSync(resolve('src/publicChat/controller.ts'), asset);
        }
        const output = join(root, 'output');
        fs.mkdirSync(output);
        const sentinel = join(output, 'sentinel');
        fs.writeFileSync(sentinel, 'unchanged');
        let failure = '';
        try {
          execFileSync(process.execPath, ['build.mjs'], {
            cwd: root, env: { ...process.env, DSH_LIVESTREAM_BUILD_OUT: output }, stdio: 'pipe',
          });
        } catch (error) {
          failure = String((error as { stderr?: Buffer }).stderr ?? '');
        }
        expect(failure).toContain(scenario === 'new-dependency' ? 'public chat source closure changed' :
          scenario === 'symlink' ? 'public chat asset path is not canonical' : 'ENOENT');
        expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
