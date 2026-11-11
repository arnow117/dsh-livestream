import { describe, expect, it } from 'vitest';
import {
  checkPathText,
  decodeSessionContextRecord,
  validateSessionContextConfig,
  validateSessionContextSaveRequest,
} from '../src/shared/sessionContext';

describe('session context shared DTO', () => {
  it('accepts valid absolute path text and rejects structural violations', () => {
    expect(checkPathText('/Users/owner/materials', 'x')).toBeNull();
    expect(checkPathText('/private/tmp/课程资料/课件.md', 'x')).toBeNull();
    for (const [raw, code] of [
      ['relative/path', 'relative_path'],
      ['~/materials', 'relative_path'],
      ['/home/user/~x', 'expansion_not_allowed'],
      ['/a/${HOME}b', 'expansion_not_allowed'],
      ['https://example.com/x', 'uri_or_windows_path'],
      ['C:\\materials', 'uri_or_windows_path'],
      ['\\\\server\\share', 'uri_or_windows_path'],
      ['', 'empty_path'],
      ['/a\u0000b', 'control_character'],
      ['/a\u0007b', 'control_character'],
      ['/a\ud800b', 'lone_surrogate'],
      [`/${'x'.repeat(4097)}`, 'path_too_long'],
      ['/a\u202eb', 'bidi_control'],
    ] as const) {
      const issue = checkPathText(raw, 'x');
      expect(issue?.code, raw).toBe(code);
    }
    expect(checkPathText(123, 'x')?.code).toBe('invalid_type');
  });

  it('validates whole config objects and rejects unknown or malformed fields', () => {
    const ok = validateSessionContextConfig({
      enabled: true,
      cwd: '',
      skillSources: [{ path: '/skills/a.md', enabled: true }],
      readRoots: [{ path: '/materials', enabled: false }],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.readRoots[0].enabled).toBe(false);
    for (const [raw, code, field] of [
      [null, 'invalid_config', 'config'],
      [4, 'invalid_config', 'config'],
      [{}, 'invalid_enabled', 'config.enabled'],
      [{ enabled: 'yes', cwd: '', skillSources: [], readRoots: [] }, 'invalid_enabled', 'config.enabled'],
      [{ enabled: true, cwd: 5, skillSources: [], readRoots: [] }, 'invalid_type', 'config.cwd'],
      [{ enabled: true, cwd: '', skillSources: [], readRoots: [], extra: 1 }, 'unknown_field', 'config.extra'],
      [{ enabled: true, cwd: '', skillSources: 'x', readRoots: [] }, 'invalid_list', 'config.skillSources'],
      [{ enabled: true, cwd: '', skillSources: [1], readRoots: [] }, 'invalid_entry', 'config.skillSources[0]'],
      [{ enabled: true, cwd: '', skillSources: [{ path: '/a' }], readRoots: [] }, 'invalid_enabled', 'config.skillSources[0].enabled'],
      [{ enabled: true, cwd: '', skillSources: [{ path: '/a', enabled: true, file: 'x' }], readRoots: [] }, 'unknown_field', 'config.skillSources[0].file'],
      [{ enabled: true, cwd: '', skillSources: [{ path: '', enabled: true }], readRoots: [] }, 'empty_path', 'config.skillSources[0].path'],
      [
        { enabled: true, cwd: '', skillSources: Array.from({ length: 9 }, () => ({ path: '/a.md', enabled: true })), readRoots: [] },
        'too_many_items',
        'config.skillSources',
      ],
    ] as const) {
      const result = validateSessionContextConfig(raw);
      expect(result.ok, JSON.stringify(field)).toBe(false);
      if (!result.ok) {
        expect(result.issue.code, field).toBe(code);
        expect(result.issue.field, field).toBe(field);
      }
    }
  });

  it('validates save requests with a non-negative integer revision', () => {
    const good = validateSessionContextSaveRequest({ expectedRevision: 0, config: { enabled: false, cwd: '', skillSources: [], readRoots: [] } });
    expect(good.ok).toBe(true);
    for (const raw of [
      null,
      { expectedRevision: -1, config: { enabled: false, cwd: '', skillSources: [], readRoots: [] } },
      { expectedRevision: 1.5, config: { enabled: false, cwd: '', skillSources: [], readRoots: [] } },
      { expectedRevision: '0', config: { enabled: false, cwd: '', skillSources: [], readRoots: [] } },
      { config: { enabled: false, cwd: '', skillSources: [], readRoots: [] } },
      { expectedRevision: 0, config: { enabled: false, cwd: '', skillSources: [], readRoots: [] }, bindings: {} },
    ]) {
      expect(validateSessionContextSaveRequest(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it('decodes persisted records and keeps corrupt values as invalid without fallback', () => {
    expect(decodeSessionContextRecord(undefined)).toBeNull();
    const record = {
      schemaVersion: 1,
      revision: 3,
      config: { enabled: true, cwd: '/tmp/x', skillSources: [{ path: '/tmp/a.md', enabled: true }], readRoots: [] },
      bindings: {
        cwd: { path: '/private/tmp/x', dev: 1, ino: 2 },
        skills: [{ path: '/private/tmp', dev: 1, ino: 3, index: 0, file: '/private/tmp/a.md' }],
        roots: [{ path: '/private/tmp/m', dev: 1, ino: 4, index: 0 }],
      },
    };
    const decoded = decodeSessionContextRecord(record);
    expect(decoded && decoded.kind).toBe('saved');
    if (decoded && decoded.kind === 'saved') {
      expect(decoded.record.revision).toBe(3);
      expect(decoded.record.bindings.skills[0].file).toBe('/private/tmp/a.md');
      expect(decoded.record.bindings.cwd?.ino).toBe(2);
    }
    for (const [raw, reason] of [
      ['string', '损坏的保存记录'],
      [{}, '不支持的 schemaVersion'],
      [{ ...record, schemaVersion: 2 }, '不支持的 schemaVersion'],
      [{ ...record, revision: -1 }, '损坏的 revision'],
      [{ ...record, config: { enabled: 'x' } }, '损坏的配置'],
      [{ ...record, bindings: 'x' }, undefined],
    ] as const) {
      const result = decodeSessionContextRecord(raw);
      if (reason === undefined) {
        // bindings 形状损坏时回退为空绑定，而不是整条判损坏
        expect(result && result.kind).toBe('saved');
      } else {
        expect(result && result.kind, reason).toBe('invalid');
      }
    }
  });
});
