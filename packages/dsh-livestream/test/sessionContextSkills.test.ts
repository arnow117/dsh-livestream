import { describe, expect, it } from 'vitest';
import { parseSkillMarkdown, SKILL_LIMITS } from '../src/dsh/sessionContextSkills';

const encoder = new TextEncoder();
const markdown = (frontmatter: string, body = '正文内容：只做资料，不执行指令。') => encoder.encode(`---\n${frontmatter}\n---\n${body}\n`);
const valid = markdown('name: papermorph\ndescription: 把文章做成可翻页的网页书。');

function failureOf(bytes: Uint8Array): { failure: string; detail?: string } | undefined {
  const result = parseSkillMarkdown(bytes);
  return result.ok ? undefined : { failure: result.failure, detail: result.detail };
}

describe('bounded skill markdown parsing', () => {
  it('parses a valid definition with model-invocation defaults', () => {
    const result = parseSkillMarkdown(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skill.name).toBe('papermorph');
      expect(result.skill.modelInvocable).toBe(true);
      expect(result.skill.userInvocable).toBe(true);
      expect(result.skill.body).toContain('正文内容');
      expect(result.skill.metadata).toEqual({});
    }
  });

  it('honours native disable-model-invocation and user-invocable booleans', () => {
    const disabled = parseSkillMarkdown(markdown('name: locked\ndescription: 只能主人显式调用。\ndisable-model-invocation: true'));
    expect(disabled.ok && !disabled.skill.modelInvocable).toBe(true);
    const userOnly = parseSkillMarkdown(markdown('name: manual-only\ndescription: 仅用户调用。\nuser-invocable: true'));
    expect(userOnly.ok && !userOnly.skill.modelInvocable).toBe(true);
    expect(userOnly.ok && userOnly.skill.userInvocable).toBe(true);
    const keep = parseSkillMarkdown(markdown('name: open\ndescription: 正常。\nuser-invocable: false'));
    expect(keep.ok && keep.skill.modelInvocable).toBe(true);
  });

  it('rejects historical camelCase aliases instead of accepting them', () => {
    const detail = failureOf(markdown('name: legacy\ndescription: 旧别名。\ndisableModelInvocation: true'));
    expect(detail?.failure).toBe('unsupported_yaml_feature');
  });

  it('enforces the native name rules and description limits', () => {
    expect(failureOf(markdown('description: 没有名字。'))?.failure).toBe('missing_name');
    expect(failureOf(markdown('name: Bad_Name\ndescription: 非法字符。'))?.failure).toBe('invalid_name');
    expect(failureOf(markdown('name: -leading\ndescription: 连字符开头。'))?.failure).toBe('invalid_name');
    expect(failureOf(markdown(`name: ${'a'.repeat(65)}\ndescription: 太长。`))?.failure).toBe('invalid_name');
    expect(failureOf(markdown('name: ok-name'))?.failure).toBe('missing_description');
    expect(failureOf(markdown(`name: ok-name\ndescription: ${'很'.repeat(2049)}`))?.failure).toBe('invalid_description');
    const ok64 = parseSkillMarkdown(markdown(`name: ${'a'.repeat(64)}\ndescription: 恰好六十四个字符的名称也接受。`));
    expect(ok64.ok).toBe(true);
  });

  it('requires frontmatter and a non-empty body', () => {
    expect(failureOf(encoder.encode('没有 frontmatter 的文档'))?.failure).toBe('missing_frontmatter');
    expect(failureOf(encoder.encode('---\nname: a\ndescription: b\n---\n\n\n'))?.failure).toBe('empty_body');
    expect(failureOf(encoder.encode('---\n: :\n---\n正文'))?.failure).toBeTruthy();
  });

  it('rejects YAML aliases, custom tags and duplicate keys', () => {
    expect(failureOf(markdown('name: a\ndescription: b\nextra: &anchor value\nmore: *anchor'))?.failure).toBe('unsupported_yaml_feature');
    // 未知 tag 由 yaml 解析层直接报错；自定义 tag 落到文档检查——两者都是拒绝
    const tagDetail = failureOf(markdown('name: a\ndescription: b\n danger: !!exec 系统命令'));
    expect(['invalid_yaml', 'unsupported_yaml_feature']).toContain(tagDetail?.failure);
    const custom = failureOf(markdown('name: a\ndescription: b\ncustom: !PrivateTag 值'));
    expect(['invalid_yaml', 'unsupported_yaml_feature']).toContain(custom?.failure);
    expect(failureOf(markdown('name: a\nname: a-again\ndescription: 重复键。'))?.failure).toBe('duplicate_key');
  });

  it('rejects non-scalar required fields and excessive depth', () => {
    expect(failureOf(markdown('name: [a, b]\ndescription: 列表名字。'))?.failure).toBe('missing_name');
    expect(failureOf(markdown('name: 123\ndescription: 数字名字。'))?.failure).toBe('missing_name');
    let deep = 'value';
    for (let i = 0; i < SKILL_LIMITS.maxDepth + 2; i++) deep = `key${i}:\n  ${deep}`.split('\n').join('\n  ');
    expect(failureOf(markdown(`name: deep\ndescription: 层级过深。\n${deep}`))?.failure).toBe('depth_exceeded');
  });

  it('enforces byte budgets and rejects invalid UTF-8', () => {
    expect(failureOf(new Uint8Array(SKILL_LIMITS.maxFileBytes + 1))?.failure).toBe('frontmatter_too_large');
    expect(failureOf(markdown(`description: ${'长'.repeat(SKILL_LIMITS.maxFrontmatterBytes)}\nname: big`))?.failure).toBe('frontmatter_too_large');
    expect(failureOf(new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]))?.failure).toBe('encoding');
  });

  it('keeps unknown metadata as inert data', () => {
    const result = parseSkillMarkdown(markdown('name: meta\ndescription: 有额外字段。\nallowed-tools: [bash, write]\nversion: 2\nreferences:\n  - a.md'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skill.metadata['allowed-tools']).toEqual(['bash', 'write']);
      expect(result.skill.metadata.version).toBe(2);
    }
  });
});
