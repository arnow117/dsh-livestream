import type { LiveConnectionState, LivePlatform } from '../core/live';

export interface RoomControlSnapshot {
  controlRevision: string;
  target: { platform: LivePlatform; roomId: string | number | null };
  bridge: 'unknown' | 'online' | 'offline';
  collector: 'unknown' | 'missing' | 'connecting' | 'live' | 'closed' | 'error' | 'stopped';
  subscription: LiveConnectionState;
  operation: {
    state: 'idle' | 'running' | 'unknown';
    opId?: string;
    type?: 'account' | 'connect' | 'stop';
    target?: string;
    error?: string;
    recoveryHint?: string;
  };
  targetLocked: boolean;
  lockReason?: string;
}
