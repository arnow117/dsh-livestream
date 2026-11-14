/**
 * 受控发送执行纪律：局部网页方法挂起 fixture（FEAT-008 API-4 / P1-02）。
 * 每个 await 窗口替换绑定 → 终止 continuation 且零 Enter；
 * Enter 调用前同步标记；Enter 后异常一律 unknown 类别。
 */
import { describe, expect, it } from 'vitest';
import {
  runGuardedSendChat, BindingLostError, InputResidualError, isPostEnterError, type ChatSessionPort,
} from '../../src/publicChat/guardedSend';

/** 可编排的假页面端口：每个方法都是可挂起/可拒绝的 await 点。 */
class ScriptedPort implements ChatSessionPort {
  readonly calls: string[] = [];
  private readonly script: Map<string, () => Promise<void>> = new Map();
  inputText = '';

  on(step: string, behavior: () => Promise<void>): this {
    this.script.set(step, behavior);
    return this;
  }

  private async step(name: string): Promise<void> {
    this.calls.push(name);
    const behavior = this.script.get(name);
    if (behavior) await behavior();
  }

  async waitForInput(_timeoutMs: number): Promise<void> { await this.step('waitForInput'); }
  async clickInput(): Promise<void> { await this.step('clickInput'); }
  async readInputText(): Promise<string> { await this.step('readInputText'); return this.inputText; }
  async clearInput(): Promise<void> { await this.step('clearInput'); this.inputText = ''; }
  async insertText(text: string): Promise<void> { await this.step('insertText'); this.inputText = text; }
  async pressEnter(): Promise<void> { await this.step('pressEnter'); this.inputText = ''; }
  async wait(_ms: number): Promise<void> { await this.step('wait'); }
}

/** 可控 guard：异步与同步断言各自排队；同步默认通过，除非显式入队失败。 */
class ScriptedGuard {
  readonly assertions: number[] = [];
  private readonly queue: Array<'pass' | 'fail'> = [];
  private readonly syncQueue: Array<'pass' | 'fail'> = [];

  enqueue(...results: Array<'pass' | 'fail'>): this {
    this.queue.push(...results);
    return this;
  }

  enqueueSync(...results: Array<'pass' | 'fail'>): this {
    this.syncQueue.push(...results);
    return this;
  }

  async assertValid(): Promise<void> {
    const result = this.queue.shift() ?? 'pass';
    this.assertions.push(this.assertions.length + 1);
    if (result === 'fail') throw new BindingLostError(false, 'interval-wait');
  }

  assertValidSync(): void {
    const result = this.syncQueue.shift() ?? 'pass';
    this.assertions.push(this.assertions.length + 1);
    if (result === 'fail') throw new BindingLostError(false, 'pre-enter');
  }
}

function port(): ScriptedPort {
  return new ScriptedPort();
}

const BASE_OPTIONS = { text: '大家好', intervalMs: 1, verifyWindowMs: 1 };

