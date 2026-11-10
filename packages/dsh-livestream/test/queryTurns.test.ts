import { describe, expect, it } from 'vitest';
import { QueryTurns } from '../src/dsh/queryTurns';

describe('query turn ownership', () => {
  it('retains an invalidated query lease when the same turn takes another step after an epoch change', () => {
    const turns = new QueryTurns();
    const agent = {};
    const signal = new AbortController().signal;
    turns.remember('query', [{ participant: 'owner', text: '北京天气如何' }]);
    const old = turns.begin(agent, 1, 's', 'old-epoch', signal, [{ id: 'query' }]);
    expect(turns.claim(old)).toBe(true);
    turns.invalidateAll();
    const continuation = turns.begin(agent, 1, 's', 'new-epoch', new AbortController().signal, []);
    expect(continuation).toBe(old);
    expect(turns.forTurn('s', 1)).toBe(old);
    expect(continuation.called).toBe(true);
    expect(continuation.valid()).toBe(false);
    const next = turns.begin(agent, 2, 's', 'new-epoch', new AbortController().signal, []);
    expect(next.valid()).toBe(true);
    expect(next).not.toBe(old);
  });

  it('binds input to the actual agent, turn, epoch and signal, and enforces one remote call', () => {
    const turns = new QueryTurns();
    const agent = {};
    const signal = new AbortController();
    turns.remember('message-a', [{ participant: 'a', text: '北京天气' }]);
    const lease = turns.begin(agent, 5, 'session', 'epoch', signal.signal, [{ id: 'message-a' }]);
    expect(lease.inputs).toEqual([{ participant: 'a', text: '北京天气' }]);
    expect(turns.find(agent, signal.signal)).toBe(lease);
    expect(turns.find({}, signal.signal)).toBeUndefined();
    expect(turns.find(agent, new AbortController().signal)).toBeUndefined();
    expect(turns.claim(lease)).toBe(true);
    expect(turns.claim(lease)).toBe(false);
    signal.abort();
    expect(lease.valid()).toBe(false);
  });

  it('does not borrow a location from another participant or an unrelated input', () => {
    const turns = new QueryTurns();
    const signal = new AbortController();
    turns.remember('message', [{ participant: 'a', text: '天气怎样' }, { participant: 'b', text: '我在北京' }]);
    const lease = turns.begin({}, 1, 's', 'e', signal.signal, [{ id: 'message' }]);
    expect(turns.authorizesWeather(lease, '北京')).toBe(false);
  });
});

it('accepts a city-only clarification only from the participant who asked and only in the same epoch', () => {
  const turns = new QueryTurns();
  const agent = {};
  const signal1 = new AbortController();
  turns.remember('q', [{ participant: 'a', text: '天气如何' }]);
  const question = turns.begin(agent, 1, 's', 'e', signal1.signal, [{ id: 'q' }]);
  turns.observeReply(question, '请问是哪个城市？');
  turns.finishTurn(question);
  turns.remember('b', [{ participant: 'b', text: '北京' }]);
  const other = turns.begin(agent, 2, 's', 'e', new AbortController().signal, [{ id: 'b' }]);
  expect(turns.authorizesWeather(other, '北京')).toBe(false);
  turns.remember('a', [{ participant: 'a', text: '北京' }]);
  const same = turns.begin(agent, 3, 's', 'e', new AbortController().signal, [{ id: 'a' }]);
  expect(turns.authorizesWeather(same, '北京')).toBe(true);
  turns.invalidateAll();
  turns.remember('new', [{ participant: 'a', text: '北京' }]);
  const nextEpoch = turns.begin(agent, 4, 's', 'new', new AbortController().signal, [{ id: 'new' }]);
  expect(turns.authorizesWeather(nextEpoch, '北京')).toBe(false);
});

it('does not send a public-search query that was not in the current trusted input', () => {
  const turns = new QueryTurns();
  turns.remember('q', [{ participant: 'a', text: 'OBS Studio 许可证是什么' }]);
  const lease = turns.begin({}, 1, 's', 'e', new AbortController().signal, [{ id: 'q' }]);
  expect(turns.authorizesSearch(lease, 'OBS Studio 许可证')).toBe(true);
  expect(turns.authorizesSearch(lease, '另一个人的私有问题')).toBe(false);
});

