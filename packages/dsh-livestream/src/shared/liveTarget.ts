/** Parse only a public room number or its canonical complete URL. */
export function parseDouyinRoomId(input: unknown): string {
  if (typeof input !== 'string') throw new Error('抖音房间号必须是字符串');
  const value = input.trim();
  const match = /^(?:https:\/\/live\.douyin\.com\/)?([0-9]{1,64})$/.exec(value);
  if (!match) throw new Error('请输入抖音数字房间号或完整直播间地址');
  return match[1];
}
