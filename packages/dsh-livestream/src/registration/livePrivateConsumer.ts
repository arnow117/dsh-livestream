export async function consumeLivePrivate<T>(options: {
  assertCurrent: () => void;
  readOriginal: () => Promise<T>;
}): Promise<T> {
  options.assertCurrent();
  const result = await options.readOriginal();
  options.assertCurrent();
  return result;
}
