import { test, expect } from 'bun:test';
import { authorized, parseInput } from './security.mjs';
test('terminal rejects foreign origins, hosts and missing capability paths', () => {
  const origin = 'http://127.0.0.1:1234';
  const request = (url, source) => new Request(url, { headers: source ? { origin: source } : {} });
  expect(authorized(request(origin + '/secret/pty', origin), origin, '/secret/')).toBe(true);
  expect(
    authorized(request(origin + '/secret/pty', 'https://evil.example'), origin, '/secret/'),
  ).toBe(false);
  expect(authorized(request('http://evil.example:1234/secret/pty'), origin, '/secret/')).toBe(
    false,
  );
  expect(authorized(request(origin + '/pty'), origin, '/secret/')).toBe(false);
});
test('terminal messages bound dimensions and payloads and reject malformed input', () => {
  for (const value of [
    '{',
    'null',
    '{}',
    JSON.stringify({ type: 'resize', cols: -1, rows: 24 }),
    JSON.stringify({ type: 'resize', cols: 80.5, rows: 24 }),
    'x'.repeat(65537),
  ])
    expect(parseInput(value)).toBeNull();
  expect(parseInput(JSON.stringify({ type: 'input', data: 'echo ok\r' }))?.data).toBe('echo ok\r');
  expect(parseInput(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))?.cols).toBe(120);
});
