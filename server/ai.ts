import type { AiConfig } from '../shared/types.ts';
import { AccError } from './errors.ts';

const DEFAULT_TIMEOUT_MS = 75_000;

export interface AiCallOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface AiCallResult {
  content: string;
  model: string;
  elapsedMs: number;
}

export function aiEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new AccError('AI_NOT_CONFIGURED', 'Адрес ИИ-сервера некорректен. Проверьте настройки.', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AccError('AI_NOT_CONFIGURED', 'ИИ-сервер должен использовать http или https', 400);
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions') || path.endsWith('/openai')) {
    return url.toString().replace(/\/+$/, '');
  }
  return `${url.toString().replace(/\/+$/, '')}/chat/completions`;
}

function extractContent(payload: unknown): string {
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? String((part as { text: string }).text)
            : '',
      )
      .join('');
    if (text.trim()) return text;
  }
  throw new AccError('AI_BAD_RESPONSE', 'ИИ вернул пустой ответ. Попробуйте ещё раз.', 502);
}

export async function callAi(
  config: AiConfig,
  messages: Array<{ role: string; content: string }>,
  options: AiCallOptions = {},
): Promise<AiCallResult> {
  if (!config.baseUrl.trim() || !config.model.trim()) {
    throw new AccError(
      'AI_NOT_CONFIGURED',
      'ИИ не настроен. Откройте «Настройки» → «ИИ-генератор» и выберите провайдера.',
      409,
    );
  }
  const endpoint = aiEndpoint(config.baseUrl);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.8,
        max_tokens: options.maxTokens ?? 2600,
      }),
      signal: controller.signal,
    });
  } catch (caught) {
    const aborted = caught instanceof Error && caught.name === 'AbortError';
    throw new AccError(
      aborted ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE',
      aborted
        ? `ИИ не ответил за ${Math.round(timeoutMs / 1000)} секунд. Проверьте сервер или выберите модель быстрее.`
        : 'Не удалось связаться с ИИ-сервером. Проверьте адрес, интернет и запущен ли сервер.',
      502,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      // Not 401: the frontend logs the user out of ACC on any panel 401.
      throw new AccError('AI_AUTH', 'ИИ-сервер отклонил ключ. Проверьте API-ключ в настройках.', 502);
    }
    if (response.status === 404) {
      throw new AccError(
        'AI_ENDPOINT',
        'ИИ-сервер не нашёл endpoint или модель. Проверьте base URL и название модели.',
        404,
      );
    }
    if (response.status === 429) {
      throw new AccError('AI_RATE_LIMITED', 'ИИ-сервер ограничил частоту запросов. Подождите и повторите.', 429);
    }
    const detail = (await response.text().catch(() => '')).slice(0, 240);
    throw new AccError(
      'AI_UPSTREAM',
      `ИИ-сервер ответил ошибкой ${response.status}${detail ? `: ${detail}` : ''}`,
      502,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AccError('AI_BAD_RESPONSE', 'ИИ-сервер вернул ответ не в формате JSON.', 502);
  }
  return {
    content: extractContent(payload),
    model: config.model,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function testAiConnection(config: AiConfig): Promise<{ reply: string; model: string; elapsedMs: number }> {
  const result = await callAi(
    config,
    [
      {
        role: 'user',
        content: 'Ответь ровно одним словом: работает',
      },
    ],
    { maxTokens: 24, temperature: 0, timeoutMs: 45_000 },
  );
  return {
    reply: result.content.trim().slice(0, 200),
    model: result.model,
    elapsedMs: result.elapsedMs,
  };
}
