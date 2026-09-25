"use strict";

/**
 * Чистая логика gemini-cache-guard: фильтр моделей, построение keep-alive
 * payload'а, оценка размера контекста. Без зависимостей от pi/Node runtime —
 * покрыта юнит-тестами в test/run.js.
 */

const GEMINI_ID_RE = /gemini/i;

/**
 * Плагин работает ТОЛЬКО с Gemini-моделями, подключёнными через
 * OpenAI-completions совместимый ротатор (наш кейс: agy → tuxevil).
 * Нативные google / vertex адаптеры не используют /chat/completions —
 * их сторожить нечем и незачем.
 */
function isEligibleModel(model) {
  if (!model || typeof model !== "object") return false;
  const id = String(model.id || model.model || "");
  if (!GEMINI_ID_RE.test(id)) return false;
  const api = String(model.api || model.apiType || "");
  return api === "openai-completions";
}

/**
 * Превращает последний реальный payload запроса в минимальный keep-alive:
 * тот же префикс (messages), но без генерации видимого вывода.
 */
function buildKeepAlivePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) return null;

  let clone;
  try {
    clone = JSON.parse(JSON.stringify(payload));
  } catch {
    return null;
  }

  clone.stream = false;
  clone.max_tokens = 1;
  clone.temperature = 0;
  clone.tool_choice = "none";
  clone.reasoning_effort = "low";

  // Параметры, которые не нужны и могут сбить ротатор/совместимость.
  delete clone.max_completion_tokens;
  delete clone.stream_options;
  delete clone.store;
  delete clone.prompt_cache_key;
  delete clone.prompt_cache_retention;
  delete clone.prompt_cache_options;
  delete clone.session_id;
  delete clone.x_client_request_id;
  delete clone.x_session_affinity;

  return clone;
}

/**
 * Извлекает число закэшированных токенов из usage-ответа.
 * Ротатор отдаёт поле под разными именами в зависимости от пути:
 *  - /v1/chat/completions            → usage.prompt_tokens_details.cached_tokens
 *  - /v1/messages (Anthropic-путь)   → usage.input_tokens_details.cached_tokens
 *  - плоский вариант                 → usage.cached_tokens
 * Читаем все три, иначе сторож «слепнет» (графа cached= пустая).
 */
function parseCachedTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const details =
    (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? usage.prompt_tokens_details
      : null) ||
    (usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? usage.input_tokens_details
      : null);
  if (details && details.cached_tokens != null) return details.cached_tokens;
  if (usage.cached_tokens != null) return usage.cached_tokens;
  return null;
}

/**
 * Грубая оценка входных токенов.
 * Латиница: ~4 символа на токен. Кириллица и прочие не-ASCII символы
 * токенизируются почти посимвольно (~1.2 символа на токен), поэтому
 * наивное деление на 4 занижает реальный размер в 2–3 раза.
 * Точность не критична — нужна лишь граница «кэш вообще имеет смысл».
 */
function estimateInputTokens(payload) {
  if (!payload) return 0;
  try {
    const data = Array.isArray(payload.messages) ? payload.messages : payload;
    const text = JSON.stringify(data);
    let ascii = 0;
    let nonAscii = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) < 128) ascii++;
      else nonAscii++;
    }
    return Math.max(0, Math.floor(ascii / 4 + nonAscii / 1.2));
  } catch {
    return 0;
  }
}

module.exports = { isEligibleModel, buildKeepAlivePayload, estimateInputTokens, parseCachedTokens };