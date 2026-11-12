import { createWeatherSource } from '../body/weather';
/**
 * 插件的共享状态：宿主根插件（index.ts）和 agent 子插件（agent.ts）用同一份（同一个进程，同一个模块实例）。
 *
 *   - show：这一场直播的身体
 *   - server：舞台服务器（OBS 打开的那个地址）
 *   - settings：房间号、角色、模板……存在 DSH_HOME/dsh-livestream/settings.json（控制台里改）
 *   - 机密（B 站 Cookie、豆包密钥）不在这里：走 DSH 的凭据服务，按名字取
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveShow, type LiveSnapshot } from '../body/show';
import { Whisper } from '../body/asr';
import { BiliAccount } from '../body/biliAccount';
import { BiliVideos } from '../body/biliVideo';
import { BiliSocial } from '../body/biliSocial';
import { VideoLibrary } from '../body/videoLibrary';
import { SocialManager } from '../body/social';
import { Broadcast } from '../body/broadcast';
import { DmManager } from '../body/dm';
import { Packs } from '../body/packs';
import { StageServer } from '../body/server';
import { CourseController } from '../body/course/controller';
import type { DirectoryBinding } from './sessionContextPaths';
import type { CourseFrame } from '../shared/course';
import { canSpeak, subtitleTimeline, synthesize, type TtsAuth } from '../body/tts';
import { synthesizeMacos } from '../body/macosTts';
import { synthesizeYovoice } from '../body/yovoiceTts';
import { DEFAULT_VOICE } from '../body/voices';
import type { DistillLlm } from '../core/memory/distill';
import type { Topic } from '../core/attention/topics';
import type { CharacterManifest, GameSource } from '../stage/protocol';
import { gameRect } from '../stage/layout';
import { connectObs, showGameSources } from '../body/obs';
import type { OwnerPace } from '../core/attention/attention';
import { assertBiliCurrent, beginBiliOperation, inBiliOperation } from '../shared/biliOperations';
import { parseDouyinRoomId } from '../shared/liveTarget';
import type { LivePlatform } from '../core/live';
import { mergeQuerySettings, type QuerySettings } from '../shared/readOnlyQuery';
import { defaultTtsSettings, mergeTtsSettings, type TtsSettings } from '../shared/ttsSettings';

export interface Settings {
  livePlatform: LivePlatform;
  douyinRoomId: string;
  roomId: number | null;
  character: string;
  template: string;
  /** 空串用角色包的默认音色 */
  voice: string;
  tts: TtsSettings;
  readOnlyQueries: QuerySettings;
  stagePort: number;
  stageToken: string;
  /** 下播提炼观众记忆用的模型（provider/model） */
  distillModel: string;
  /** 没话题多少秒后自己找话说 */
  idleAfterSec: number;
  /** 她在玩游戏时，弹幕至少隔多少秒推给她一次（越大回得越少、玩得越多） */
  gameChatGapSec: number;
  /** 主人说是自己的直播间（记住常来的观众）；别的房间只旁观、不建档 */
  ownRooms: number[];
  /** 开播时真的推流到 B 站（默认关：只在本地彩排） */
  broadcast: boolean;
  /** 开播用的分区（子分区 id）；null 用 B 站给账号准备的默认分区 */
  areaId: number | null;
  /** 开播前改成这个标题；空串不改 */
  liveTitle: string;
  /** 推流协议：srt（B 站给了就用，跨境、丢包的网络上比 rtmp 稳）或 rtmp */
  pushProtocol: 'srt' | 'rtmp';
  /** 推流码率（kbps） */
  streamKbps: number;
  /** 直播间封面图片的路径（本机文件）；空串不换 */
  liveCover: string;
  /** 装了 faster-whisper 的 Python（视频没字幕时听写用）；空串不听写 */
  asrPython: string;
  /** whisper 模型：large-v3-turbo（有显卡）、small（只有 CPU）…… */
  asrModel: string;
  /** 告示板：主人想让观众知道的。空行分页，每页第一行是标题；空串不显示告示板 */
  boardText: string;
  /** 滚动通知：画面最底下一条滚动的字，出状况时告诉观众（卡了、在修、马上回来）；空串不显示 */
  noticeText: string;
  /** 主人定的节奏（秒）：没填的项按直播间热度自动；欢迎填 off 就不欢迎新观众 */
  pace: Pace;
  /** 黑名单：主人拉黑的观众。她不欢迎、不回、不记、不看主页、不私信；别的程序（私信、运营）读这个文件也照着跳过 */
  blocked: BlockedViewer[];
  /** 直播会话上下文保存记录（FEAT-006）：结构见 shared/sessionContext；损坏值原样保留并显示 invalid */
  sessionContext?: unknown;
}

