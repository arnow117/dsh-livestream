/**
 * 受控发送执行纪律（FEAT-008 API-4 / P1-02 修订）。
 *
 * 本模块在原 LiveSession.sendChat 内部队列上执行注入的受控流程：
 * 每个可能改变执行资格的 await 之后、尤其最后一次 await 到 Enter 调用前，
 * 复核原 grant/主体/Context/房间/连接代次。失效即终止原 continuation，
 * 不 Enter，也不得向替换后的页面输入。调用 keyboard.press('Enter') 前
 * 同步标记 enter_attempted；从调用开始即不可撤回，Promise 抛错也由
 * 调用方按 unknown 处理。仅原执行终止且从未 Enter 才是 terminal_not_dispatched。
 */

/** 等待原 Session 发送间隔（与 DyHub CHAT_MIN_INTERVAL 语义一致，本地下限）。 */
export const SEND_MIN_INTERVAL_MS = 3_000;
/** Enter 后留待页面提交的本地观察窗。 */
export const SEND_VERIFY_WINDOW_MS = 500;
const CHAT_INPUT_WAIT_TIMEOUT_MS = 5_000;

/** glue 适配的页面操作端口：每个方法都是 await 点。 */
export interface ChatSessionPort {
  waitForInput(timeoutMs: number): Promise<void>;
  clickInput(): Promise<void>;
  readInputText(): Promise<string>;
  clearInput(): Promise<void>;
  insertText(text: string): Promise<void>;
  pressEnter(): Promise<void>;
  wait(ms: number): Promise<void>;
}

/**
 * 每个 await 后复核原绑定（可含异步取证如 Cookie 摘要）；失效时抛
 * BindingLostError。异步复核不能封闭时序：assertValid 返回后状态仍可能
 * 已变，因此 Enter 前还有一次无 await 的同步复核（assertValidSync）。
 */
export interface SendGuard {
  assertValid(): Promise<void>;
  /** 纯同步复核：撤权/资格/Session/连接/页面房间等进程内事实，无任何 await。 */
  assertValidSync(): void;
}

/** 绑定失效：调用方必须放弃本次 continuation，不 Enter、不清理输入。 */
export class BindingLostError extends Error {
  constructor(readonly enterAttempted: boolean, readonly phase: GuardedSendPhase) {
    super(`send binding lost at phase ${phase}`);
  }
}

/** Enter 后输入框仍有残留：页面未提交成功，由调用方按 unknown 细化。 */
export class InputResidualError extends Error {
  constructor() {
    super('enter 后输入框未清空，弹幕可能未发出（风控 / 需验证 / 超出字数）');
  }
}

export type GuardedSendPhase =
  | 'interval-wait'
  | 'input-wait'
  | 'click'
  | 'clear'
  | 'insert'
  | 'pre-enter'
  | 'enter-attempted'
  | 'post-enter'
  | 'verify';

export interface GuardedSendCallbacks {
  onPhase?(phase: GuardedSendPhase): void;
  /** 在 pressEnter 之前同步调用；调用即代表副作用不可撤回。 */
  onEnterAttempted?(): void;
}

export interface GuardedSendOptions {
  text: string;
  intervalMs?: number;
  verifyWindowMs?: number;
  guard: SendGuard;
  callbacks?: GuardedSendCallbacks;
}

export interface GuardedSendOutcome {
  enterAttempted: boolean;
  pageSubmitted: boolean;
}

/**
 * 受控发送主流程。抛错语义：
 *  - BindingLostError(enterAttempted=false)：原资格失效，未触碰 Enter。
 *  - BindingLostError(enterAttempted=true)：Enter 已调用后失效，一律 unknown。
 *  - InputResidualError：Enter 已调用且页面未清空，unknown。
 *  - 其他异常原样上抛，调用方依据 enterAttempted 标记结算。
 */
