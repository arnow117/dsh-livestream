import { describe, expect, it } from 'vitest';
import { defaultTtsSettings, mergeTtsSettings } from '../src/shared/ttsSettings';

describe('TTS settings', () => {
  it('uses legacy defaults and keeps explicit saved values', () => {
    const defaults = defaultTtsSettings({ DSH_LIVESTREAM_TTS_BACKEND: 'yovoice', DSH_LIVESTREAM_YOVOICE_VOICE: '  原声音  ' }, 'legacy');
    expect(defaults.backend).toBe('yovoice');
    expect(defaults.yovoiceVoice).toBe('原声音');
    expect(mergeTtsSettings(defaults, { yovoiceVoice: ' 新声音 ', doubaoVoice: '' })).toMatchObject({ yovoiceVoice: '新声音', doubaoVoice: '' });
  });

  it('rejects unknown fields, wrong types and invalid values', () => {
    const defaults = defaultTtsSettings({}, '');
    for (const patch of [{ unknown: 1 }, { doubaoRate: '1' }, { doubaoRate: 101 }, { yovoiceVoice: '  ' }, { backend: 'other' }, { yovoiceVoice: '\ud800' }, { macosVoice: 'a'.repeat(101) }]) {
      expect(() => mergeTtsSettings(defaults, patch)).toThrow();
    }
  });
  it('exposes unsupported legacy defaults for correction but rejects them on merge', () => {
    const legacy = defaultTtsSettings({ DSH_LIVESTREAM_YOVOICE_MODEL: 'old-model', DSH_LIVESTREAM_YOVOICE_VOICE: 'a'.repeat(501) }, '');
    expect(legacy.yovoiceModel).toBe('old-model');
    expect(() => mergeTtsSettings(legacy, {})).toThrow();
    expect(() => mergeTtsSettings(legacy, { yovoiceModel: 'voxcpm2-q8' })).toThrow();
    expect(mergeTtsSettings(legacy, { yovoiceModel: 'voxcpm2-q8', yovoiceVoice: '修正' })).toMatchObject({ yovoiceModel: 'voxcpm2-q8', yovoiceVoice: '修正' });
    expect(mergeTtsSettings(legacy, {}, { allowInvalidCurrent: true })).toEqual(legacy);
  });

  it('counts Unicode characters and rejects unpaired surrogates', () => {
    const defaults = defaultTtsSettings({}, '');
    expect(mergeTtsSettings(defaults, { yovoiceVoice: '😀'.repeat(500) }).yovoiceVoice).toHaveLength(1000);
    expect(() => mergeTtsSettings(defaults, { yovoiceVoice: '😀'.repeat(501) })).toThrow();
    expect(() => mergeTtsSettings(defaults, { yovoiceVoice: '\ud800' })).toThrow();
    expect(() => mergeTtsSettings(defaults, { doubaoVoice: '\udfff' })).toThrow();
  });

});
