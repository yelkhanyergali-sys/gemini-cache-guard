"use strict";

/**
 * Тесты gemini-cache-guard:
 *  1) юнит core.js (фильтр моделей, keep-alive payload, оценка токенов)
 *  2) интеграция плагина с фейковым pi API + заглушкой fetch
 *
 * Запуск: node test/run.js   (из папки расширения)
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CORE = require("../lib/core.js");
const INDEX = path.join(__dirname, "..", "index.js");

// ---------------------------------------------------------------------------
// Юниты core.js
// ---------------------------------------------------------------------------
function testCore() {
  // isEligibleModel
  assert.equal(
    CORE.isEligibleModel({ id: "gemini-3.8-flash-tiered", api: "openai-completions", baseUrl: "x" }),
    true,
    "gemini через openai-completions должен быть eligible",
  );
  assert.equal(
    CORE.isEligibleModel({ id: "gemini-2.5-pro", api: "openai-completions" }),
    true,
    "старый gemini через openai-completions тоже eligible",
  );
  assert.equal(
    CORE.isEligibleModel({ id: "claude-sonnet-4-6", api: "openai-completions" }),
    false,
    "claude не eligible",
  );
  assert.equal(
    CORE.isEligibleModel({ id: "gemini-3.8-flash", api: "google-generative-ai" }),
    false,
    "gemini на native google api не eligible",
  );
  assert.equal(CORE.isEligibleModel(null), false);
  assert.equal(CORE.isEligibleModel({}), false);

  // buildKeepAlivePayload
  const original = {
    model: "gemini-3.8-flash-tiered",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ],
    stream: true,
    temperature: 0.7,
    max_tokens: 64,
    max_completion_tokens: 999,
    tool_choice: "auto",
    stream_options: { include_usage: true },
    tools: [{ type: "function", function: { name: "f" } }],
    prompt_cache_key: "abc",
    session_id: "s1",
  };
  const ka = CORE.buildKeepAlivePayload(original);
  assert.ok(ka, "payload конструируется");
  assert.equal(ka.stream, false);
  assert.equal(ka.max_tokens, 1);
  assert.equal(ka.temperature, 0);
  assert.equal(ka.tool_choice, "none");
  assert.equal(ka.reasoning_effort, "low");
  assert.equal(ka.max_completion_tokens, undefined);
  assert.equal(ka.stream_options, undefined);
  assert.equal(ka.prompt_cache_key, undefined);
  assert.equal(ka.session_id, undefined);
  assert.deepEqual(ka.messages, original.messages, "messages сохраняются байт-в-байт");
  assert.deepEqual(ka.tools, original.tools, "tools сохраняются (часть префикса)");
  assert.equal(ka.model, original.model);

  assert.equal(CORE.buildKeepAlivePayload(null), null);
  assert.equal(CORE.buildKeepAlivePayload({ model: "x" }), null);
  assert.equal(CORE.buildKeepAlivePayload({ messages: [] }), null);

  // estimateInputTokens
  const big = { messages: [{ role: "user", content: "x".repeat(4000) }] };
  assert.ok(CORE.estimateInputTokens(big) >= 900, "примерно 4 символа → 1 токен");
  assert.equal(CORE.estimateInputTokens(null), 0);
  assert.equal(CORE.estimateInputTokens({ messages: undefined }), 0);

  console.log("core.js: OK");
}

// ---------------------------------------------------------------------------
// Helpers для интеграции
// ---------------------------------------------------------------------------
function makePiStub() {
  const handlers = new Map();
  const stub = {
    handlers,
    on(event, fn) {
      let arr = handlers.get(event);
      if (!arr) {
        arr = [];
        handlers.set(event, arr);
      }
      arr.push(fn);
    },
    emit(event, payload, ctx) {
      const arr = handlers.get(event) || [];
      for (const fn of arr) fn(payload || { type: event }, ctx);
    },
  };
  return stub;
}

function loadPlugin(envOverrides, piStub) {
  const saved = {};
  for (const k of Object.keys(envOverrides)) {
    saved[k] = process.env[k];
    process.env[k] = String(envOverrides[k]);
  }
  delete require.cache[INDEX];
  let factory;
  try {
    factory = require(INDEX);
    factory(piStub); // так же, как loadExtension: await factory(api)
  } finally {
    for (const k of Object.keys(envOverrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const GEMINI_MODEL = {
  id: "gemini-3.8-flash-tiered",
  api: "openai-completions",
  baseUrl: "http://rotator:51200/v1",
};

function bigPayload(n) {
  return {
    model: GEMINI_MODEL.id,
    messages: [{ role: "user", content: "x".repeat(n) }],
    stream: true,
    temperature: 0.7,
    max_tokens: 64,
    tools: [{ type: "function", function: { name: "f" } }],
  };
}

function installFetchStub(calls) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      status: 200,
      text: async () =>
        JSON.stringify({
          usage: { prompt_tokens_details: { cached_tokens: 100_000 } },
        }),
    };
  };
  return () => {
    globalThis.fetch = prev;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Интеграция 1: пинг уходит для Gemini, с корректным keep-alive телом
// ---------------------------------------------------------------------------
async function testPluginPingsGemini() {
  const logFile = path.join(__dirname, ".test-1.log");
  try { fs.unlinkSync(logFile); } catch { /* noop */ }

  const pi = makePiStub();
  const calls = [];
  const restore = installFetchStub(calls);

  loadPlugin(
    {
      GEMINI_CACHE_GUARD_ENABLED: "1",
      GEMINI_CACHE_GUARD_INTERVAL_MS: "150",
      GEMINI_CACHE_GUARD_MIN_DELAY_MS: "50",
      GEMINI_CACHE_GUARD_IDLE_CAP_MS: "2000",
      GEMINI_CACHE_GUARD_MIN_CONTEXT_TOKENS: "100",
      GEMINI_CACHE_GUARD_TIMEOUT_MS: "500",
      GEMINI_CACHE_GUARD_ENDPOINT: "http://stub/v1",
      GEMINI_CACHE_GUARD_API_KEY: "test-key",
      GEMINI_CACHE_GUARD_LOG: logFile,
    },
    pi,
  );

  pi.emit("session_start", { type: "session_start" });
  pi.emit("model_select", { type: "model_select", model: GEMINI_MODEL }, { model: GEMINI_MODEL });
  pi.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: bigPayload(4000) },
    { model: GEMINI_MODEL },
  );

  await sleep(700);

  assert.ok(calls.length >= 2, `ожидалось минимум 2 пинга, получено ${calls.length}`);
  for (const c of calls) {
    assert.equal(c.url, "http://stub/v1/chat/completions");
    assert.equal(c.init.method, "POST");
    assert.match(c.init.headers.Authorization, /^Bearer test-key$/);
    const body = JSON.parse(c.init.body);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 1);
    assert.equal(body.temperature, 0);
    assert.equal(body.tool_choice, "none");
    assert.equal(body.messages.length, 1);
  }

  // Проверяем, что пинг не пишет в сессию: у заглушки нет sendUserMessage,
  // и плагин при этом не падает — уже доказано отсутствием исключений.
  pi.emit("session_shutdown", { type: "session_shutdown" });
  restore();
  console.log("plugin pings gemini: OK");
}

