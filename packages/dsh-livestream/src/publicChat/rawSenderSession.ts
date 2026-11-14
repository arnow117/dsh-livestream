import type { FrozenSenderRuntime } from './frozenSenderRuntime';

interface RawPage {
  url(): string;
  context(): object;
}
interface RawMessage {
  method: string;
  msgId: string;
  payload: Uint8Array;
}
interface RawObserver {
  socketCreated(id: string, url: string): void;
  socketClosed(id: string): void;
  rawMessage(id: string, message: RawMessage): void;
}
interface OwnedBrowser {
  openRoom(url: string, options: { clickTrigger: false; beforeNavigate: (page: RawPage, cdp: object, context?: object) => void }):
    Promise<{ streamUrl: () => string | null }>;
  close(): Promise<void>;
}
interface OwnedRawSession { stop(): Promise<void> }
interface SessionOptions {
  onMessage: (message: RawMessage, meta: { roomId: string }) => void;
  onRawSocketCreated: (id: string, url: string) => void;
  onRawSocketClosed: (id: string) => void;
  onRawMessage: (id: string, message: RawMessage) => void;
  onError: () => void;
  streamUrl: () => string | null;
}
type SessionFactory = (roomId: string, page: RawPage, cdp: object, options: SessionOptions, context?: object) => OwnedRawSession;

/** Owns a single anonymous fixed-room raw session; it exposes no page write path. */
export class RawSenderSession {
  #browser: OwnedBrowser | null = null;
  #session: OwnedRawSession | null = null;
  #observer: RawObserver | null = null;
  readonly #sockets = new Set<string>();
  #starting = false;

  readonly #deps: { roomId: string; runtime: FrozenSenderRuntime; createBrowser: () => OwnedBrowser; createSession: SessionFactory };

  constructor(deps: { roomId: string; runtime: FrozenSenderRuntime; createBrowser: () => OwnedBrowser; createSession: SessionFactory }) {
    if (!/^[0-9]{1,64}$/.test(deps.roomId)) throw new Error('invalid fixed room');
    this.#deps = deps;
  }

  private invalidateSockets(): void {
    for (const id of this.#sockets) this.#observer?.socketClosed(id);
    this.#sockets.clear();
  }

  async start(): Promise<void> {
    if (this.#starting || this.#browser || this.#session) throw new Error('raw session already started');
    this.#starting = true;
    let browser: OwnedBrowser | null = null;
    try {
      browser = this.#deps.createBrowser();
      this.#browser = browser;
      let streamUrl = () => null as string | null;
      const opened = await browser.openRoom(`https://live.douyin.com/${this.#deps.roomId}`, {
        clickTrigger: false,
        beforeNavigate: (page, cdp, context) => {
          if (this.#session) throw new Error('duplicate raw session');
          const observer = this.#deps.runtime.createRawEvidenceObserver(this.#deps.roomId, page, cdp);
          this.#observer = observer;
          this.#session = this.#deps.createSession(this.#deps.roomId, page, cdp, {
            onMessage: () => {},
            onRawSocketCreated: (id, url) => { this.#sockets.add(id); observer.socketCreated(id, url); },
            onRawSocketClosed: (id) => { this.#sockets.delete(id); observer.socketClosed(id); },
            onRawMessage: (id, message) => observer.rawMessage(id, message),
            onError: () => this.invalidateSockets(),
            streamUrl: () => streamUrl(),
          }, context);
        },
      });
      streamUrl = opened.streamUrl;
      if (!this.#session) throw new Error('raw observer was not installed before navigation');
    } catch (error) {
      this.invalidateSockets();
      const session = this.#session as OwnedRawSession | null;
      this.#session = null;
      this.#observer = null;
      try {
        if (session) await session.stop();
      } finally {
        if (browser) await browser.close();
        this.#browser = null;
      }
      throw error;
    } finally {
      this.#starting = false;
    }
  }

  async stop(): Promise<void> {
    if (this.#starting) throw new Error('raw session is starting');
    this.invalidateSockets();
    const session = this.#session;
    const browser = this.#browser;
    this.#session = null;
    this.#observer = null;
    this.#browser = null;
    try {
      if (session) await session.stop();
    } finally {
      if (browser) await browser.close();
    }
  }
}
