import { describe, expect, it } from 'vitest';
import { defaultRobotLiveConfig, normalizeRobotLiveConfig, ROBOT_LIVE_MAX_RULES } from '../src/shared/robotLive';

const valid = () => ({
  version: 'robot-live/1' as const,
  enabled: true,
  liveSessionId: 'session-1',
  bindingId: 'binding-1',
  allowedActions: ['greeting', 'sit_down'],
  rules: [{ ruleId: 'rule-sit', text: '坐下', action: 'sit_down' as const }],
  cooldownMs: 10000,
});

describe('robot live config normalization', () => {
  it('rejects non-object and wrong version', () => {
    expect(normalizeRobotLiveConfig(null).ok).toBe(false);
    expect(normalizeRobotLiveConfig([]).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), version: 'robot-live/0' }).ok).toBe(false);
  });

  it('rejects unknown and missing fields', () => {
    expect(normalizeRobotLiveConfig({ ...valid(), extra: 1 }).ok).toBe(false);
    const missing = { ...valid() } as Record<string, unknown>;
    delete missing.rules;
    expect(normalizeRobotLiveConfig(missing).ok).toBe(false);
  });

  it('rejects invalid identifiers and enabled without binding target', () => {
    expect(normalizeRobotLiveConfig({ ...valid(), liveSessionId: '会话' }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), bindingId: '-bad' }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), bindingId: null }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), liveSessionId: null }).ok).toBe(false);
    // 关闭状态允许保留 null 目标（保存草稿）
    expect(normalizeRobotLiveConfig({ ...valid(), enabled: false, bindingId: null, liveSessionId: null }).ok).toBe(true);
  });

  it('dedupes whitelist and rejects unknown actions', () => {
    const deduped = normalizeRobotLiveConfig({ ...valid(), allowedActions: ['greeting', 'greeting', 'sit_down'] });
    expect(deduped.ok && deduped.config.allowedActions).toEqual(['greeting', 'sit_down']);
    expect(normalizeRobotLiveConfig({ ...valid(), allowedActions: ['dance'] }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), allowedActions: 'greeting' }).ok).toBe(false);
  });

  it('enforces literal rule text constraints without trimming', () => {
    expect(normalizeRobotLiveConfig({ ...valid(), rules: [{ ruleId: 'r', text: '', action: 'greeting' }] }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), rules: [{ ruleId: 'r', text: ' 坐下', action: 'greeting' }] }).ok).toBe(true);
    expect(normalizeRobotLiveConfig({ ...valid(), rules: [{ ruleId: 'r', text: 'a\0b', action: 'greeting' }] }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), rules: [{ ruleId: 'r', text: 'a'.repeat(501), action: 'greeting' }] }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), rules: [{ ruleId: 'r', text: 'a'.repeat(500), action: 'greeting' }] }).ok).toBe(true);
    // 按 Unicode 标量计数：500 个代理对 = 500 codepoints（1000 UTF-16 单元），合法
    const emoji500 = '🐳'.repeat(500);
    expect(normalizeRobotLiveConfig({ ...valid(), rules: [{ ruleId: 'r', text: emoji500, action: 'greeting' }] }).ok).toBe(true);
    const emoji501 = '🐳'.repeat(501);
    expect(normalizeRobotLiveConfig({ ...valid(), rules: [{ ruleId: 'r', text: emoji501, action: 'greeting' }] }).ok).toBe(false);
  });

  it('rejects lone surrogates in rule text', () => {
    const loneHigh = 'a\uD800b';
    expect(normalizeRobotLiveConfig({ ...valid(), rules: [{ ruleId: 'r', text: loneHigh, action: 'greeting' }] }).ok).toBe(false);
    const loneLow = 'a\uDC00b';
    expect(normalizeRobotLiveConfig({ ...valid(), rules: [{ ruleId: 'r', text: loneLow, action: 'greeting' }] }).ok).toBe(false);
    // 完整代理对合法
    expect(normalizeRobotLiveConfig({ ...valid(), rules: [{ ruleId: 'r', text: 'a\uD83D\uDE09b', action: 'greeting' }] }).ok).toBe(true);
  });

  it('rejects rule actions outside the whitelist and duplicate rule ids', () => {
    expect(normalizeRobotLiveConfig({ ...valid(), rules: [{ ruleId: 'r', text: '坐', action: 'lie_down' }] }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({
      ...valid(),
      rules: [{ ruleId: 'r', text: '坐', action: 'sit_down' }, { ruleId: 'r', text: '躺', action: 'sit_down' }],
    }).ok).toBe(false);
    // 合并被合并条目也不允许复用 ruleId：全部原始 id 必须唯一
    expect(normalizeRobotLiveConfig({
      ...valid(),
      rules: [{ ruleId: 'r1', text: '坐下', action: 'sit_down' }, { ruleId: 'r1', text: '再来一次', action: 'sit_down' }],
    }).ok).toBe(false);
  });

  it('merges same text+action rules keeping the first id, rejects same text different action', () => {
    const merged = normalizeRobotLiveConfig({
      ...valid(),
      rules: [
        { ruleId: 'r1', text: '坐下', action: 'sit_down' },
        { ruleId: 'r2', text: '坐下', action: 'sit_down' },
      ],
    });
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.config.rules).toHaveLength(1);
      expect(merged.config.rules[0].ruleId).toBe('r1');
      expect(merged.mergedRuleIds).toEqual(['r2']);
    }
    expect(normalizeRobotLiveConfig({
      ...valid(),
      rules: [
        { ruleId: 'r1', text: '坐下', action: 'sit_down' },
        { ruleId: 'r2', text: '坐下', action: 'greeting' },
      ],
    }).ok).toBe(false);
  });

  it('enforces positive safe-integer cooldown', () => {
    expect(normalizeRobotLiveConfig({ ...valid(), cooldownMs: 0 }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), cooldownMs: -1 }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), cooldownMs: 1.5 }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), cooldownMs: Number.NaN }).ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), cooldownMs: Number.MAX_SAFE_INTEGER }).ok).toBe(true);
    expect(normalizeRobotLiveConfig({ ...valid(), cooldownMs: Number.MAX_SAFE_INTEGER + 1 }).ok).toBe(false);
  });

  it('bounds the rule count', () => {
    const rules = Array.from({ length: ROBOT_LIVE_MAX_RULES + 1 }, (_, index) => ({ ruleId: `r${index}`, text: `字${index}`, action: 'greeting' as const }));
    const tooMany = normalizeRobotLiveConfig({ ...valid(), allowedActions: ['greeting'], rules });
    expect(tooMany.ok).toBe(false);
    expect(normalizeRobotLiveConfig({ ...valid(), allowedActions: ['greeting'], rules: rules.slice(0, ROBOT_LIVE_MAX_RULES) }).ok).toBe(true);
  });

  it('empty whitelist is a valid disabled-effective configuration', () => {
    const empty = normalizeRobotLiveConfig({ ...valid(), allowedActions: [], rules: [] });
    expect(empty.ok).toBe(true);
  });

  it('defaults describe a fully disabled configuration', () => {
    expect(defaultRobotLiveConfig()).toEqual({
      version: 'robot-live/1',
      enabled: false,
      liveSessionId: null,
      bindingId: null,
      allowedActions: [],
      rules: [],
      cooldownMs: 10000,
    });
  });
});
