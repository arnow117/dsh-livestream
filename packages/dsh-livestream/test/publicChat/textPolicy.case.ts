/** 公开文字/模板校验边界（FEAT-008 场景9：敏感语法拒绝与不自动镜像）。 */
import { describe, expect, it } from 'vitest';
import {
  validatePublicText, sanitizeTemplateVariable, renderWelcome, renderGiftThanks, validateTemplateOutput,
} from '../../src/publicChat/textPolicy';

describe('validatePublicText', () => {
  it('拒绝孤立 surrogate 并保留合法 Unicode 字符', () => {
    expect(validatePublicText('文字\ud800').ok).toBe(false);
    expect(validatePublicText('文字\udc00').ok).toBe(false);
    expect(validatePublicText('文字🙂').ok).toBe(true);
    expect(sanitizeTemplateVariable('名字\ud800')).toBeNull();
  });
  it('接受普通非敏感文字', () => {
    expect(validatePublicText('大家好，今天聊聊新功能').ok).toBe(true);
    expect(validatePublicText('  欢迎光临  ').ok).toBe(true);
  });

  it('拒绝空文字与非字符串', () => {
    expect(validatePublicText('').ok).toBe(false);
    expect(validatePublicText('   ').ok).toBe(false);
    expect(validatePublicText(123).ok).toBe(false);
  });

  it('拒绝 URL 与链接语法', () => {
    expect(validatePublicText('看这里 https://example.com/a').ok).toBe(false);
    expect(validatePublicText('去 www.foo.bar 看看').ok).toBe(false);
    expect(validatePublicText('直播间 live.douyin.com/12345 一样的内容').ok).toBe(false);
    expect(validatePublicText('短链 v.douyin.com/abcd').ok).toBe(false);
  });

  it('拒绝邮箱与电话', () => {
    expect(validatePublicText('联系 me@example.com').ok).toBe(false);
    expect(validatePublicText('打我电话 138 0013 8000').ok).toBe(false);
    expect(validatePublicText('电话010-88886666').ok).toBe(false);
  });

  it('拒绝明确微信联系方式标记', () => {
    expect(validatePublicText('加我微信 abc_123').ok).toBe(false);
    expect(validatePublicText('微信号: foo_bar_9').ok).toBe(false);
    expect(validatePublicText('vx号 hello123').ok).toBe(false);
  });

  it('拒绝附件/记录引用语法', () => {
    expect(validatePublicText('附件: report.pdf').ok).toBe(false);
    expect(validatePublicText('data:image/png;base64,xxx').ok).toBe(false);
    expect(validatePublicText('记录: base/123').ok).toBe(false);
  });

  it('拒绝控制字符与零宽字符', () => {
    expect(validatePublicText('正常文字\u0000Hidden').ok).toBe(false);
    expect(validatePublicText('带​零宽的文字').ok).toBe(false);
    expect(validatePublicText('换行\r\n注入').ok).toBe(false);
  });

  it('拒绝超长文字；整条拒发，不截断', () => {
    const longText = '好'.repeat(201);
    const result = validatePublicText(longText);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 拒绝原因指向超长，而不是产出可用的替代文本。
      expect(result.reason).toContain('长度上限');
    }
  });
});

describe('sanitizeTemplateVariable', () => {
  it('完全安全的短名字才回显', () => {
    expect(sanitizeTemplateVariable('小明')).toBe('小明');
  });

  it('含链接/联系方式/控制字符/超长的名字退回 null', () => {
    expect(sanitizeTemplateVariable('https://evil.example')).toBeNull();
    expect(sanitizeTemplateVariable('微信 abc123')).toBeNull();
    expect(sanitizeTemplateVariable('bad\u0000name')).toBeNull();
    expect(sanitizeTemplateVariable('a'.repeat(25))).toBeNull();
    expect(sanitizeTemplateVariable(42)).toBeNull();
    // 部分剥离也绝不回显：未处理的名字不能出现在模板里。
    expect(sanitizeTemplateVariable('小明 http://x')).toBeNull();
  });
});

describe('模板渲染', () => {
  it('欢迎模板回显安全名字或退回固定模板', () => {
    expect(renderWelcome('小明')).toBe('欢迎 小明 来到直播间');
    expect(renderWelcome(null)).toBe('欢迎来到直播间');
  });

  it('礼物感谢模板不提及金额，unknown 不写成 0 元', () => {
    expect(renderGiftThanks('小明', '小星星')).toBe('谢谢 小明 送的 小星星');
    const generic = renderGiftThanks(null, null);
    expect(generic).toBe('谢谢礼物');
    expect(generic).not.toContain('0');
    expect(generic).not.toContain('元');
  });

  it('每条模板产物同样过完整文字校验', () => {
    expect(validateTemplateOutput(renderWelcome('小明')).ok).toBe(true);
    // renderWelcome 只接受已 sanitize 的名字，模板层是最后防线。
  });
});