export interface BlockedViewer {
  /** B 站 UID */
  uid: string;
  name: string;
  /** 为什么拉黑（主人自己看的） */
  why: string;
  at: number;
}

export interface Pace {
  welcomeSec?: number | 'off';
  thanksSec?: number;
  followSec?: number;
  chatPicks?: number;
}

/** 控制台填的节奏 → 注意力层用的（毫秒） */
function ownerPace(p: Pace | undefined): OwnerPace {
  if (!p) return {};
  return {
    ...(p.welcomeSec === 'off' ? { welcomeOff: true } : p.welcomeSec !== undefined ? { welcomeGapMs: p.welcomeSec * 1000 } : {}),
    ...(p.thanksSec !== undefined ? { thanksGapMs: p.thanksSec * 1000 } : {}),
    ...(p.followSec !== undefined ? { followGapMs: p.followSec * 1000 } : {}),
    ...(p.chatPicks !== undefined ? { chatPicks: p.chatPicks } : {}),
  };
}

/** 告示板默认写的：观众怎么跟她玩 */
export const DEFAULT_BOARD = [
  '想看什么，跟大肥鱼说',
  '说个大概：「想看猫猫」',
  '她自己去 B 站搜、挑来放',
  '找错了告诉她，她再找',
  '',
  '还可以这样玩',
  '让她「看看我的主页」',
  '常来的观众她会记住',
  '她靠字幕听，也会看一眼画面',
  '',
  '大肥鱼是怎么玩游戏的',
  '她自己看游戏画面、想好下一步',
  '下指令给游戏里的身体去做',
  '边玩边回弹幕，没人替她玩',
].join('\n');

const LOCAL_BOARD = '本地彩排\n和主人聊天，回应模拟观众的弹幕与礼物';
export const DOUYIN_BOARD = '和大肥鱼聊聊天\n发弹幕提问，一起聊聊有趣的事\n谢谢大家的陪伴与支持';

/** 机密的名字（DSH 凭据）。豆包的和 dsh-game 共用 */
export const SECRETS = {
  cookie: 'BILIBILI_COOKIE',
  ttsApiKey: 'DOUBAO_TTS_API_KEY',
  ttsAppId: 'DOUBAO_TTS_APP_ID',
  ttsAccessKey: 'DOUBAO_TTS_ACCESS_KEY',
} as const;

export const PRESET_ID = 'dsh-livestream';
export const localRehearsal = process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL === '1';

export const dataDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-livestream');

export const weatherSource = createWeatherSource({
  cacheFile: join(dataDir, 'weather-cache-v1.json'),
  geocoderUrl: process.env.DSH_LIVESTREAM_WEATHER_GEOCODER_URL,
  onDiagnostic: (code) => console.warn(`[dsh-livestream] weather: ${code}`),
});

/** 插件包目录（构建产物在 lib/ 或 lib/chunks/，往上找 package.json） */
export function packageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const file = join(dir, 'package.json');
    if (existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as { name?: string }).name === 'dsh-livestream') return dir;
    dir = dirname(dir);
  }
  throw new Error('dsh-livestream: 找不到插件包目录');
}

const SETTINGS_FILE = join(dataDir, 'settings.json');

