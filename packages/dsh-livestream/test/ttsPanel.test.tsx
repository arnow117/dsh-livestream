// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtsSettingsPanel } from '../src/console/console';
import { defaultTtsSettings } from '../src/shared/ttsSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('voice settings panel', () => {
  let element: HTMLDivElement;
  let root: Root;
  let resolvePreview: (response: Response) => void;
  let signals: AbortSignal[];
  const revoke = vi.fn();
  const onSaved = vi.fn();

  const button = (text: string) => [...element.querySelectorAll('button')].find((item) => item.textContent === text)!;
  const change = async (label: string, value: string) => {
    const field = [...element.querySelectorAll('label')].find((item) => item.textContent?.startsWith(label))!.querySelector('input,textarea,select') as HTMLInputElement;
    await act(async () => { field.value = value; Simulate.change(field); });
  };
  const click = async (text: string) => act(async () => { button(text).click(); });

  beforeEach(async () => {
    signals = [];
    element = document.createElement('div');
    document.body.append(element);
    root = createRoot(element);
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return new Promise<Response>((resolve) => { resolvePreview = resolve; });
    }));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: revoke }));
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const initial = { ...defaultTtsSettings({}, ''), backend: 'yovoice' as const };
    await act(async () => root.render(<TtsSettingsPanel initial={initial} onSaved={onSaved} secrets={{}} />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    element.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    revoke.mockReset();
    onSaved.mockReset();
  });

  it('discards late responses after an edit and aborts on close', async () => {
    await click('试听');
    expect(element.textContent).toContain('正在生成试听');
    const late = resolvePreview;
    await change('音色描述', '新描述');
    expect(signals[0].aborted).toBe(true);
    await act(async () => late(new Response(new Blob(['old']), { headers: { 'content-type': 'audio/mpeg' } })));
    expect(element.querySelector('audio')).toBeNull();
    await click('试听');
    expect(signals[1].aborted).toBe(false);
    await act(async () => root.unmount());
    expect(signals[1].aborted).toBe(true);
    root = createRoot(element);
  });

  it('releases a ready preview when switching backend and shows errors', async () => {
    await click('试听');
    await act(async () => resolvePreview(new Response(new Blob(['audio']))));
    expect(element.querySelector('audio')).not.toBeNull();
    await change('语音后端', 'macos');
    expect(revoke).toHaveBeenCalledWith('blob:test');
    expect(element.querySelector('audio')).toBeNull();
    await click('试听');
    await act(async () => resolvePreview(Response.json({ error: '服务不可用' }, { status: 503 })));
    expect(element.textContent).toContain('服务不可用');
  });
  it('shows credential requirements, empty input, and save outcomes', async () => {
    await change('语音后端', 'doubao');
    expect(element.textContent).toContain('豆包语音 API Key');
    expect(element.textContent).toContain('豆包 APP ID');
    await change('豆包音色 ID', 'legacy-speaker');
    expect(element.textContent).toContain('豆包 Access Key');
    await change('试听文字', '  ');
    expect(button('试听').disabled).toBe(true);
    expect(element.textContent).toContain('请填写试听文字');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false, error: '保存失败' }, { status: 500 }));
    await click('保存声音');
    expect(element.textContent).toContain('保存失败');
    expect((element.querySelector('input[placeholder="留空跟随角色"]') as HTMLInputElement).value).toBe('legacy-speaker');
    const savedTts = { ...defaultTtsSettings({}, ''), backend: 'doubao', doubaoVoice: 'legacy-speaker' };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true, settings: { tts: savedTts } }));
    await click('保存声音');
    expect(element.textContent).toContain('已保存');
    expect(onSaved).toHaveBeenCalled();
  });

  it('releases ready audio on unmount', async () => {
    await click('试听');
    await act(async () => resolvePreview(new Response(new Blob(['audio']))));
    const audio = element.querySelector('audio')!;
    await act(async () => Simulate.play(audio));
    expect(element.textContent).toContain('正在播放试听');
    await act(async () => Simulate.pause(audio));
    expect(element.textContent).toContain('试听已准备好');
    await act(async () => Simulate.play(audio));
    await act(async () => Simulate.ended(audio));
    expect(element.textContent).toContain('试听已准备好');
    await act(async () => root.unmount());
    expect(revoke).toHaveBeenCalledWith('blob:test');
    root = createRoot(element);
  });

  it('locks edits while saving, cancels preview, and ignores a late save after close', async () => {
    await click('试听');
    const previewSignal = signals[0];
    await click('保存声音');
    const saveSignal = signals[1];
    expect(previewSignal.aborted).toBe(true);
    expect(element.querySelector('fieldset')?.disabled).toBe(true);
    await click('保存声音');
    expect(signals).toHaveLength(2);
    expect(element.textContent).toContain('正在保存声音');
    const savedTts = { ...defaultTtsSettings({}, ''), backend: 'yovoice' };
    const finishSave = resolvePreview;
    await act(async () => root.unmount());
    expect(saveSignal.aborted).toBe(true);
    await act(async () => finishSave(Response.json({ ok: true, settings: { tts: savedTts } })));
    expect(onSaved).not.toHaveBeenCalled();
    root = createRoot(element);
  });

  it('keeps unsaved status across preview, cancel, errors and failed saves', async () => {
    expect(element.textContent).toContain('声音设置：已生效');
    await change('试听文字', '另一句');
    expect(element.textContent).toContain('声音设置：已生效');
    await change('音色描述', '新的描述');
    expect(element.textContent).toContain('声音设置：未保存');
    const refreshed = { ...defaultTtsSettings({}, ''), backend: 'yovoice' as const, yovoiceVoice: '外部变化' };
    await act(async () => root.render(<TtsSettingsPanel initial={refreshed} onSaved={onSaved} secrets={{}} />));
    expect((element.querySelector('textarea') as HTMLTextAreaElement).value).toBe('新的描述');
    expect(element.textContent).toContain('声音设置：未保存');
    await click('试听');
    await act(async () => resolvePreview(new Response(new Blob(['audio']))));
    expect(element.textContent).toContain('声音设置：未保存');
    await click('取消试听');
    expect(element.textContent).toContain('声音设置：未保存');
    await click('试听');
    await act(async () => resolvePreview(Response.json({ error: '试听失败' }, { status: 502 })));
    expect(element.textContent).toContain('声音设置：未保存');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false, error: '保存失败' }, { status: 500 }));
    await click('保存声音');
    expect(element.textContent).toContain('声音设置：未保存');
    expect(element.textContent).toContain('保存失败');
    const savedTts = { ...defaultTtsSettings({}, ''), backend: 'yovoice', yovoiceVoice: '新的描述' };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true, settings: { tts: savedTts } }));
    await click('保存声音');
    expect(element.textContent).toContain('声音设置：已生效');
    expect(element.textContent).not.toContain('声音设置：未保存');
  });

});
