// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from '../src/lib/api.ts';

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('session handling on 401', () => {
  it('logs out when the panel itself requires a token', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockImplementation(() => true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Требуется авторизация' } }),
      ),
    );

    await expect(request('/auth/status')).rejects.toThrow('Требуется авторизация');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'acc:unauthorized' }),
    );
  });

  it('keeps the session when an upstream service rejects its key', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockImplementation(() => true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(502, { ok: false, error: { code: 'AI_AUTH', message: 'ИИ-сервер отклонил ключ' } }),
      ),
    );

    await expect(request('/settings/ai/test', { method: 'POST' })).rejects.toThrow('ИИ-сервер отклонил ключ');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