export async function runGuardedSendChat(port: ChatSessionPort, options: GuardedSendOptions): Promise<GuardedSendOutcome> {
  const intervalMs = options.intervalMs ?? SEND_MIN_INTERVAL_MS;
  const verifyWindowMs = options.verifyWindowMs ?? SEND_VERIFY_WINDOW_MS;
  const { guard, callbacks } = options;
  const phase = (name: GuardedSendPhase) => callbacks?.onPhase?.(name);
  const check = async (name: GuardedSendPhase) => {
    await guard.assertValid().catch((error: unknown) => {
      throw error instanceof BindingLostError ? error : new BindingLostError(false, name);
    });
    // 异步复核返回后立刻补一次同步复核：撤权/资格/Session/连接是进程内
    // 同步事实，await 窗口内的变化必须在这里被拦截。
    try {
      guard.assertValidSync();
    } catch (error: unknown) {
      throw error instanceof BindingLostError ? error : new BindingLostError(false, name);
    }
  };
  const checkSync = (name: GuardedSendPhase) => {
    try {
      guard.assertValidSync();
    } catch (error: unknown) {
      throw error instanceof BindingLostError ? error : new BindingLostError(false, name);
    }
  };

  phase('interval-wait');
  await check('interval-wait');
  await port.wait(intervalMs);
  await check('interval-wait');

  phase('input-wait');
  await port.waitForInput(CHAT_INPUT_WAIT_TIMEOUT_MS);
  await check('input-wait');

  phase('click');
  await port.clickInput();
  await check('click');

  phase('clear');
  // 上一条没发出去时文字还留在输入框里，先删干净再输入；清理失败即放弃，
  // 不带残留文字进 Enter。
  await port.clearInput();
  await check('clear');

  phase('insert');
  await port.insertText(options.text);
  await check('insert');

  // 最后一次 await 之后：先异步复核，再无 await 的同步复核，然后立即
  // 标记 enter_attempted 并按 Enter。同步复核到 Enter 之间没有任何 await，
  // 撤权（进程内同步状态）不可能在这个窗口内被错过。
  phase('pre-enter');
  await check('pre-enter');
  phase('enter-attempted');
  checkSync('pre-enter');
  callbacks?.onEnterAttempted?.();
  try {
    await port.pressEnter();
  } catch (error: unknown) {
    // Enter 调用已发生，Promise 抛错也是 unknown，不得按未派发结算。
    throw new PostEnterError(error);
  }

  phase('post-enter');
  try {
    await port.wait(verifyWindowMs);
    await check('post-enter');
  } catch (error: unknown) {
    // 失效发生在提交之后：不再向（可能已替换的）页面输入，直接按 unknown 结束。
    if (error instanceof BindingLostError) {
      throw new PostEnterError(error);
    }
    throw error;
  }

  phase('verify');
  let residual: string;
  try {
    residual = await port.readInputText();
  } catch (error: unknown) {
    throw new PostEnterError(error);
  }
  if (residual.trim().length > 0) {
    // 提交未生效：尝试清掉残留文字，避免文字留在页面里被页面补发；
    // 清理前同样复核绑定（异步+同步），失效则放弃清理（不向替换页面输入）。
    try {
      await check('verify');
      checkSync('verify');
      await port.clearInput();
    } catch (error: unknown) {
      if (error instanceof BindingLostError) throw new PostEnterError(error);
      throw error;
    }
    throw new InputResidualError();
  }
  return { enterAttempted: true, pageSubmitted: true };
}

/** Enter 调用之后发生的异常；调用方一律按 unknown 结算，不得视为未派发。 */
export class PostEnterError extends Error {
  constructor(readonly cause: unknown) {
    super('异常发生在 Enter 调用之后，结果未知');
  }
}

/** 判定异常是否属于「Enter 已调用」类别。 */
export function isPostEnterError(error: unknown): error is PostEnterError {
  return error instanceof PostEnterError;
}
