import { mergeQuerySettings } from '../shared/readOnlyQuery';
import { validateSessionContextSaveRequest, type SessionContextRecord, type SessionContextStateView } from '../shared/sessionContext';
import {
  SESSION_CONTEXT_ISSUE_TEXT,
  currentRecord,
  readSnapshot,
  refreshHealth,
  recheckSessionContext,
  snapshotForSession,
  stateView as sessionContextStateView,
  setResumeNote,
  validateSaveCandidate,
  verifyManagedOnair,
} from './sessionContext';
import { createManagedSession } from './sessionContextSessions';
import { resolveQueryCredential } from './queryCredential';
import { queryTurns, type QueryTurn } from './queryTurns';
/**
 * dsh-livestream 根插件（宿主端）：开舞台服务器，给控制台（网页端 client.tsx）用的路由。
 *
 *   GET  /api/dsh-livestream/state      直播状态、设置、舞台地址、能选的角色和模板
 *   POST /api/dsh-livestream/settings   改设置（房间号、角色、模板、音色……）
 *   POST /api/dsh-livestream/connect    连直播间（用 DSH 凭据里的 B 站 Cookie）    /disconnect 断开
 *   POST /api/dsh-livestream/onair      开播 { sessionId }：她直播用的会话（控制台开好的），身体先推开场    /offair 下播（先道别）
 *   POST /api/dsh-livestream/owner      主人跟她说话（排在弹幕前面）
 *   POST /api/dsh-livestream/simulate   模拟观众：不开直播间也能试（弹幕、礼物、进场……）
 *   GET  /api/dsh-livestream/events     控制台的事件流（SSE）：直播间事件、她说的话、大脑状态
 *
 * 盯她的会话、念她说的话、往会话里推事情的部分在 agent 子插件（./agent.ts），挂在「大肥鱼直播」预设下。
 */

import { checkObs, connectObs } from '../body/obs';
import { pollQrLogin, startQrLogin, whoIs } from '../body/biliLogin';
import { SIMULATED_PREFIX } from '../body/show';
import type { LiveEvent, LiveUser } from '../core/live';
import type { GameSource, StageEvent } from '../stage/protocol';
import { splitByMood } from '../core/moodText';
import { speakable } from '../core/speakable';
import { GUEST_VOICE } from '../body/voices';
import { mergeTtsSettings } from '../shared/ttsSettings';
import { parseDouyinRoomId } from '../shared/liveTarget';
import { assertBiliCurrent, beginBiliOperation, biliOperationsActive, inBiliOperation, invalidateTarget } from '../shared/biliOperations';
import { normalizeDouyinBridgeUrl } from '../core/platforms/douyin/douyinSource';
import { DouyinRoomControl } from './douyinRoomControl';
import type { RoomControlSnapshot } from '../shared/roomControl';
import { agentReady, asr, broadcast, cookie, dataDir, DEFAULT_BOARD, DOUYIN_BOARD, hooks, localRehearsal, placeGame, publishBoard, publishNotice, SECRETS, sessionTools, social, takeLive, currentCharacter, currentMoods, dm, packs, prepareSpeech, previewSpeech, queryServiceStatus, server, settings, show, updateSettings, type BlockedViewer, type Pace, type Settings } from './runtime';

export const name = 'dsh-livestream';
export const inject = ['connection'];

