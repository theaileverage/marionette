export function authorized(request, origin, prefix) {
  const url = new URL(request.url);
  return (
    url.origin === origin &&
    url.pathname.startsWith(prefix) &&
    (!request.headers.has('origin') || request.headers.get('origin') === origin)
  );
}
export function parseInput(message) {
  if (typeof message !== 'string' || message.length > 65536) return null;
  try {
    const value = JSON.parse(message);
    if (value?.type === 'input' && typeof value.data === 'string') return value;
    if (
      value?.type === 'resize' &&
      Number.isInteger(value.cols) &&
      Number.isInteger(value.rows) &&
      value.cols >= 2 &&
      value.cols <= 500 &&
      value.rows >= 2 &&
      value.rows <= 200
    )
      return value;
  } catch {}
  return null;
}
