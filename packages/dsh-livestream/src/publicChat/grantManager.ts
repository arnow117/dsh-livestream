/**
 * L 侧授权（grant）生命周期（FEAT-008 API-1/3）。
 *
 * 授权仅内存，保存 enabled 不授权。相同本地记录换主体、登录/登出/relogin/
 * Cookie 替换全部废弃原资格；恢复 connected 不能复活旧 grant；
 * 新 grant 不接管旧队列条目（条目固定原 grantId，由 controller 校验）。
 */

import { createHash } from 'node:crypto';
import type { PrincipalProof } from './identity';
import type { GrantSnapshot } from './grantAuthority';

export type GrantRevokeReason =
  | 'login-maintenance-start'
  | 'login-maintenance-end'
  | 'logout'
  | 'cookie-changed'
  | 'relogin'
  | 'navigation-away-from-room'
  | 'identity-proof-invalid'
  | 'live-epoch-changed'
  | 'sender-connection-change'
  | 'sender-session-replaced'
  | 'unknown-hold'
  | 'owner-revoke';

/** 授权时核实的完整 sender 侧快照（F1：绑定贯通，不用 L 侧值修补）。 */
export interface QualificationSnapshot extends PrincipalProof {
  /** sender 签发的不可复用授权令牌（grantId 必须取自它，F4）。 */
  qualificationToken: string;
  /** 采证时的 sender 身份代次。 */
  identityEpoch: number;
  /** 采证时 sender 的进程 nonce。 */
  senderProcessNonce: string;
  /** 采证时的 sender 连接代次。 */
  senderConnectionGeneration: number;
}

export interface GrantRecord {
  grantId: string;
  issuedAt: number;
  qualification: QualificationSnapshot;
  liveEpoch: string;
  inputConnectionGeneration: number;
  revoked: { reason: GrantRevokeReason; at: number } | null;
  snapshot?: GrantSnapshot;
}

export interface AuthorizeInput {
  qualification: QualificationSnapshot | null;
  expectedPrincipalUid: string;
  liveEpoch: string;
  inputConnectionGeneration: number;
  now: number;
}

export type AuthorizeResult =
  | { ok: true; grant: GrantRecord }
  | { ok: false; reason: string };

export class GrantManager {
  private current: GrantRecord | null = null;
  private readonly issued: GrantRecord[] = [];
  /** 每次输入连接代次/直播 epoch 变化都会推进；旧 grant 一律不可用。 */
  private epoch: string | null = null;
  private inputGeneration = -1;

  get active(): GrantRecord | null {
    return this.current !== null && this.current.revoked === null ? this.current : null;
  }

  get liveEpoch(): string | null {
    return this.epoch;
  }

  get currentInputGeneration(): number {
    return this.inputGeneration;
  }

  /** Host 在输入连接建立/断开时调用；代次只前进。 */
  advanceInputConnection(): number {
    this.inputGeneration += 1;
    return this.inputGeneration;
  }

  /** Host 在开播/目标切换时调用；epoch 变化使旧 grant 全部失效。 */
  setLiveEpoch(epoch: string, now: number): void {
    if (this.epoch === epoch) return;
    this.epoch = epoch;
    if (this.current !== null && this.current.revoked === null) {
      this.current = { ...this.current, revoked: { reason: 'live-epoch-changed', at: now } };
    }
  }

  /** Qualification by itself never authorizes a send. */
  authorize(_input: AuthorizeInput): AuthorizeResult {
    return { ok: false, reason: 'explicit-sender-grant-required' };
  }

  /** Install only a sender-acknowledged immutable snapshot after journal persistence. */
  install(snapshot: GrantSnapshot, qualification: QualificationSnapshot): AuthorizeResult {
    if (!snapshot || !qualification || typeof qualification.qualificationToken !== 'string' || qualification.qualificationToken.length === 0 ||
      typeof snapshot.grantId !== 'string' || snapshot.grantId.length === 0 || typeof snapshot.authorizationId !== 'string' || snapshot.authorizationId.length === 0 ||
      snapshot.grantId === qualification.qualificationToken ||
      snapshot.qualificationDigest !== createHash('sha256').update(qualification.qualificationToken).digest('hex') ||
      snapshot.principalUid !== qualification.principalUid || snapshot.senderProcessNonce !== qualification.senderProcessNonce ||
      snapshot.senderConnectionGeneration !== qualification.senderConnectionGeneration || snapshot.identityEpoch !== qualification.identityEpoch ||
      this.issued.some((entry) => entry.grantId === snapshot.grantId || entry.snapshot?.authorizationId === snapshot.authorizationId)) {
      return { ok: false, reason: 'grant-binding-invalid-or-replayed' };
    }
    if (this.active !== null || this.epoch !== snapshot.liveEpoch || this.inputGeneration !== snapshot.inputConnectionGeneration) {
      return { ok: false, reason: 'local-revision-changed' };
    }
    const grant: GrantRecord = {
      grantId: snapshot.grantId,
      issuedAt: snapshot.authorizedAtMs,
      qualification,
      liveEpoch: snapshot.liveEpoch,
      inputConnectionGeneration: snapshot.inputConnectionGeneration,
      revoked: null,
      snapshot,
    };
    this.current = grant;
    this.issued.push(grant);
    return { ok: true, grant };
  }

  revoke(reason: GrantRevokeReason, now: number): void {
    if (this.current !== null && this.current.revoked === null) {
      this.current = { ...this.current, revoked: { reason, at: now } };
    }
  }
  /**
   * 发送前的 grant 可用性检查：grant 必须是当前未撤销的那个，
   * 且 epoch 与输入代次仍与签发时一致。任何不匹配都拒绝旧队列条目。
   */
  isUsable(grantId: string, now: number): boolean {
    const grant = this.active;
    if (grant === null || grant.grantId !== grantId) return false;
    if (grant.liveEpoch !== this.epoch) return false;
    if (grant.inputConnectionGeneration !== this.inputGeneration) return false;
    if (now < grant.issuedAt) return false;
    return true;
  }
}