it('requires an explicit matching date instead of treating a relative or dated forecast as current weather', () => {
  const turns = new QueryTurns();
  turns.remember('relative', [{ participant: 'a', text: '北京明天天气如何' }]);
  const relative = turns.begin({}, 1, 's', 'e', new AbortController().signal, [{ id: 'relative' }]);
  expect(turns.authorizesWeather(relative, '北京')).toBe(false);
  turns.remember('dated', [{ participant: 'a', text: '北京 2026-11-12 天气预报' }]);
  const dated = turns.begin({}, 2, 's', 'e', new AbortController().signal, [{ id: 'dated' }]);
  expect(turns.authorizesWeather(dated, '北京')).toBe(false);
  expect(turns.authorizesWeather(dated, '北京', '2026-11-12')).toBe(true);
  expect(turns.authorizesWeather(dated, '北京', '2026-11-13')).toBe(false);
});

it('retains a location only for the same participant’s bounded date clarification', () => {
  const turns = new QueryTurns();
  const agent = {};
  turns.remember('question', [{ participant: 'a', text: '北京天气预报' }]);
  const question = turns.begin(agent, 1, 's', 'e', new AbortController().signal, [{ id: 'question' }]);
  turns.observeReply(question, '请明确查询日期。');
  turns.finishTurn(question);
  turns.remember('date', [{ participant: 'a', text: '2026-11-12' }]);
  const clarification = turns.begin(agent, 2, 's', 'e', new AbortController().signal, [{ id: 'date' }]);
  expect(turns.authorizesWeather(clarification, '北京', '2026-11-12')).toBe(true);
  turns.remember('other', [{ participant: 'b', text: '2026-11-12' }]);
  const other = turns.begin(agent, 3, 's', 'e', new AbortController().signal, [{ id: 'other' }]);
  expect(turns.authorizesWeather(other, '北京')).toBe(false);
});

it('accepts the fully specified location from the same participant after clarification', () => {
  const turns = new QueryTurns();
  const agent = {};
  turns.remember('question', [{ participant: 'a', text: '朝阳天气如何' }]);
  const question = turns.begin(agent, 1, 's', 'e', new AbortController().signal, [{ id: 'question' }]);
  turns.observeReply(question, '请一次写全省和市，例如辽宁省朝阳市。');
  turns.finishTurn(question);
  turns.remember('answer', [{ participant: 'a', text: '辽宁省朝阳市' }]);
  const answer = turns.begin(agent, 2, 's', 'e', new AbortController().signal, [{ id: 'answer' }]);
  expect(turns.authorizesWeather(answer, '辽宁省朝阳市')).toBe(true);
  turns.remember('other', [{ participant: 'b', text: '辽宁省朝阳市' }]);
  const other = turns.begin(agent, 3, 's', 'e', new AbortController().signal, [{ id: 'other' }]);
  expect(turns.authorizesWeather(other, '辽宁省朝阳市')).toBe(false);
});

it('keeps the date and unresolved future intent with the same participant through clarification', () => {
  const turns = new QueryTurns();
  const agent = {};
  turns.remember('question', [{ participant: 'a', text: '2026-11-12天气如何' }]);
  const question = turns.begin(agent, 1, 's', 'e', new AbortController().signal, [{ id: 'question' }]);
  turns.observeReply(question, '请问是哪个城市？');
  turns.finishTurn(question);
  turns.remember('answer', [{ participant: 'a', text: '北京' }]);
  const answer = turns.begin(agent, 2, 's', 'e', new AbortController().signal, [{ id: 'answer' }]);
  expect(turns.authorizesWeather(answer, '北京', '2026-11-12')).toBe(true);
  expect(turns.authorizesWeather(answer, '北京')).toBe(false);
  turns.remember('other', [{ participant: 'b', text: '北京' }]);
  const other = turns.begin(agent, 3, 's', 'e', new AbortController().signal, [{ id: 'other' }]);
  expect(turns.authorizesWeather(other, '北京', '2026-11-12')).toBe(false);
});

it('retains one participant’s location across a second explicit clarification', () => {
  const turns = new QueryTurns();
  const agent = {};
  turns.remember('question', [{ participant: 'a', text: '明天天气如何' }]);
  const question = turns.begin(agent, 1, 's', 'e', new AbortController().signal, [{ id: 'question' }]);
  turns.observeReply(question, '请问是哪个城市？');
  turns.finishTurn(question);
  turns.remember('city', [{ participant: 'a', text: '北京' }]);
  const city = turns.begin(agent, 2, 's', 'e', new AbortController().signal, [{ id: 'city' }]);
  turns.observeReply(city, '请提供明确日期。');
  turns.finishTurn(city);
  turns.remember('other-date', [{ participant: 'b', text: '2026-11-12' }]);
  const other = turns.begin(agent, 3, 's', 'e', new AbortController().signal, [{ id: 'other-date' }]);
  expect(turns.authorizesWeather(other, '北京', '2026-11-12')).toBe(false);
  turns.remember('date', [{ participant: 'a', text: '2026-11-12' }]);
  const date = turns.begin(agent, 4, 's', 'e', new AbortController().signal, [{ id: 'date' }]);
  expect(turns.authorizesWeather(date, '北京', '2026-11-12')).toBe(true);
  turns.invalidateAll();
  turns.remember('new-date', [{ participant: 'a', text: '2026-11-12' }]);
  const newEpoch = turns.begin(agent, 5, 's', 'new', new AbortController().signal, [{ id: 'new-date' }]);
  expect(turns.authorizesWeather(newEpoch, '北京', '2026-11-12')).toBe(false);
});

