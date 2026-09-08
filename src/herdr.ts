import { HerdrClient, HerdrError } from './herdr-sdk.js';
import { AppError, type HerdrPort } from './types.js';

/** Adapt the standalone SDK's errors to Marionette's HTTP boundary. */
export class Herdr extends HerdrClient implements HerdrPort {
  override async call<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10000,
  ): Promise<T> {
    try {
      return await super.call<T>(method, params, timeoutMs);
    } catch (error) {
      if (error instanceof HerdrError)
        throw new AppError(error.code, error.message, error.code.startsWith('herdr_') ? 503 : 502);
      throw error;
    }
  }
}