function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<Settings>;
  } catch {
    // 第一次用
  }
  const settings: Settings = {
    livePlatform: 'bilibili',
    douyinRoomId: '',
    roomId: null,
    character: 'dafeiyu',
    template: 'default',
    voice: '',
    tts: defaultTtsSettings(process.env, saved.voice ?? ''),
    readOnlyQueries: { weather: false, publicSearch: false },
    stagePort: 7390,
    stageToken: '',
    distillModel: 'deepseek-official/deepseek-flash',
    idleAfterSec: 45,
    gameChatGapSec: 15,
    ownRooms: [],
    broadcast: false,
    areaId: null,
    liveTitle: '',
    pushProtocol: 'srt',
    streamKbps: 4500,
    liveCover: '',
    asrPython: '',
    asrModel: 'large-v3-turbo',
    boardText: DEFAULT_BOARD,
    noticeText: '',
    pace: {},
    blocked: [],
    ...saved,
  };
  if (settings.livePlatform !== 'bilibili' && settings.livePlatform !== 'douyin') settings.livePlatform = 'bilibili';
  try {
    settings.douyinRoomId = settings.douyinRoomId ? parseDouyinRoomId(settings.douyinRoomId) : '';
  } catch {
    settings.douyinRoomId = '';
  }
  settings.tts = mergeTtsSettings(defaultTtsSettings(process.env, saved.voice ?? ''), saved.tts ?? {}, { allowInvalidCurrent: true });
  try {
    settings.readOnlyQueries = mergeQuerySettings(undefined, saved.readOnlyQueries ?? {});
  } catch {
    settings.readOnlyQueries = { weather: false, publicSearch: false };
  }
  settings.voice = settings.tts.doubaoVoice;
  if (!settings.stageToken) {
    settings.stageToken = randomBytes(12).toString('base64url');
    saveSettings(settings);
  }
  return settings;
}