interface HostContext {
  effect(effect: () => () => void, label?: string): unknown;
  get?(name: string): any;
  [service: string]: any;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (message: string, status = 400) => json({ ok: false, error: message }, status);
function makeRoomControlSnapshot(roomControl: DouyinRoomControl): RoomControlSnapshot {
  const platform = settings.livePlatform;
  return {
    controlRevision: roomControl.revision,
    target: { platform, roomId: platform === 'douyin' ? settings.douyinRoomId || null : settings.roomId },
    bridge: 'unknown',
    collector: 'unknown',
    subscription: show.status().live.state,
    operation: roomControl.operation,
    targetLocked: roomControl.locked || show.isOnAir || !!show.hub.currentConfig || biliOperationsActive() || broadcast.hasActivity,
    ...(roomControl.locked ? { lockReason: '采集操作尚未完成或结果未确认' } : {}),
  };
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

async function controlBody<T>(request: Request): Promise<T | null> {
  if (!request.body) return {} as T;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (!raw.trim()) return {} as T;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function makeState(roomControl: DouyinRoomControl) {
  let douyinBridgeUrl: string;
  try {
    douyinBridgeUrl = normalizeDouyinBridgeUrl(process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL ?? 'http://127.0.0.1:8757');
  } catch {
    douyinBridgeUrl = '采集地址无效，请检查部署配置';
  }
  return {
    ok: true,
    show: show.status(),
    broadcast: broadcast.status(),
    settings: { ...settings, ...(localRehearsal ? { broadcast: false } : {}), stageToken: undefined, sessionContext: undefined },
    runtime: { localRehearsal, ttsBackend: settings.tts.backend },
    douyinBridgeUrl,
    roomControl: makeRoomControlSnapshot(roomControl),
    // FEAT-006：显式去掉内部 bindings，owner 只见 saved/config/health/active 视图
    sessionContext: sessionContextStateView() as SessionContextStateView,
    stageUrl: server.url,
    characters: packs.list('characters'),
    templates: packs.list('templates'),
    asr: { available: asr.available },
    defaultBoard: DEFAULT_BOARD,
    douyinDefaultBoard: DOUYIN_BOARD,
  };
}

/** dsh-game 给的画面来源：只认约定里的两种，别的当没有 */
/** 控制台填的节奏：空的项删掉（回到自动），秒数夹在 0～600，一次回几位 1～5，欢迎可以填 off */
function cleanPace(raw: Record<string, unknown>): Pace {
  const sec = (v: unknown) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Math.max(0, Math.min(600, Math.round(Number(v)))));
  const welcome = raw.welcomeSec === 'off' ? 'off' : sec(raw.welcomeSec);
  const thanks = sec(raw.thanksSec), follow = sec(raw.followSec);
  const picks = sec(raw.chatPicks);
  return {
    ...(welcome !== undefined ? { welcomeSec: welcome } : {}),
    ...(thanks !== undefined ? { thanksSec: thanks } : {}),
    ...(follow !== undefined ? { followSec: follow } : {}),
    ...(picks !== undefined ? { chatPicks: Math.max(1, Math.min(5, picks)) } : {}),
  };
}

/** 控制台填的黑名单：UID 是数字串；同一个 UID 只留一条 */
function cleanBlocked(raw: unknown): BlockedViewer[] {
  const out = new Map<string, BlockedViewer>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const b = item as Partial<BlockedViewer>;
    const uid = String(b.uid ?? '').trim();
    if (!/^\d{1,20}$/.test(uid)) continue;
    out.set(uid, { uid, name: String(b.name ?? '').trim().slice(0, 40), why: String(b.why ?? '').trim().slice(0, 200), at: Number(b.at) || Date.now() });
  }
  return [...out.values()];
}

function gameSource(value: unknown): GameSource | null {
  const v = value as { url?: unknown; window?: unknown; overlay?: unknown } | null;
  const web = (x: unknown): x is string => typeof x === 'string' && /^https?:\/\//.test(x);
  if (v && web(v.url)) return { url: v.url };
  if (v && typeof v.window === 'string' && v.window) return { window: v.window, ...(web(v.overlay) ? { overlay: v.overlay } : {}) };
  return null;
}

let simSeq = 0;
/** 模拟观众：控制台里填的名字和文字 → 一条直播事件 */
function simulated(input: { kind?: string; name?: string; text?: string; gift?: string; count?: number; yuan?: number; guard?: number }): LiveEvent | null {
  const name = (input.name ?? '').trim() || '模拟观众';
  const user: LiveUser = { id: `${SIMULATED_PREFIX}${name}`, name, ...(input.guard ? { guardLevel: input.guard } : {}) };
  const base = { id: `sim-${Date.now()}-${++simSeq}`, platform: settings.livePlatform, ts: Date.now(), user };
  switch (input.kind) {
    case 'chat': return input.text?.trim() ? { ...base, kind: 'chat', text: input.text.trim() } : null;
    case 'gift': return { ...base, kind: 'gift', giftName: input.gift || '小花花', count: input.count ?? 1, valueYuan: settings.livePlatform === 'douyin' ? 0 : input.yuan ?? 0.1, ...(settings.livePlatform === 'douyin' ? { valueKnown: false } : {}) };
    case 'superchat': return settings.livePlatform === 'bilibili' && input.text?.trim() ? { ...base, kind: 'superchat', text: input.text.trim(), valueYuan: input.yuan ?? 30 } : null;
    case 'membership': return settings.livePlatform === 'douyin' ? null : { ...base, kind: 'membership', levelName: '舰长', level: 3, count: 1, valueYuan: 138 };
    case 'enter': return { ...base, kind: 'enter' };
    case 'follow': return { ...base, kind: 'follow' };
    default: return null;
  }
}

/** 下播后等她道别说完再停推 */
let waitingOffair: NodeJS.Timeout | null = null;
/** 舞台的谢幕画面放多久（stage/store.ts 的 ENDING_MS 是 16 秒）：放完再停推流 */
const ENDING_SCENE_MS = 17_000;

/** 断多久以内算重启（接着播）；更久就当上一场已经结束了 */
const RESUME_WITHIN_MS = 10 * 60_000;

/**
 * 插件起来时，上次停下的那一场还没收尾：恢复她的会话（DSH 的 sessionController 从磁盘接回来，
 * 她的 agent 起来以后推消息、念话的那套也就接上了）、重连直播间、接上还在推的 OBS，告诉她断了多久。
 */
async function resumeLive(ctx: HostContext, stopped: () => boolean): Promise<void> {
  if (localRehearsal || settings.livePlatform !== 'bilibili') return;
  const lease = beginBiliOperation();
  try {
    await inBiliOperation(lease, async () => {
      const saved = takeLive();
      if (!saved || saved.platform === 'douyin' || typeof saved.roomId === 'string') return;
      // FEAT-006：管理会话显式跳过自动恢复；旧安装未使用新增配置时保留原恢复行为
      if (currentRecord() || readSnapshot(saved.sessionId).ok) {
        setResumeNote('已恢复直播会话设置，请手动开始新会话');
        show.closeStale(saved);
        return;
      }
      if (Date.now() - saved.at > RESUME_WITHIN_MS) {
        show.closeStale(saved);
        return;
      }
      // DSH 的服务和她的 agent 要一会儿才起来：最多等一分钟
      const deadline = Date.now() + 60_000;
      let resumed = false;
      while (!stopped() && Date.now() < deadline) {
        assertBiliCurrent();
        const controller = ctx.get?.('sessionController');
        if (controller?.agents?.resolveAgent) {
          const result = await controller.agents.resolveAgent(saved.sessionId).catch((err: Error) => ({ error: err }));
          if (!('error' in result)) { resumed = true; break; }
          console.warn(`[dsh-livestream] 恢复她的会话失败：${String(result.error?.message ?? result.error)}`);
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!resumed || stopped()) {
        show.closeStale(saved);
        return;
      }
      // 游戏线的会话也要接回来（不然交给它的话一直送不出去，游戏也开不回来）；接不回来就这场不用游戏线
      if (saved.gameSessionId) {
        assertBiliCurrent();
        const controller = ctx.get?.('sessionController');
        const result = await controller.agents.resolveAgent(saved.gameSessionId).catch((err: Error) => ({ error: err }));
        if ('error' in result) {
          console.warn(`[dsh-livestream] 恢复游戏线的会话失败：${String(result.error?.message ?? result.error)}`);
          saved.gameSessionId = undefined;
          saved.playing = undefined;
        }
      }
      // 等 agent 子插件把推消息的钩子装上
      while (!stopped() && Date.now() < deadline && !agentReady()) await new Promise((r) => setTimeout(r, 500));
      assertBiliCurrent();
      if (saved.roomId) show.connect(saved.roomId, await cookie(), settings.ownRooms.includes(saved.roomId));
      assertBiliCurrent();
      show.resumeLive(saved);
      if (saved.broadcasting && saved.roomId) await broadcast.adopt(saved.roomId);
      assertBiliCurrent();
      const pushing = saved.broadcasting ? `，推流${broadcast.streaming ? '接上了' : '没接上（OBS 已经不在推了）'}` : '（彩排，没在推流）';
      console.warn(`[dsh-livestream] 接着播：会话 ${saved.sessionId}，断了 ${Math.round((Date.now() - saved.at) / 1000)} 秒${pushing}`);
    });
  } finally {
    lease.release();
  }
}

function cancelNativeQueryTurn(lease: QueryTurn): void {
  const agent = lease.agent as {
    status?: string;
    session?: { snapshotEvents(): Array<{ type: string; data?: { turn?: number } }> };
    cancel?: (cause: { kind: 'user' }, options: { keepInbox: true }) => void;
  };
  if (agent.status !== 'running' || !agent.session || !agent.cancel || lease.callerSignal.aborted) return;
  try {
    const events = agent.session.snapshotEvents();
    const lastStart = events.findLastIndex((event) => event.type === 'turn/start');
    if (lastStart < 0 || events[lastStart].data?.turn !== lease.turn) return;
    if (events.slice(lastStart + 1).some((event) => event.type === 'turn/end' && event.data?.turn === lease.turn)) return;
    agent.cancel({ kind: 'user' }, { keepInbox: true });
  } catch {
    // Local output is already invalidated; an unavailable native session must
    // not authorize cancelling a different turn or undo that invalidation.
  }
}

export function apply(ctx: HostContext): void {
  const roomControl = new DouyinRoomControl(dataDir);
  const roomControlSnapshot = () => makeRoomControlSnapshot(roomControl);
  const state = () => makeState(roomControl);
  ctx.effect(() => () => roomControl.dispose(), 'dsh-livestream room control');
  ctx.effect(() => {
    const secret = async (name: string) => {
      const credentials = ctx.get?.('credentials');
      const hit = credentials ? await credentials.resolve(name).catch(() => undefined) : undefined;
      return hit?.value ?? process.env[name] ?? '';
    };
    const setSecret = async (name: string, value: string) => {
      const credentials = ctx.get?.('credentials');
      if (!credentials?.set) throw new Error('这个 DSH 没有凭据服务，存不了');
      await credentials.set(name, value);
    };
    const offReference = ctx.on?.('credentials/reference-updated', (ref: string) => {
      if (ref === 'GLM_CODING_PLAN_API_KEY') queryTurns.invalidateAll();
    });
    const offRecord = ctx.on?.('credentials/record-updated', () => queryTurns.invalidateAll());
    hooks.secret = secret;
    hooks.setSecret = setSecret;
    return () => {
      offReference?.();
      offRecord?.();
      if (hooks.secret === secret) hooks.secret = async (name) => process.env[name] ?? '';
      if (hooks.setSecret === setSecret) hooks.setSecret = async () => { throw new Error('这个 DSH 没有凭据服务，存不了'); };
    };
  }, 'dsh-livestream credentials');
  ctx.effect(() => {
    server.start().catch((err) => console.warn(`[dsh-livestream] 舞台服务器起不来（端口 ${settings.stagePort}）：${(err as Error).message}`));
    return () => server.stop();
  }, 'dsh-livestream stage server');
  ctx.effect(() => () => show.dispose(), 'dsh-livestream show');
  // 断点续播：上次停下时还在播（DSH 重启、更新插件），接着播
  ctx.effect(() => {
    let stopped = false;
    void resumeLive(ctx, () => stopped).catch((err) => console.warn(`[dsh-livestream] 接着播失败：${(err as Error).message}`));
    return () => { stopped = true; };
  }, 'dsh-livestream resume');
  ctx.effect(() => () => asr.close(), 'dsh-livestream asr');
  // 直播身体：给 dsh-game 用（约定见 docs/game-live-contract.md）。在播时她的话由这里念、游戏画面由这里放上舞台
  ctx.provide('liveBody', {
    get onAir() { return show.isOnAir; },
    attention: (signal: AbortSignal) => show.waitAttention(signal),
    showGame: (source: unknown) => show.showGame(gameSource(source)),
  });
  ctx.effect(() => () => show.showGame(null), 'dsh-livestream game screen');

  const biliRoutes = new Set(['account', 'login start', 'login poll', 'broadcast start', 'broadcast stop', 'obs check']);
  const route = (path: string, methods: string[], handler: (request: Request) => Response | Promise<Response>, label: string) =>
    ctx.effect(() => ctx.connection.fetch.register({
      path, methods, requestBody: 'buffered',
      fetch: async (request: Request) => {
        if (!biliRoutes.has(label)) return handler(request);
        if (settings.livePlatform !== 'bilibili' || localRehearsal) {
          if (label === 'account') return json({ ok: true, account: null });
          return fail('当前模式不使用 B 站或 OBS');
        }
        const lease = beginBiliOperation();
        try {
          const response = await inBiliOperation(lease, () => handler(request));
          if (label !== 'broadcast stop') lease.assertCurrent();
          return response;
        } finally {
          lease.release();
        }
      },
    }), label);

  route('/api/dsh-livestream/state', ['GET'], async () => {
    const credential = await resolveQueryCredential(ctx.get?.('credentials'), process.env.GLM_CODING_PLAN_API_KEY);
    return json({ ...state(), queryCredential: credential.status, queryService: queryServiceStatus });
  }, 'state');

  route('/api/dsh-livestream/room-control', ['GET'], async () => {
    const snapshot = roomControlSnapshot();
    if (snapshot.target.platform === 'douyin' || roomControl.hasJournal) {
      const result = await roomControl.query(snapshot.target.platform === 'douyin' ? String(snapshot.target.roomId ?? '') : '');
      const current = roomControlSnapshot();
      if (current.controlRevision !== snapshot.controlRevision) return json({ ok: true, roomControl: current });
      Object.assign(current, result);
      return json({ ok: true, roomControl: current });
    }
    return json({ ok: true, roomControl: snapshot });
  }, 'room control');

  route('/api/dsh-livestream/settings', ['POST'], async (request) => {
    const patch = await controlBody<Partial<Settings> & { controlRevision?: unknown }>(request);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return fail('设置无效');
    const next: Partial<Settings> = {};
    if (patch.livePlatform !== undefined) {
      if (patch.livePlatform !== 'bilibili' && patch.livePlatform !== 'douyin') return fail('直播平台无效');
      next.livePlatform = patch.livePlatform;
    }
    if (patch.douyinRoomId !== undefined) {
      try { next.douyinRoomId = parseDouyinRoomId(patch.douyinRoomId); }
      catch { return fail('请输入抖音数字房间号或完整直播间地址'); }
    }
    if (patch.roomId !== undefined) {
      const room = Number(patch.roomId);
      if (!Number.isSafeInteger(room) || room <= 0) return fail('房间号要是正整数');
      next.roomId = room;
    }
    if (patch.character !== undefined) {
      if (!packs.character(String(patch.character))) return fail('没有这个角色包');
      next.character = String(patch.character);
    }
    if (patch.template !== undefined) {
      if (!packs.template(String(patch.template))) return fail('没有这个模板');
      next.template = String(patch.template);
    }
    if (patch.voice !== undefined) next.voice = String(patch.voice).trim();
    if (patch.tts !== undefined) {
      try {
        next.tts = mergeTtsSettings(settings.tts, patch.tts);
        if (next.voice !== undefined && Object.hasOwn(patch.tts, 'doubaoVoice') && next.tts.doubaoVoice !== next.voice) return fail('音色设置冲突');
        if (next.voice !== undefined && !Object.hasOwn(patch.tts, 'doubaoVoice')) next.tts.doubaoVoice = next.voice;
      } catch {
        return fail('声音设置无效');
      }
    }
    if (patch.readOnlyQueries !== undefined) {
      try { next.readOnlyQueries = mergeQuerySettings(settings.readOnlyQueries, patch.readOnlyQueries); }
      catch { return fail('查询设置无效'); }
    }
    if (patch.idleAfterSec !== undefined) next.idleAfterSec = Math.max(10, Math.min(600, Number(patch.idleAfterSec) || 45));
    if (patch.gameChatGapSec !== undefined) next.gameChatGapSec = Math.max(5, Math.min(120, Number(patch.gameChatGapSec) || 15));
    if (patch.pace !== undefined) next.pace = cleanPace({ ...settings.pace, ...patch.pace });
    if (patch.distillModel !== undefined) next.distillModel = String(patch.distillModel).trim() || settings.distillModel;
    if (patch.broadcast !== undefined) next.broadcast = !!patch.broadcast;
    if (patch.areaId !== undefined) next.areaId = patch.areaId ? Number(patch.areaId) : null;
    if (patch.liveTitle !== undefined) next.liveTitle = String(patch.liveTitle).slice(0, 40);
    if (patch.liveCover !== undefined) next.liveCover = String(patch.liveCover).trim().replace(/^"|"$/g, '');
    if (patch.pushProtocol !== undefined) next.pushProtocol = patch.pushProtocol === 'rtmp' ? 'rtmp' : 'srt';
    if (patch.streamKbps !== undefined) next.streamKbps = Math.max(1000, Math.min(12000, Number(patch.streamKbps) || 4500));
    if (patch.asrPython !== undefined) next.asrPython = String(patch.asrPython).trim().replace(/^"|"$/g, '');
    if (patch.asrModel !== undefined) next.asrModel = String(patch.asrModel).trim() || 'large-v3-turbo';
    if (patch.boardText !== undefined) next.boardText = String(patch.boardText).replace(/\r/g, '').slice(0, 1000);
    if (patch.noticeText !== undefined) next.noticeText = String(patch.noticeText).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (patch.blocked !== undefined) next.blocked = cleanBlocked(patch.blocked);
    // FEAT-006：整组替换的会话上下文保存；同一请求混其他设置时任一字段无效则整体不提交
    let sessionContextRecord: SessionContextRecord | undefined;
    const rawSessionContext = (patch as { sessionContext?: unknown }).sessionContext;
    if (rawSessionContext !== undefined) {
      const validated = validateSessionContextSaveRequest(rawSessionContext);
      if (!validated.ok) {
        return json({ ok: false, error: SESSION_CONTEXT_ISSUE_TEXT[validated.issue.code] ?? validated.issue.code, issue: validated.issue }, 400);
      }
      const candidate = await validateSaveCandidate(validated.request);
      if (!candidate.ok) {
        return json({ ok: false, error: candidate.error, ...(candidate.issue ? { issue: candidate.issue } : {}) }, candidate.status);
      }
      // 最终同步临界区：再次比较 context revision；updateSettings 从当时最新 settings 合并 patch
      const current = currentRecord();
      const expected = validated.request.expectedRevision;
      if (!current) {
        if (expected !== 0) return json({ ok: false, error: '设置已变化，请刷新后重试', code: 'revision_conflict' }, 409);
      } else if (current.kind === 'saved') {
        if (current.record.revision !== expected) return json({ ok: false, error: '设置已变化，请刷新后重试', code: 'revision_conflict' }, 409);
      }
      // 损坏记录：显式替换即可恢复，不比较 revision
      sessionContextRecord = { ...candidate.record, revision: (current && current.kind === 'saved' ? current.record.revision : 0) + 1 };
    }
    const own = (patch as { ownRoom?: boolean }).ownRoom;
    if (own !== undefined && settings.roomId) {
      const rooms = new Set(settings.ownRooms);
      if (own) rooms.add(settings.roomId); else rooms.delete(settings.roomId);
      next.ownRooms = [...rooms];
    }
    const targetChanged = (next.livePlatform !== undefined && next.livePlatform !== settings.livePlatform)
      || (next.douyinRoomId !== undefined && next.douyinRoomId !== settings.douyinRoomId)
      || (next.roomId !== undefined && next.roomId !== settings.roomId);
    if (targetChanged && !roomControl.matches(patch.controlRevision)) {
      return json({ ok: false, error: '房间设置已变化，请刷新后重试', roomControl: roomControlSnapshot() }, 409);
    }
    if (targetChanged && (roomControl.locked || show.isOnAir || show.hub.currentConfig || biliOperationsActive() || broadcast.hasActivity)) {
      return fail('请先停止舞台、断开订阅，并等待旧操作和清理完成', 409);
    }
    if ((next.livePlatform ?? settings.livePlatform) === 'douyin'
      && (patch.blocked !== undefined || own !== undefined || patch.broadcast === true)) {
      return fail('抖音只读接入不支持 B 站账号或推流设置');
    }
    const repaint = (next.character && next.character !== settings.character) || (next.template && next.template !== settings.template);
    // 换了 Python 或模型：关掉正在跑的识别进程，下次用新的
    const resetAsr = (next.asrPython !== undefined && next.asrPython !== settings.asrPython) || (next.asrModel !== undefined && next.asrModel !== settings.asrModel);
    if (sessionContextRecord !== undefined) next.sessionContext = sessionContextRecord;
    try {
      updateSettings(next);
    } catch {
      return fail('保存设置失败', 500);
    }
    if (sessionContextRecord !== undefined) await refreshHealth();
    if (targetChanged) {
      roomControl.advance();
      invalidateTarget();
      show.setPlatform(settings.livePlatform);
      publishBoard();
    }
    if (resetAsr) asr.close();
    if (own !== undefined && settings.roomId) show.rememberViewers = own && show.status().roomId === settings.roomId;
    if (next.boardText !== undefined) publishBoard();
    if (next.noticeText !== undefined) publishNotice();
    if (next.character) show.setNames(currentCharacter()?.names ?? []);
    if (repaint) show.stage.broadcast({ type: 'reload' });
    // 换了主题，游戏位可能挪了：OBS 里的游戏画面跟着挪
    if (next.template && show.gameSource) placeGame(show.gameSource);
    return json(state());
  }, 'settings');

  // FEAT-006：owner 显式重查（不保存、不创建会话）；最多每秒一次、单在途
  route('/api/dsh-livestream/session-context/recheck', ['POST'], async () => {
    const result = await recheckSessionContext();
    if (!result.ok) return json({ ok: false, error: result.note ?? '暂时不能重查' }, 429);
    return json(state());
  }, 'session context recheck');

  // FEAT-006：控制台显式新会话（管理路径）；输入仅 {workspaceId?}
  route('/api/dsh-livestream/sessions', ['POST'], async (request) => {
    const input = await controlBody<{ workspaceId?: unknown }>(request);
    if (!input) return fail('新会话请求无效');
    const outcome = await createManagedSession(ctx, { workspaceId: input.workspaceId, platform: settings.livePlatform });
    if (!outcome.ok) {
      const response: Record<string, unknown> = { ok: false, error: outcome.error };
      const current = sessionContextStateView();
      if (outcome.status === 409 || outcome.status === 503) response.sessionContext = current;
      return json(response, outcome.status);
    }
    // 创建完成立即按 Agent ctx 注册受限工具（首次工具集合解析前完成）；绑定入口由 agent 子插件经运行时回调提供
    const agents = ctx.get?.('agents');
    const found = typeof agents?.get === 'function' ? agents.get(outcome.sessionId) : undefined;
    const agent = found?.session ? found : found?.agent;
    if (!agent || !sessionTools.bind?.(agent)) {
      return json({ ok: false, error: '会话已创建，但受限工具绑定失败；本场不能使用 Skill 与资料，请重新创建会话', sessionId: outcome.sessionId, sessionContext: outcome.sessionContext }, 409);
    }
    return json({ ok: true, sessionId: outcome.sessionId, sessionContext: outcome.sessionContext, state: state() });
  }, 'sessions');

  route('/api/dsh-livestream/query/cancel', ['POST'], async (request) => {
    const input = await controlBody<{ sessionId?: unknown; queryId?: unknown }>(request);
    if (!input || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 256
      || typeof input.queryId !== 'string' || !input.queryId || input.queryId.length > 128) return fail('查询身份无效');
    const epoch = show.stage.outputEpoch;
    if (!epoch || show.currentSession !== input.sessionId || show.status().query?.queryId !== input.queryId) return fail('查询已变化，请刷新后重试', 409);
    const result = queryTurns.cancel(input.sessionId, input.queryId, epoch);
    if (!result) return fail('查询已变化，请刷新后重试', 409);
    if (!result.alreadyCancelled) cancelNativeQueryTurn(result.lease);
    return json(state());
  }, 'query cancel');

  route('/api/dsh-livestream/tts/preview', ['POST'], async (request) => {
    const patch = await body<{ text?: unknown; tts?: unknown } | null>(request);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || typeof patch.text !== 'string') return fail('试听文字无效');
    const text = patch.text.trim();
    const characters = [...text];
    const malformed = characters.some((character) => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff);
    if (!text || malformed || characters.length > 200) return fail('试听文字须为 1 至 200 个字');
    let tts;
    try {
      tts = mergeTtsSettings(settings.tts, patch.tts === undefined ? {} : patch.tts);
    } catch {
      return patch.tts === undefined ? fail('声音配置不可用，请在设置中修正', 503) : fail('声音设置无效');
    }
    if (tts.backend === 'yovoice' && (!process.env.YOVOICE_URL || !process.env.YOVOICE_API_TOKEN || !['voxcpm2-q8', 'voxcpm2-bf16'].includes(tts.yovoiceModel))) return fail('yovoice 配置不可用', 503);
    const timeout = AbortSignal.timeout(90_000);
    try {
      const result = await previewSpeech(text, AbortSignal.any([request.signal, timeout]), tts);
      if (!result) return fail('未配置该音色所需的凭据', 503);
      request.signal.throwIfAborted();
      return new Response(new Uint8Array(result.audio), { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
    } catch {
      if (timeout.aborted) return fail('试听超时', 504);
      if (request.signal.aborted) throw request.signal.reason;
      return fail('语音服务不可用，请检查配置后重试', 502);
    }
  }, 'tts preview');

  let connectInFlight = false;
  let pendingBiliConnect: { id: string; revision: string } | null = null;
  route('/api/dsh-livestream/connect', ['POST'], async (request) => {
    const input = await controlBody<{ controlRevision?: unknown; action?: unknown; connectId?: unknown }>(request);
    if (!input) return fail('连接请求无效');
    if (!roomControl.matches(input.controlRevision)) return json({ ok: false, error: '房间状态已变化，请刷新后重试', roomControl: roomControlSnapshot() }, 409);
    if (input.action !== undefined && input.action !== 'connect' && input.action !== 'retry') return fail('连接操作无效');
    if (input.connectId !== undefined && (typeof input.connectId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(input.connectId))) return fail('连接标识无效');
    if (connectInFlight) return fail('连接正在进行，请稍候', 409);
    const terminalRetry = settings.livePlatform === 'douyin' && input.action === 'retry' && show.status().live.state === 'error';
    if (show.hub.currentConfig && !terminalRetry) return fail('请先断开当前订阅', 409);
    if (settings.livePlatform === 'douyin') {
      if (!settings.douyinRoomId) return fail('先填抖音房间号');
      try {
        const roomId = settings.douyinRoomId;
        await roomControl.connect(roomId, (bridgeUrl) => new Promise((resolve) => {
          if (terminalRetry) show.hub.disconnect();
          show.connectTarget({ platform: 'douyin', roomId, bridgeUrl, onInitialized: resolve });
        }));
      } catch (error) { return json({ ok: false, error: (error as Error).message, roomControl: roomControlSnapshot() }, roomControl.locked ? 409 : 502); }
    } else {
      if (localRehearsal) return fail('本地彩排模式不连接 B 站');
      if (!settings.roomId) return fail('先填直播间房间号');
      if (roomControl.locked) return fail('采集操作尚未确认，不能切换目标', 409);
      const pending = typeof input.connectId === 'string' && typeof input.controlRevision === 'string'
        ? { id: input.connectId, revision: input.controlRevision } : null;
      pendingBiliConnect = pending;
      roomControl.advance();
      const lease = beginBiliOperation();
      connectInFlight = true;
      try {
        const currentCookie = await cookie();
        lease.assertCurrent();
        show.connect(settings.roomId, currentCookie, settings.ownRooms.includes(settings.roomId));
      } catch {
        return fail('连接已取消，请重新连接', 409);
      } finally {
        connectInFlight = false;
        if (pendingBiliConnect === pending) pendingBiliConnect = null;
        lease.release();
      }
    }
    return json(state());
  }, 'connect');

  route('/api/dsh-livestream/disconnect', ['POST'], async (request) => {
    const input = await controlBody<{ controlRevision?: unknown; cancelConnectId?: unknown }>(request);
    if (!input) return fail('断开请求无效');
    const matchesPending = pendingBiliConnect !== null && input.cancelConnectId === pendingBiliConnect.id
      && input.controlRevision === pendingBiliConnect.revision;
    if (!roomControl.matches(input.controlRevision) && !matchesPending) return json({ ok: false, error: '房间状态已变化，请刷新后重试', roomControl: roomControlSnapshot() }, 409);
    pendingBiliConnect = null;
    roomControl.detach();
    invalidateTarget();
    show.disconnect();
    return json(state());
  }, 'disconnect');

  route('/api/dsh-livestream/collector/stop', ['POST'], async (request) => {
    const input = await controlBody<{ controlRevision?: unknown; confirmSharedEffect?: unknown }>(request);
    if (!input) return fail('停止请求无效');
    if (!roomControl.matches(input.controlRevision)) return json({ ok: false, error: '房间状态已变化，请刷新后重试', roomControl: roomControlSnapshot() }, 409);
    if (input.confirmSharedEffect !== true) return fail('请确认停止会影响使用该房间采集的其他程序');
    if (settings.livePlatform !== 'douyin' || !settings.douyinRoomId) return fail('请先保存抖音房间');
    if (roomControl.locked) return json({ ok: false, error: '采集操作尚未确认，不能停止', roomControl: roomControlSnapshot() }, 409);
    invalidateTarget();
    show.disconnect();
    try {
      await roomControl.stop(settings.douyinRoomId);
      return json(state());
    } catch (error) {
      return json({ ok: false, error: (error as Error).message, roomControl: roomControlSnapshot() }, roomControl.locked ? 409 : 502);
    }
  }, 'collector stop');

  route('/api/dsh-livestream/onair', ['POST'], async (request) => {
    const { sessionId, gameSessionId } = await body<{ sessionId?: string; gameSessionId?: string }>(request);
    if (!sessionId) return fail('缺她直播用的会话');
    // FEAT-006：管理会话核对绑定 ready、平台与 native cwd 后才开播；保存、重查、创建会话本身均不触发 onair
    const managed = await verifyManagedOnair(sessionId);
    if (!managed.ok) return fail(managed.error, 409);
    show.goLive(sessionId, localRehearsal || settings.livePlatform === 'douyin' ? undefined : gameSessionId || undefined);
    // 先推上流、后开播的：这一场一开始就不是彩排
    if (broadcast.streaming) show.markBroadcast();
    if (settings.livePlatform === 'bilibili') {
      dm.newShow();
      social.newShow();
    }
    return json(state());
  }, 'onair');

  route('/api/dsh-livestream/offair', ['POST'], () => {
    show.endLive();
    // 在推流：等她道别说完（这场结束），舞台放完谢幕，再停推、下播（以前一说完就断，观众看不到谢幕）
    if (broadcast.streaming && !waitingOffair) {
      waitingOffair = setInterval(() => {
        if (show.isOnAir) return;
        if (waitingOffair) clearInterval(waitingOffair);
        waitingOffair = null;
        setTimeout(() => void broadcast.stop(), ENDING_SCENE_MS);
      }, 1000);
    }
    return json(state());
  }, 'offair');

  // 推流到 B 站：开播拿推流码、OBS 推流（在后台跑，进度看 state().broadcast）
  route('/api/dsh-livestream/broadcast/start', ['POST'], () => {
    if (localRehearsal || settings.livePlatform === 'douyin') return fail('当前模式不推流');
    broadcast.start();
    return json(state());
  }, 'broadcast start');

  route('/api/dsh-livestream/broadcast/stop', ['POST'], async () => {
    if (localRehearsal || settings.livePlatform === 'douyin') return fail('当前模式不使用 OBS');
    await broadcast.stop();
    return json(state());
  }, 'broadcast stop');

  // 检查 OBS：没开就打开（在 DSH 所在的桌面会话里），设好专用配置和场景，回一帧节目画面；不推流
  route('/api/dsh-livestream/obs/check', ['POST'], async () => {
    if (localRehearsal || settings.livePlatform === 'douyin') return fail('当前模式不使用 OBS');
    try {
      const obs = await connectObs(true);
      try {
        return json({ ok: true, ...(await checkObs(obs, server.url, settings.streamKbps)) });
      } finally {
        obs.close();
      }
    } catch (err) {
      return fail((err as Error).message, 500);
    }
  }, 'obs check');

  // 开播账号：现在登的是谁；扫码登录（拿到的 Cookie 直接存进 DSH 凭据，不经过网页）
  route('/api/dsh-livestream/account', ['GET'], async () => json({ ok: true, account: localRehearsal || settings.livePlatform === 'douyin' ? null : await whoIs(await cookie()) }), 'account');
  route('/api/dsh-livestream/login/start', ['POST'], async () => {
    if (localRehearsal || settings.livePlatform === 'douyin') return fail('当前模式不登录 B 站');
    try {
      return json({ ok: true, ...(await startQrLogin()) });
    } catch (err) {
      return fail((err as Error).message, 502);
    }
  }, 'login start');
  route('/api/dsh-livestream/login/poll', ['POST'], async (request) => {
    if (localRehearsal || settings.livePlatform === 'douyin') return fail('当前模式不登录 B 站');
    const { key } = await body<{ key?: string }>(request);
    if (!key) return fail('缺 key');
    try {
      const result = await pollQrLogin(String(key));
      if (result.state !== 'ok') return json({ ok: true, state: result.state, ...(result.state === 'error' ? { message: result.message } : {}) });
      const account = await whoIs(result.cookie);
      if (!account) return json({ ok: true, state: 'error', message: '登录成功了，但用这个 Cookie 查不到账号' });
      assertBiliCurrent();
      await hooks.setSecret(SECRETS.cookie, result.cookie);
      return json({ ok: true, state: 'ok', account });
    } catch (err) {
      return fail((err as Error).message, 502);
    }
  }, 'login poll');

  // 点单队列：主人改一单的状态（{ id, state: queued|doing|done|dropped }），或者清空（{ clear: true }）
  route('/api/dsh-livestream/orders', ['POST'], async (request) => {
    const { id, state: to, clear } = await body<{ id?: number; state?: string; clear?: boolean }>(request);
    const ok = (['queued', 'doing', 'done', 'dropped'] as const).find((s) => s === to);
    return show.ownerOrders({ id: Number(id) || undefined, state: ok, clear: !!clear }) ? json(state()) : fail('没有这一单，或者状态不对');
  }, 'orders');

  route('/api/dsh-livestream/owner', ['POST'], async (request) => {
    const { text, who, line } = await body<{ text?: string; who?: string; line?: string }>(request);
    if (!text?.trim()) return fail('说点什么');
    // line: 'game'：只交给游戏线（长图纸、坐标清单这类只关游戏的事），直播线不经手
    if (line === 'game') return show.ownerToGame(text) ? json({ ok: true }) : fail('这场没开游戏线');
    show.ownerSay(text, who ? String(who).slice(0, 20) : undefined);
    return json({ ok: true });
  }, 'owner');

  // 嘉宾上直播间说话（Claude 小姐这些在电脑前帮忙管直播的人）：用嘉宾的音色念给观众听，字幕写嘉宾的名字；念完交给她回。念完才返回
  route('/api/dsh-livestream/guest', ['POST'], async (request) => {
    const { who, text, voice } = await body<{ who?: string; text?: string; voice?: string }>(request);
    if (!text?.trim()) return fail('说点什么');
    if (!show.isOnAir) return fail('没在播');
    const name = String(who ?? '').trim().slice(0, 20) || 'Claude小姐';
    const said = await show.guestSay(name, text.slice(0, 300), String(voice ?? '').trim() || GUEST_VOICE, AbortSignal.timeout(120_000));
    return json({ ok: true, said });
  }, 'guest');

  // 念稿：主人写好的话由她原样念出来（口播、公告、彩排台词），不经过她的会话；[mood] 标记照样换表情。念完才返回。
  // prepare: true 只提前合成好语音（一串台词先全部 prepare，念的时候句和句之间不用等合成）
  route('/api/dsh-livestream/say', ['POST'], async (request) => {
    const { text, prepare } = await body<{ text?: string; prepare?: boolean }>(request);
    if (!text?.trim()) return fail('念什么');
    if (prepare) {
      for (const part of splitByMood(text.slice(0, 500), currentMoods())) prepareSpeech(speakable(part.text));
      return json({ ok: true });
    }
    const said: string[] = [];
    for (const part of splitByMood(text.slice(0, 500), currentMoods())) said.push(await show.say(part.text, part.mood, AbortSignal.timeout(120_000)));
    return json({ ok: true, said: said.filter(Boolean) });
  }, 'say');

  route('/api/dsh-livestream/simulate', ['POST'], async (request) => {
    const event = simulated(await body(request));
    if (!event) return fail('模拟的事件不完整');
    show.inject(event);
    return json({ ok: true });
  }, 'simulate');

  // 控制台的事件流：舞台事件（不带语音）+ 每秒一次状态
  route('/api/dsh-livestream/events', ['GET'], () => {
    let unsubscribe: (() => void) | null = null;
    let tick: NodeJS.Timeout | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const send = (text: string) => { try { controller.enqueue(enc.encode(text)); } catch { /* 已关闭 */ } };
        unsubscribe = show.stage.subscribe((event: StageEvent) => {
          if (event.type === 'hello') return;
          send(`data: ${JSON.stringify(event.type === 'say' ? { ...event, audio: null } : event)}\n\n`);
        }, false);
        const status = () => {
          send(`event: status\ndata: ${JSON.stringify(show.status())}\n\n`);
          send(`event: broadcast\ndata: ${JSON.stringify(broadcast.status())}\n\n`);
        };
        tick = setInterval(status, 1000);
        status();
      },
      cancel() {
        unsubscribe?.();
        if (tick) clearInterval(tick);
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }, 'events');
}
