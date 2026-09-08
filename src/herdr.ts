import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { AppError, type HerdrPort } from './types.js';

/** Supported Herdr NDJSON socket protocol. Never invent caller context or use UI focus. */
export class Herdr implements HerdrPort {
  constructor(public socketPath: string) {}
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      let buffer = '';
      let settled = false;
      const socket = net.createConnection(this.socketPath);
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish(
            new AppError(
              'herdr_timeout',
              `${method}: response timed out; delivery may be ambiguous`,
              503,
            ),
          ),
        timeoutMs,
      );
      socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
      socket.on('error', (e) =>
        finish(new AppError('herdr_unavailable', `${method}: ${e.message}`, 503)),
      );
      socket.on('close', () =>
        finish(
          new AppError('herdr_disconnected', `${method}: disconnected before acknowledgement`, 503),
        ),
      );
      socket.on('data', (data) => {
        buffer += data.toString();
        if (buffer.length > 8 * 1024 * 1024)
          return finish(new Error('Herdr response exceeded 8 MiB'));
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const v = JSON.parse(line);
            if (v.id !== id) continue;
            if (v.error) finish(new AppError(v.error.code, v.error.message, 502));
            else finish(undefined, v.result);
          } catch (e) {
            finish(e as Error);
          }
        }
      });
    });
  }
}
