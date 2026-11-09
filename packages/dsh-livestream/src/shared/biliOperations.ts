import { AsyncLocalStorage } from 'node:async_hooks';

/** Process-local ownership of operations that may use Bilibili or OBS. */
let active = 0;
let epoch = 0;
const context = new AsyncLocalStorage<{ assertCurrent: () => void }>();

export function assertBiliCurrent(): void {
  context.getStore()?.assertCurrent();
}

export function inBiliOperation<T>(lease: { assertCurrent: () => void }, run: () => T): T {
  return context.run(lease, run);
}

export function biliOperationsActive(): boolean {
  return active > 0;
}

export function invalidateTarget(): void {
  epoch++;
}

function beginLease(checkEpoch: boolean): { assertCurrent: () => void; release: () => void } {
  const startedAt = epoch;
  let released = false;
  active++;
  return {
    assertCurrent() {
      if (checkEpoch && startedAt !== epoch) throw new Error('直播目标已变化，旧操作已取消');
    },
    release() {
      if (!released) {
        released = true;
        active--;
      }
    },
  };
}

export function beginBiliOperation(): { assertCurrent: () => void; release: () => void } {
  return beginLease(true);
}

/** Cleanup may finish after disconnect, while its lease still blocks a target change. */
export function beginBiliCleanup(): { assertCurrent: () => void; release: () => void } {
  return beginLease(false);
}
