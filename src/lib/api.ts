import type { ApiError as ApiErrorShape } from '@shared/types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(shape: ApiErrorShape, status: number) {
    super(shape.message);
    this.name = 'ApiError';
    this.code = shape.code;
    this.status = status;
    this.details = shape.details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Неизвестная ошибка';
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorShape;
}

const panelAuthCodes = new Set(['UNAUTHORIZED', 'BAD_TOKEN']);

export async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 0,
): Promise<T> {
  let response: Response;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...init,
      signal: controller?.signal ?? init.signal,
    });
  } catch (error) {
    const aborted =
      controller?.signal.aborted ||
      (error instanceof DOMException && error.name === 'AbortError');
    if (aborted) {
      throw new ApiError(
        {
          code: 'TIMEOUT',
          message:
            'Backend не ответил вовремя. Операция могла завершиться — проверьте звуки и бэкапы перед повтором.',
        },
        0,
      );
    }
    throw new ApiError(
      { code: 'NETWORK', message: 'Backend недоступен. Проверьте, что он запущен.' },
      0,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await response.text();
  let payload: ApiEnvelope<T> | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      payload = null;
    }
  }
  if (
    response.status === 401 &&
    !path.startsWith('/auth/login') &&
    panelAuthCodes.has(payload?.error?.code ?? '')
  ) {
    window.dispatchEvent(new CustomEvent('acc:unauthorized'));
  }
  if (!response.ok || !payload?.ok) {
    const shape =
      payload?.error ??
      ({
        code: `HTTP_${response.status}`,
        message: text.slice(0, 300) || `Ошибка HTTP ${response.status}`,
      } satisfies ApiErrorShape);
    throw new ApiError(shape, response.status);
  }
  return payload.data as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const api = {
  get<T>(path: string, timeoutMs = 0): Promise<T> {
    return request<T>(path, undefined, timeoutMs);
  },
  post<T>(path: string, body: unknown = {}, timeoutMs = 0): Promise<T> {
    return request<T>(path, jsonInit('POST', body), timeoutMs);
  },
  put<T>(path: string, body: unknown = {}): Promise<T> {
    return request<T>(path, jsonInit('PUT', body));
  },
  patch<T>(path: string, body: unknown = {}): Promise<T> {
    return request<T>(path, jsonInit('PATCH', body));
  },
  delete<T>(path: string, body: unknown = {}): Promise<T> {
    return request<T>(path, jsonInit('DELETE', body));
  },
  form<T>(path: string, form: FormData): Promise<T> {
    return request<T>(path, { method: 'POST', body: form }, 120_000);
  },
};

export function apiUrl(path: string): string {
  return `/api${path}`;
}

export function triggerDownload(href: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