// ---------------------------------------------------------------------------
// Интеграция 2: не-Gemini модель → сторож выключен, пингов нет
// ---------------------------------------------------------------------------
async function testPluginIgnoresNonGemini() {
  const logFile = path.join(__dirname, ".test-2.log");
  const pi = makePiStub();
  const calls = [];
  const restore = installFetchStub(calls);

  loadPlugin(
    {
      GEMINI_CACHE_GUARD_ENABLED: "1",
      GEMINI_CACHE_GUARD_INTERVAL_MS: "120",
      GEMINI_CACHE_GUARD_MIN_DELAY_MS: "30",
      GEMINI_CACHE_GUARD_IDLE_CAP_MS: "2000",
      GEMINI_CACHE_GUARD_MIN_CONTEXT_TOKENS: "10",
      GEMINI_CACHE_GUARD_TIMEOUT_MS: "300",
      GEMINI_CACHE_GUARD_ENDPOINT: "http://stub/v1",
      GEMINI_CACHE_GUARD_LOG: logFile,
    },
    pi,
  );

  pi.emit("model_select", { type: "model_select", model: { id: "claude-sonnet", api: "openai-completions" } }, {});
  pi.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: bigPayload(4000) },
    { model: { id: "claude-sonnet", api: "openai-completions" } },
  );

  await sleep(400);

  assert.equal(calls.length, 0, "не-Gemini не должен пинговать");
  pi.emit("session_shutdown", { type: "session_shutdown" });
  restore();
  console.log("plugin ignores non-gemini: OK");
}

// ---------------------------------------------------------------------------
// Интеграция 3: idle cap — после периода простоя пинги останавливаются
// ---------------------------------------------------------------------------
async function testPluginIdleCap() {
  const logFile = path.join(__dirname, ".test-3.log");
  const pi = makePiStub();
  const calls = [];
  const restore = installFetchStub(calls);

  loadPlugin(
    {
      GEMINI_CACHE_GUARD_ENABLED: "1",
      GEMINI_CACHE_GUARD_INTERVAL_MS: "120",
      GEMINI_CACHE_GUARD_MIN_DELAY_MS: "30",
      GEMINI_CACHE_GUARD_IDLE_CAP_MS: "400",
      GEMINI_CACHE_GUARD_MIN_CONTEXT_TOKENS: "10",
      GEMINI_CACHE_GUARD_TIMEOUT_MS: "300",
      GEMINI_CACHE_GUARD_ENDPOINT: "http://stub/v1",
      GEMINI_CACHE_GUARD_LOG: logFile,
    },
    pi,
  );

  pi.emit("model_select", { type: "model_select", model: GEMINI_MODEL }, { model: GEMINI_MODEL });
  pi.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: bigPayload(4000) },
    { model: GEMINI_MODEL },
  );

  await sleep(900);
  const countAtCap = calls.length;
  await sleep(500);
  assert.equal(calls.length, countAtCap, `после idle cap пинги должны остановиться (было ${countAtCap})`);
  pi.emit("session_shutdown", { type: "session_shutdown" });
  restore();
  console.log("plugin stops after idle cap: OK");
}

