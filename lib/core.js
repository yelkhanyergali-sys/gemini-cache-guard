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
 * Грубая оценка входных токенов: ~4 символа на токен.
 * Точность не критична — нужна лишь граница «кэш вообще имеет смысл».
 */
function estimateInputTokens(payload) {
  if (!payload) return 0;
  try {
    const data = Array.isArray(payload.messages) ? payload.messages : payload;
    return Math.max(0, Math.floor(JSON.stringify(data).length / 4));
  } catch {
    return 0;
  }
}

module.exports = { isEligibleModel, buildKeepAlivePayload, estimateInputTokens };