describe('Enter 前绑定失效', () => {
  for (const hangStep of ['waitForInput', 'clickInput', 'insertText'] as const) {
    it(`挂起 ${hangStep} 期间替换绑定：终止 continuation，零 Enter，清理不触碰页面`, async () => {
      const scripted = port();
      const guard = new ScriptedGuard();
      // 断言序列：间隔等待前后各一次 → waitForInput 后一次 → click 后一次 →
      // clear 后一次 → insert 后一次。挂起恢复后的第一次断言失败。
      const passCount = { waitForInput: 2, clickInput: 3, insertText: 5 }[hangStep];
      const passes = Array.from({ length: passCount }, () => 'pass' as const);
      guard.enqueue(...passes, 'fail', 'fail');
      scripted.on(hangStep, () => new Promise((resolveHang) => setTimeout(resolveHang, 10)));
      let enterAttempts = 0;
      const error = await runGuardedSendChat(scripted, {
        ...BASE_OPTIONS,
        guard,
        callbacks: { onEnterAttempted: () => { enterAttempts += 1; } },
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(BindingLostError);
      expect((error as BindingLostError).enterAttempted).toBe(false);
      expect(enterAttempts).toBe(0);
      expect(scripted.calls).not.toContain('pressEnter');
      expect(scripted.calls).not.toContain('readInputText');
    });
  }

  it('挂起 clearInput 期间失效：不 Enter，也不做进一步清理输入', async () => {
    const scripted = port();
    const guard = new ScriptedGuard();
    guard.enqueue('pass', 'pass', 'pass', 'pass', 'fail');
    scripted.on('clearInput', () => new Promise((resolveClear) => setTimeout(resolveClear, 10)));
    scripted.inputText = '残留';
    const error = await runGuardedSendChat(scripted, { ...BASE_OPTIONS, guard }).then(null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(BindingLostError);
    expect(scripted.calls.filter((name) => name === 'clearInput').length).toBe(1);
    expect(scripted.calls).not.toContain('pressEnter');
  });

  it('Enter 前最后一次复核失败：pre-enter 阶段拦截，零 Enter', async () => {
    const scripted = port();
    const guard = new ScriptedGuard();
    guard.enqueue('pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'fail');
    const error = await runGuardedSendChat(scripted, { ...BASE_OPTIONS, guard }).then(null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(BindingLostError);
    expect(scripted.calls).not.toContain('pressEnter');
  });
});

describe('Enter 已调用的边界', () => {
  it('Enter Promise 抛错也是 unknown 类别（PostEnterError），不是未派发', async () => {
    const scripted = port();
    scripted.on('pressEnter', async () => { throw new Error('keyboard disconnected'); });
    const error = await runGuardedSendChat(scripted, { ...BASE_OPTIONS, guard: new ScriptedGuard() }).then(null, (caught: unknown) => caught);
    expect(isPostEnterError(error)).toBe(true);
    expect(scripted.calls).toContain('pressEnter');
  });

  it('Enter 后 post-enter 等待期间失效：不再向页面输入，按 unknown 结束', async () => {
    const scripted = port();
    const guard = new ScriptedGuard();
    // 断言 1–7 全部通过（到 pre-enter 为止），Enter 后 post-enter 复核失败。
    guard.enqueue('pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'fail');
    scripted.on('wait', () => new Promise((resolveWait) => setTimeout(resolveWait, 5)));
    const error = await runGuardedSendChat(scripted, { ...BASE_OPTIONS, guard }).then(null, (caught: unknown) => caught);
    expect(isPostEnterError(error)).toBe(true);
    // post-enter 失效后不得再做 read/clear。
    expect(scripted.calls).not.toContain('readInputText');
    expect(scripted.calls.filter((name) => name === 'clearInput').length).toBe(1);
  });

  it('Enter 后输入框残留：清空残留需要再次复核；清空失败按 unknown 抛出', async () => {
    const scripted = port();
    const guard = new ScriptedGuard();
    // 断言 1–8 全部通过（到 post-enter 为止），verify 阶段复核失败 → 不清理。
    guard.enqueue('pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'fail');
    let readCount = 0;
    scripted.on('readInputText', async () => {
      readCount += 1;
      if (readCount === 1) scripted.inputText = '没发出去';
    });
    const error = await runGuardedSendChat(scripted, { ...BASE_OPTIONS, guard }).then(null, (caught: unknown) => caught);
    expect(isPostEnterError(error)).toBe(true);
    expect(scripted.calls.filter((name) => name === 'clearInput').length).toBe(1);
  });

  it('Enter 后残留且复核通过：清理残留并抛 InputResidualError（调用方按 unknown 细化）', async () => {
    const scripted = port();
    let readCount = 0;
    scripted.on('readInputText', async () => {
      readCount += 1;
      if (readCount === 1) scripted.inputText = '没发出去';
    });
    const error = await runGuardedSendChat(scripted, { ...BASE_OPTIONS, guard: new ScriptedGuard() }).then(null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(InputResidualError);
    expect(scripted.calls.filter((name) => name === 'clearInput').length).toBe(2);
  });

  it('正常提交成功：enter_attempted 在 pressEnter 之前标记', async () => {
    const scripted = port();
    const marks: string[] = [];
    scripted.on('pressEnter', async () => { marks.push('press'); });
    const outcome = await runGuardedSendChat(scripted, {
      ...BASE_OPTIONS,
      guard: new ScriptedGuard(),
      callbacks: {
        onEnterAttempted: () => marks.push('attempted'),
        onPhase: (phase) => marks.push(phase),
      },
    });
    expect(outcome).toEqual({ enterAttempted: true, pageSubmitted: true });
    expect(marks.indexOf('attempted')).toBeLessThan(marks.indexOf('press'));
    expect(scripted.calls[scripted.calls.length - 1]).toBe('readInputText');
  });

  it('F3：最终异步 Cookie 复核 await 期间撤权——Enter 前的同步复核拦截，零 Enter', async () => {
    const scripted = port();
    const guard = new ScriptedGuard();
    // 异步断言 1–7 全部通过（pre-enter 的异步 Cookie 摘要也返回通过），
    // 但 await 期间发生撤权：紧随其后的无 await 同步复核失败。
    guard.enqueue('pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass');
    guard.enqueueSync('pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'fail');
    let enterAttempts = 0;
    const error = await runGuardedSendChat(scripted, {
      ...BASE_OPTIONS,
      guard,
      callbacks: { onEnterAttempted: () => { enterAttempts += 1; } },
    }).then(null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(BindingLostError);
    expect((error as BindingLostError).enterAttempted).toBe(false);
    expect(enterAttempts).toBe(0);
    expect(scripted.calls).not.toContain('pressEnter');
  });
});