function saveSettings(next: Settings): void {
  mkdirSync(dataDir, { recursive: true });
  const temporary = join(dataDir, `.settings-${randomBytes(16).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, SETTINGS_FILE);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export const settings: Settings = loadSettings();
const platformListeners = new Set<() => void>();
const querySettingsListeners = new Set<() => void>();
export let queryServiceStatus: 'unverified' | 'available' | 'incompatible' = 'unverified';
export function setQueryServiceStatus(status: typeof queryServiceStatus): void { queryServiceStatus = status; }
export function onQuerySettingsChange(listener: () => void): () => void {
  querySettingsListeners.add(listener);
  return () => querySettingsListeners.delete(listener);
}
export function onPlatformChange(listener: () => void): () => void {
  platformListeners.add(listener);
  return () => platformListeners.delete(listener);
}

export function updateSettings(patch: Partial<Settings>): Settings {
  let tts = patch.tts ? mergeTtsSettings(settings.tts, patch.tts) : settings.tts;
  if (patch.voice !== undefined) {
    if (patch.tts?.doubaoVoice !== undefined && patch.voice.trim() !== tts.doubaoVoice) throw new Error('音色设置冲突');
    tts = mergeTtsSettings(tts, { doubaoVoice: patch.voice });
  }
  const readOnlyQueries = patch.readOnlyQueries
    ? mergeQuerySettings(settings.readOnlyQueries, patch.readOnlyQueries)
    : settings.readOnlyQueries;
  const next = { ...settings, ...patch, tts, readOnlyQueries, voice: tts.doubaoVoice };
  saveSettings(next);
  const platformChanged = next.livePlatform !== settings.livePlatform;
  const queryChanged = (settings.readOnlyQueries.weather && !next.readOnlyQueries.weather)
    || (settings.readOnlyQueries.publicSearch && !next.readOnlyQueries.publicSearch);
  Object.assign(settings, next);
  if (queryChanged) for (const listener of querySettingsListeners) listener();
  if (platformChanged) {
    for (const listener of platformListeners) {
      try { listener(); } catch (error) { console.warn('[dsh-livestream] 更新平台工具失败：', error); }
    }
  }
  if (patch.tts || patch.voice !== undefined || patch.character !== undefined) {
    for (const entry of prepared.values()) entry.controller.abort();
    prepared.clear();
  }
  return settings;
}

/** agent 子插件接上 DSH 的服务后填这里：读机密、调模型 */
export const hooks: {
  secret: (name: string) => Promise<string>;
  /** 存一个机密（扫码登录拿到的 Cookie）；没有凭据服务时抛错 */
  setSecret: (name: string, value: string) => Promise<void>;
  push: (sessionId: string, text: string, now?: boolean, topic?: Topic) => Promise<boolean>;
  initializeWatch: (sessionId: string) => void;
  complete: ((model: string, system: string, user: string) => Promise<string>) | null;
  log: (level: 'info' | 'warn', message: string) => void;
} = {
  secret: async (name) => process.env[name] ?? '',
  setSecret: async () => { throw new Error('这个 DSH 没有凭据服务，存不了'); },
  push: async () => false,
  initializeWatch: () => {},
  complete: null,
  log: (level, message) => (level === 'warn' ? console.warn : console.log)(`[dsh-livestream] ${message}`),
};

/**
 * FEAT-006：管理会话受限绑定的接线点。agent 子插件加载后填这里：
 * - onCreated：preset-scoped 串行 agent/created 的实际处理器——原生创建/恢复在返回与首个工具集合解析前
 *   调用它完成快照恢复、校验与限制安装；listener 抛错让原生回滚该次创建/恢复。
 * - verify：创建/恢复返回后宿主路由（index.ts）核对绑定状态，不重新绑定、不补装权限。
 * 通过运行时回调接线而不是让 index.ts 静态 import agent 子插件（否则 dsh-tools 会进所有宿主端 bundle）。
 */
export const sessionTools: {
  onCreated: ((payload: { agent: any; source?: unknown }) => Promise<void>) | null;
  verify: ((sessionId: string) => { bound: boolean; note?: string }) | null;
} = { onCreated: null, verify: null };

async function ttsAuth(voice: string): Promise<TtsAuth | null> {
  const [apiKey, appId, accessKey] = await Promise.all([hooks.secret(SECRETS.ttsApiKey), hooks.secret(SECRETS.ttsAppId), hooks.secret(SECRETS.ttsAccessKey)]);
  const auth = { apiKey, appId, accessKey };
  return canSpeak(auth, voice) ? auth : null;
}

export const packs = new Packs(packageDir(), dataDir);

export function currentCharacter(): CharacterManifest | null {
  return packs.character(settings.character);
}

export function currentVoice(): string {
  return settings.voice || currentCharacter()?.voice || DEFAULT_VOICE;
}

/** 她能用的表情：角色包里有的 */
export function currentMoods(): string[] {
  const c = currentCharacter();
  const moods = c?.clips?.moods ?? c?.image?.moods ?? {};
  return ['talk', ...Object.keys(moods)];
}

const distill: DistillLlm = async (system, user) => {
  if (!hooks.complete) throw new Error('DSH 的模型服务还没接上');
  return hooks.complete(settings.distillModel, system, user);
};

export const show = new LiveShow(
  {
    push: (sessionId, text, now, topic) => hooks.push(sessionId, text, now, topic),
    initializeWatch: (sessionId) => hooks.initializeWatch(sessionId),
    synthesize: (text, signal, voice) => {
      if (voice) return speech(text, signal, voice);
      const snapshot = speechSnapshot();
      const key = preparedKey(snapshot, text);
      const ready = prepared.get(key);
      if (ready) {
        prepared.delete(key);
        const abort = () => ready.controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        return ready.promise.catch((error) => {
          if (signal.aborted) throw error;
          return speech(text, signal, undefined, snapshot);
        }).finally(() => signal.removeEventListener('abort', abort));
      }
      return speech(text, signal, undefined, snapshot);
    },
    synthTimeoutMs: () => settings.tts.backend === 'yovoice' ? 90_000 : 15_000,
    distill,
    log: (level, message) => hooks.log(level, message),
    persist: (snapshot) => saveLive(snapshot),
    onGame: (source) => placeGame(source),
  },
  { dataDir, names: currentCharacter()?.names ?? [], idleAfterMs: () => settings.idleAfterSec * 1000, pace: () => ownerPace(settings.pace), board: currentBoard, title: () => settings.liveTitle, gameChatGapMs: () => (settings.gameChatGapSec ?? 15) * 1000, blocked: (uid) => settings.blocked.some((b) => b.uid === uid) },
);

export const courseContext: {
  current(): { sessionId: string; roots: Array<{ rootId: string; binding: DirectoryBinding }> } | null;
} = { current: () => null };

export const courseTools: {
  activate(sessionId: string): boolean;
  deactivate(sessionId: string): void;
} = { activate: () => false, deactivate: () => {} };

export const course = new CourseController({
  current: () => courseContext.current(),
  publish: (event) => show.stage.broadcast(event),
  speakers: () => {
    const counts = show.stage.outputCapabilities();
    return counts.capableSpeakers === 1 && counts.legacySpeakers === 0 ? 1 : 0;
  },
  activate: (sessionId) => courseTools.activate(sessionId),
  deactivate: (sessionId) => courseTools.deactivate(sessionId),
});
show.onCourseEnd = () => course.end();
show.course = course;
show.stage.onOutputChange(() => course.invalidateOutput());
show.stage.onSpeakerChange(() => {
  const counts = show.stage.outputCapabilities();
  if (counts.capableSpeakers !== 1 || counts.legacySpeakers !== 0) course.markUnknown();
});
show.setPlatform(settings.livePlatform);

/**
 * 游戏画面上 OBS：窗口画面（Minecraft 摄像机客户端）由 OBS 抓，摆在舞台的游戏位上、垫在舞台下面；
 * 网页画面舞台自己放，OBS 里不用加东西。连不上 OBS（没开、只在本机预览）就算了
 */
export function placeGame(source: GameSource | null): void {
  if (localRehearsal || settings.livePlatform !== 'bilibili') return;
  const template = packs.template(settings.template);
  const windowSource = source && 'window' in source ? source : null;
  const lease = beginBiliOperation();
  void inBiliOperation(lease, async () => {
    let obs: Awaited<ReturnType<typeof connectObs>> | null = null;
    try {
      obs = await connectObs(false);
      assertBiliCurrent();
      await showGameSources(obs, windowSource, template ? gameRect(template) : { x: 0, y: 0, w: 1920, h: 1080 });
      hooks.log('info', windowSource ? `游戏画面上舞台：${windowSource.window}` : '游戏画面撤下');
    } catch (err) {
      hooks.log('warn', `游戏画面没能放进 OBS：${(err as Error).message}`);
    } finally {
      obs?.close();
      lease.release();
    }
  });
}

/** 告示板换了：舞台马上换（之后连上的舞台页也拿到最新的） */
function currentBoard(): string {
  if (settings.boardText !== DEFAULT_BOARD) return settings.boardText;
  if (settings.livePlatform === 'douyin') return DOUYIN_BOARD;
  return localRehearsal ? LOCAL_BOARD : settings.boardText;
}

export function publishBoard(): void {
  show.stage.broadcast({ type: 'board', text: currentBoard() });
}
publishBoard();

/** 滚动通知换了：舞台马上换 */
export function publishNotice(): void {
  show.stage.broadcast({ type: 'notice', text: settings.noticeText ?? '' });
}
publishNotice();

type SpeechSnapshot = { tts: TtsSettings; voice: string };

function speechSnapshot(tts = settings.tts, override?: string): SpeechSnapshot {
  return { tts: { ...tts }, voice: override || tts.doubaoVoice || currentCharacter()?.voice || DEFAULT_VOICE };
}

function preparedKey(snapshot: SpeechSnapshot, text: string): string {
  return JSON.stringify([snapshot.tts, snapshot.voice, text]);
}

export async function speech(text: string, signal: AbortSignal, voice?: string, snapshot = speechSnapshot(settings.tts, voice)): Promise<{ audio: Uint8Array; timeline: Array<{ chars: number; atMs: number }> } | null> {
  const { tts } = snapshot;
  if (tts.backend === 'yovoice') {
    if (!['voxcpm2-q8', 'voxcpm2-bf16'].includes(tts.yovoiceModel)) throw new Error('不支持的 yovoice 模型');
    const { audio, words } = await synthesizeYovoice(text, signal, tts.yovoiceModel, tts.yovoiceVoice);
    return { audio, timeline: subtitleTimeline(text, words) };
  }
  if (tts.backend === 'macos') {
    const { audio, words } = await synthesizeMacos(text, signal, tts.macosVoice);
    return { audio, timeline: subtitleTimeline(text, words) };
  }
  const auth = await ttsAuth(snapshot.voice);
  if (!auth) return null;
  const { audio, words } = await synthesize(auth, snapshot.voice, text, signal, tts.doubaoRate);
  return { audio, timeline: subtitleTimeline(text, words) };
}

export function previewSpeech(text: string, signal: AbortSignal, tts: TtsSettings) {
  return speech(text, signal, undefined, speechSnapshot(tts));
}

/** 提前合成好的句子（念稿时先合成、念的时候直接用，句和句之间不空等）：音色|文字 → 语音 */
const prepared = new Map<string, { controller: AbortController; promise: Promise<Awaited<ReturnType<typeof speech>>> }>();

/** 提前合成一句（text 是 speakable 处理过的那段）；最多留 40 句，用掉就删 */
export function prepareSpeech(text: string): void {
  const snapshot = speechSnapshot();
  const key = preparedKey(snapshot, text);
  if (!text || prepared.has(key)) return;
  const controller = new AbortController();
  const timeout = snapshot.tts.backend === 'yovoice' ? 120_000 : 60_000;
  const promise = speech(text, AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]), undefined, snapshot);
  void promise.catch(() => {});
  prepared.set(key, { controller, promise });
  while (prepared.size > 40) {
    const oldest = prepared.keys().next().value!;
    prepared.get(oldest)?.controller.abort();
    prepared.delete(oldest);
  }
}

export const server = new StageServer({
  port: settings.stagePort,
  token: settings.stageToken,
  packageDir: packageDir(),
  packs,
  stage: show.stage,
  courseAssets: () => course.assets,
  courseReport: (value) => {
    const speakers = show.stage.outputCapabilities();
    if (speakers.capableSpeakers !== 1 || speakers.legacySpeakers !== 0) return false;
    if (!value || typeof value !== 'object') return false;
    const report = value as { epoch?: unknown; frame?: unknown; commandId?: unknown; watcherId?: unknown; instance?: unknown; sequence?: unknown };
    if (typeof report.epoch !== 'string' || report.epoch.length > 128
      || typeof report.watcherId !== 'string' || !show.stage.isSpeaker(report.watcherId)
      || typeof report.instance !== 'string' || report.instance.length > 128
      || typeof report.sequence !== 'number' || !Number.isSafeInteger(report.sequence) || report.sequence < 1
      || (report.commandId !== undefined && (typeof report.commandId !== 'string' || report.commandId.length > 128))) return false;
    return course.report(report.epoch, report.frame as CourseFrame, report.commandId as string | undefined, report.instance, report.sequence);
  },
  current: () => ({ character: settings.character, template: settings.template }),
  media: {
    source: (id) => show.player.source(id),
    report: (id, state, positionSec, detail) => show.player.report(id, state, positionSec, detail),
  },
  log: (level, message) => hooks.log(level, message),
});

export async function cookie(): Promise<string> {
  if (localRehearsal || settings.livePlatform !== 'bilibili') throw new Error('当前模式不使用 B 站 Cookie');
  assertBiliCurrent();
  const value = await hooks.secret(SECRETS.cookie);
  assertBiliCurrent();
  return value;
}

/** 推流到 B 站：开播拿推流码、OBS 推流、下播 */
export const broadcast = new Broadcast({
  cookie,
  stageUrl: () => server.url,
  areaId: () => settings.areaId,
  title: () => settings.liveTitle.trim() || null,
  protocol: () => settings.pushProtocol,
  kbps: () => settings.streamKbps,
  cover: () => {
    const file = settings.liveCover.trim();
    if (!file || !existsSync(file)) return null;
    const ext = extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { data: new Uint8Array(readFileSync(file)), mime };
  },
  // 开播账号的直播间：记下来、标成自己的直播间（记住观众），连上它的弹幕
  onRoom: (roomId) => {
    updateSettings({ roomId, ownRooms: [...new Set([...settings.ownRooms, roomId])] });
    const status = show.status();
    if (status.roomId !== roomId || status.live.state === 'idle' || status.live.state === 'error') {
      const lease = beginBiliOperation();
      void inBiliOperation(lease, async () => {
        const currentCookie = await cookie();
        lease.assertCurrent();
        show.connect(roomId, currentCookie, true);
      }).catch(() => {}).finally(() => lease.release());
    } else {
      show.rememberViewers = true;
    }
  },
  onStreaming: () => show.markBroadcast(),
  log: (level, message) => hooks.log(level, message),
});

/** 她给观众发私信（开播账号）：B 站「对方没关注只能发一条」等规矩在这里管 */
export const dm = new DmManager(new BiliAccount(cookie), join(dataDir, 'dm.json'));

// ── 断点续播：在播的这一场存在磁盘上，插件（DSH）重启后接着播 ──

const LIVE_FILE = join(dataDir, 'live.json');

function saveLive(snapshot: LiveSnapshot | null): void {
  try {
    if (!snapshot) rmSync(LIVE_FILE, { force: true });
    else writeFileSync(LIVE_FILE, JSON.stringify({ ...snapshot, broadcasting: broadcast.streaming }));
  } catch (err) {
    hooks.log('warn', `存不了直播状态：${(err as Error).message}`);
  }
}

/** 上次停下时还在播的那一场（没有返回 null）；读了就删，接上以后会重新存 */
/** agent 子插件（她的会话）起来、装好推消息的钩子了没有 */
let agentAttached = false;
export const agentReady = (): boolean => agentAttached;
export function markAgentReady(): void {
  agentAttached = true;
}

export function takeLive(): (LiveSnapshot & { broadcasting: boolean }) | null {
  try {
    const saved = JSON.parse(readFileSync(LIVE_FILE, 'utf8')) as LiveSnapshot & { broadcasting: boolean };
    rmSync(LIVE_FILE, { force: true });
    return saved?.sessionId ? saved : null;
  } catch {
    return null;
  }
}

/** 她点赞、看评论、发评论、看收件箱（开播账号） */
export const social = new SocialManager(new BiliSocial(cookie));

/** 直播时每隔一会儿看一眼收件箱：开播以后新来的私信、回复、@，没别的事时告诉她 */
const INBOX_EVERY_MS = 90_000;
setInterval(() => {
  if (!show.isOnAir || localRehearsal || settings.livePlatform !== 'bilibili') return;
  const lease = beginBiliOperation();
  void inBiliOperation(lease, () => social.newSince())
    .then((lines) => { lease.assertCurrent(); if (lines.length) show.notifyInbox(lines); })
    .catch(() => {})
    .finally(() => lease.release());
}, INBOX_EVERY_MS).unref?.();

/** 她搜视频、看视频、在舞台上放视频（开播账号的 Cookie：AI 字幕要登录才给） */
export const videos = new BiliVideos(cookie);

/** 视频没字幕时听写（本机的 faster-whisper） */
export const asr = new Whisper({
  python: () => settings.asrPython,
  model: () => settings.asrModel.trim() || 'large-v3-turbo',
  script: join(packageDir(), 'assets', 'asr', 'whisper_worker.py'),
  dataDir,
  log: (level, message) => hooks.log(level, message),
});

/** 视频库：她看过、放过的视频（详情、字幕、原视频弹幕、每次看的记录），存在 <dataDir>/videos */
export const library = new VideoLibrary(join(dataDir, 'videos'), (message) => hooks.log('warn', message));