it('does not merge a second clarification from another participant or beyond the context bound', () => {
  for (const cityInput of [
    { participant: 'b', text: '北京' },
    { participant: 'a', text: `北京${'长'.repeat(2000)}` },
  ]) {
    const turns = new QueryTurns();
    const agent = {};
    turns.remember('question', [{ participant: 'a', text: '明天天气如何' }]);
    const question = turns.begin(agent, 1, 's', 'e', new AbortController().signal, [{ id: 'question' }]);
    turns.observeReply(question, '请问是哪个城市？');
    turns.finishTurn(question);
    turns.remember('city', [cityInput]);
    const city = turns.begin(agent, 2, 's', 'e', new AbortController().signal, [{ id: 'city' }]);
    turns.observeReply(city, '请提供明确日期。');
    turns.finishTurn(city);
    turns.remember('date', [{ participant: 'a', text: '2026-11-12' }]);
    const date = turns.begin(agent, 3, 's', 'e', new AbortController().signal, [{ id: 'date' }]);
    expect(turns.authorizesWeather(date, '北京', '2026-11-12')).toBe(false);
  }
});

it.each(['北京今晚天气如何', '北京明日天气如何', '北京今夜天气', '北京明晨天气', '北京明晚天气', '北京明早天气', '北京下月天气', '北京会下雨吗'])(
  'asks for an absolute date before querying %s as current weather',
  (text) => {
    const turns = new QueryTurns();
    turns.remember(text, [{ participant: 'a', text }]);
    const lease = turns.begin({}, 1, 's', 'e', new AbortController().signal, [{ id: text }]);
    expect(turns.authorizesWeather(lease, '北京')).toBe(false);
  },
);

it('continues to accept an unqualified current weather question', () => {
  const turns = new QueryTurns();
  turns.remember('question', [{ participant: 'a', text: '北京天气如何' }]);
  const question = turns.begin({}, 1, 's', 'e', new AbortController().signal, [{ id: 'question' }]);
  expect(turns.authorizesWeather(question, '北京')).toBe(true);
});

it('accepts one complete weather question beside unrelated input, without joining different participants', () => {
  const turns = new QueryTurns();
  turns.remember('mixed', [
    { participant: 'a', text: '北京现在几度' },
    { participant: 'b', text: '你好' },
  ]);
  const mixed = turns.begin({}, 1, 's', 'e', new AbortController().signal, [{ id: 'mixed' }]);
  expect(turns.authorizesWeather(mixed, '北京')).toBe(true);
  turns.remember('split', [
    { participant: 'a', text: '北京天气如何' },
    { participant: 'b', text: '2026-11-12天气如何' },
  ]);
  const split = turns.begin({}, 2, 's', 'e', new AbortController().signal, [{ id: 'split' }]);
  expect(turns.authorizesWeather(split, '北京', '2026-11-12')).toBe(false);
  turns.remember('conflict', [
    { participant: 'a', text: '北京 2026-11-12 天气' },
    { participant: 'b', text: '北京 2026-11-13 天气' },
  ]);
  const conflict = turns.begin({}, 3, 's', 'e', new AbortController().signal, [{ id: 'conflict' }]);
  expect(turns.authorizesWeather(conflict, '北京', '2026-11-12')).toBe(false);
});

it.each([
  ['北京当前天气', true],
  ['北京目前天气', true],
  ['北京前天天气', false],
  ['北京明天天气', false],
  ['北京当前天气和明天天气', false],
  ['北京目前天气和前天天气', false],
] as const)('keeps time intent distinct for %s', (text, allowed) => {
  const turns = new QueryTurns();
  turns.remember('question', [{ participant: 'a', text }]);
  const question = turns.begin({}, 1, 's', 'e', new AbortController().signal, [{ id: 'question' }]);
  expect(turns.authorizesWeather(question, '北京')).toBe(allowed);
});