// ---------------------------------------------------------------------------
// Интеграция 4: маленький контекст не пингуется; смена сессии гасит сторож
// ---------------------------------------------------------------------------
async function testPluginSmallCtxAndSessionStop() {
  const logFile = path.join(__dirname, ".test-4.log");
  const pi = makePiStub();
  const calls = [];
  const restore = installFetchStub(calls);

  loadPlugin(
    {
      GEMINI_CACHE_GUARD_ENABLED: "1",
      GEMINI_CACHE_GUARD_INTERVAL_MS: "100",
      GEMINI_CACHE_GUARD_MIN_DELAY_MS: "30",
      GEMINI_CACHE_GUARD_IDLE_CAP_MS: "2000",
      GEMINI_CACHE_GUARD_MIN_CONTEXT_TOKENS: "1000",
      GEMINI_CACHE_GUARD_TIMEOUT_MS: "300",
      GEMINI_CACHE_GUARD_ENDPOINT: "http://stub/v1",
      GEMINI_CACHE_GUARD_LOG: logFile,
    },
    pi,
  );

  pi.emit("session_start", { type: "session_start" });
  pi.emit("model_select", { type: "model_select", model: GEMINI_MODEL }, { model: GEMINI_MODEL });
  // маленький контекст (~250 симв.)
  pi.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: bigPayload(1000) },
    { model: GEMINI_MODEL },
  );

  await sleep(400);
  assert.equal(calls.length, 0, "маленький контекст не должен пинговаться");

  // теперь большой контекст, потом session_start — сторож должен погаснуть
  pi.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: bigPayload(6000) },
    { model: GEMINI_MODEL },
  );
  await sleep(200);
  assert.ok(calls.length >= 1, "большой контекст должен пинговаться");
  const countBefore = calls.length;

  pi.emit("session_start", { type: "session_start" });
  // без нового gemini-запроса сторож мертв
  await sleep(400);
  assert.equal(calls.length, countBefore, "session_start должен остановить пинги");
  pi.emit("session_shutdown", { type: "session_shutdown" });
  restore();
  console.log("plugin skips small ctx + stops on session_start: OK");
}

// ---------------------------------------------------------------------------
// Интеграция 5: endpoint/apiKey резолвятся из ctx.modelRegistry (реальный путь)
// ---------------------------------------------------------------------------
async function testPluginResolvesEndpointFromRegistry() {
  const logFile = path.join(__dirname, ".test-5.log");
  const pi = makePiStub();
  const calls = [];
  const restore = installFetchStub(calls);

  const registry = {
    getApiKeyAndHeaders: async () => ({
      ok: true,
      baseUrl: "http://rotator.example/v1",
      apiKey: "secret-key",
    }),
  };

  loadPlugin(
    {
      GEMINI_CACHE_GUARD_ENABLED: "1",
      GEMINI_CACHE_GUARD_INTERVAL_MS: "150",
      GEMINI_CACHE_GUARD_MIN_DELAY_MS: "50",
      GEMINI_CACHE_GUARD_IDLE_CAP_MS: "2000",
      GEMINI_CACHE_GUARD_MIN_CONTEXT_TOKENS: "100",
      GEMINI_CACHE_GUARD_TIMEOUT_MS: "500",
      // НЕТ GEMINI_CACHE_GUARD_ENDPOINT — проверяем путь через реестр
      GEMINI_CACHE_GUARD_LOG: logFile,
    },
    pi,
  );

  const ctx = { model: GEMINI_MODEL, modelRegistry: registry };
  pi.emit("model_select", { type: "model_select", model: GEMINI_MODEL }, ctx);
  pi.emit("before_provider_request", { type: "before_provider_request", payload: bigPayload(4000) }, ctx);

  await sleep(400);

  assert.ok(calls.length >= 1, "ping должен уйти через endpoint из реестра");
  const c = calls[0];
  assert.equal(c.url, "http://rotator.example/v1/chat/completions");
  assert.match(c.init.headers.Authorization, /^Bearer secret-key$/);

  pi.emit("session_shutdown", { type: "session_shutdown" });
  restore();
  console.log("plugin resolves endpoint from modelRegistry: OK");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  testCore();
  await testPluginPingsGemini();
  await testPluginIgnoresNonGemini();
  await testPluginIdleCap();
  await testPluginSmallCtxAndSessionStop();
  await testPluginResolvesEndpointFromRegistry();
  console.log("\nALL TESTS PASSED");
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});