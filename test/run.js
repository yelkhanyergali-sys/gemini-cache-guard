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

  // estimateInputTokens: кириллица считается почти посимвольно (≈1.2 симв/токен)
  const cyr = { messages: [{ role: "user", content: "ф".repeat(1200) }] };
  const cyrEst = CORE.estimateInputTokens(cyr);
  assert.ok(cyrEst >= 800, `кириллица не должна занижаться: est=${cyrEst}`);
  assert.ok(cyrEst > CORE.estimateInputTokens({ messages: [{ role: "user", content: "x".repeat(1200) }] }),
    "кириллица должна оцениваться выше латиницы той же длины");

  // parseCachedTokens: оба пути ротатора + плоский вариант
  assert.equal(CORE.parseCachedTokens({ prompt_tokens_details: { cached_tokens: 5 } }), 5);
  assert.equal(CORE.parseCachedTokens({ input_tokens_details: { cached_tokens: 7 } }), 7);
  assert.equal(CORE.parseCachedTokens({ cached_tokens: 9 }), 9);
  assert.equal(CORE.parseCachedTokens({}), null);
  assert.equal(CORE.parseCachedTokens(null), null);

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

function installFetchStub(calls, opts) {
  opts = opts || {};
  const prev = globalThis.fetch;
  const usage = opts.usage !== undefined ? opts.usage
    : { prompt_tokens_details: { cached_tokens: 100_000 } };
  let status = opts.status !== undefined ? opts.status : 200;
  let statusSeq = Array.isArray(opts.statusSeq) ? opts.statusSeq.slice() : null;
  const headers = opts.headers || null;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const st = statusSeq && statusSeq.length ? statusSeq.shift() : status;
    const hdr = {};
    if (headers) Object.assign(hdr, headers);
    if (opts.accountHeader) hdr["x-rotator-account"] = opts.accountHeader;
    return {
      status: st,
      headers: { get: (name) => hdr[String(name).toLowerCase()] ?? null },
      text: async () => (st >= 500 && opts.errorBody !== undefined ? opts.errorBody : JSON.stringify({ usage })),
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
// Интеграция 6: три подряд 429 → сторож гаснет (backoff), лог содержит причину
// ---------------------------------------------------------------------------
async function testPluginBacksOffOnRepeatedErrors() {
  const logFile = path.join(__dirname, ".test-6.log");
  try { fs.unlinkSync(logFile); } catch { /* noop */ }
  const pi = makePiStub();
  const calls = [];
  const restore = installFetchStub(calls, { status: 429, errorBody: '{"error":{"message":"Rate limit"}}' });

  loadPlugin(
    {
      GEMINI_CACHE_GUARD_ENABLED: "1",
      GEMINI_CACHE_GUARD_INTERVAL_MS: "100",
      GEMINI_CACHE_GUARD_MIN_DELAY_MS: "20",
      GEMINI_CACHE_GUARD_IDLE_CAP_MS: "5000",
      GEMINI_CACHE_GUARD_MIN_CONTEXT_TOKENS: "10",
      GEMINI_CACHE_GUARD_TIMEOUT_MS: "300",
      GEMINI_CACHE_GUARD_MAX_ERRORS: "3",
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

  await sleep(1200);
  const countAtBackoff = calls.length;
  assert.ok(countAtBackoff >= 3 && countAtBackoff <= 4,
    `ожидалось ~3 пинга до backoff, получено ${countAtBackoff}`);
  await sleep(500);
  assert.equal(calls.length, countAtBackoff, "после backoff пинги должны остановиться");
  const log = fs.readFileSync(logFile, "utf-8");
  assert.match(log, /too many consecutive ping errors/, "лог должен содержать причину backoff");

  // Реальная активность снимает backoff: новый запрос снова взводит сторож.
  // Итог: disableGuard очистил lastPayload, поэтому нужен свежий запрос.
  pi.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: bigPayload(4000) },
    { model: GEMINI_MODEL },
  );
  await sleep(400);
  assert.ok(calls.length > countAtBackoff, "после новой активности пинги возобновляются");

  pi.emit("session_shutdown", { type: "session_shutdown" });
  restore();
  console.log("plugin backs off on repeated 429: OK");
}

// ---------------------------------------------------------------------------
// Интеграция 7: Anthropic-путь usage (input_tokens_details) тоже читается
// ---------------------------------------------------------------------------
async function testPluginReadsAnthropicUsagePath() {
  const logFile = path.join(__dirname, ".test-7.log");
  try { fs.unlinkSync(logFile); } catch { /* noop */ }
  const pi = makePiStub();
  const calls = [];
  const restore = installFetchStub(calls, {
    usage: { input_tokens_details: { cached_tokens: 4242 } },
    accountHeader: null,
  });

  loadPlugin(
    {
      GEMINI_CACHE_GUARD_ENABLED: "1",
      GEMINI_CACHE_GUARD_INTERVAL_MS: "120",
      GEMINI_CACHE_GUARD_MIN_DELAY_MS: "30",
      GEMINI_CACHE_GUARD_IDLE_CAP_MS: "3000",
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

  await sleep(500);
  assert.ok(calls.length >= 1, "пинг должен уйти");
  const log = fs.readFileSync(logFile, "utf-8");
  assert.match(log, /cached=4242/, "лог должен содержать cached=4242 из input_tokens_details");
  pi.emit("session_shutdown", { type: "session_shutdown" });
  restore();
  console.log("plugin reads anthropic usage path: OK");
}

// ---------------------------------------------------------------------------
// Интеграция 8: payload клонируется на захвате (мутация ядра не портит пинг)
// ---------------------------------------------------------------------------
async function testPluginClonesPayloadOnCapture() {
  const logFile = path.join(__dirname, ".test-8.log");
  try { fs.unlinkSync(logFile); } catch { /* noop */ }
  const pi = makePiStub();
  const calls = [];
  const restore = installFetchStub(calls);

  loadPlugin(
    {
      GEMINI_CACHE_GUARD_ENABLED: "1",
      GEMINI_CACHE_GUARD_INTERVAL_MS: "120",
      GEMINI_CACHE_GUARD_MIN_DELAY_MS: "30",
      GEMINI_CACHE_GUARD_IDLE_CAP_MS: "3000",
      GEMINI_CACHE_GUARD_MIN_CONTEXT_TOKENS: "10",
      GEMINI_CACHE_GUARD_TIMEOUT_MS: "300",
      GEMINI_CACHE_GUARD_ENDPOINT: "http://stub/v1",
      GEMINI_CACHE_GUARD_LOG: logFile,
    },
    pi,
  );

  pi.emit("model_select", { type: "model_select", model: GEMINI_MODEL }, { model: GEMINI_MODEL });
  const original = bigPayload(4000);
  pi.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: original },
    { model: GEMINI_MODEL },
  );
  // Ядро мутирует payload на месте ПОСЛЕ захвата сторожем.
  original.messages[0].content = "MUTATED";
  original.messages.push({ role: "user", content: "INJECTED" });

  await sleep(500);
  assert.ok(calls.length >= 1, "пинг должен уйти");
  const body = JSON.parse(calls[0].init.body);
  assert.ok(!JSON.stringify(body).includes("MUTATED"), "пинг не должен содержать мутацию");
  assert.ok(!JSON.stringify(body).includes("INJECTED"), "пинг не должен содержать инъекцию");
  pi.emit("session_shutdown", { type: "session_shutdown" });
  restore();
  console.log("plugin clones payload on capture: OK");
}

// ---------------------------------------------------------------------------
// Интеграция 9: интервал выдерживается между последовательными пингами
// ---------------------------------------------------------------------------
async function testPluginPacingHonorsInterval() {
  const logFile = path.join(__dirname, ".test-9.log");
  try { fs.unlinkSync(logFile); } catch { /* noop */ }
  const pi = makePiStub();
  const calls = [];
  const timestamps = [];
  const restore = installFetchStub(calls);
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    timestamps.push(Date.now());
    return prevFetch(url, init);
  };

  loadPlugin(
    {
      GEMINI_CACHE_GUARD_ENABLED: "1",
      GEMINI_CACHE_GUARD_INTERVAL_MS: "120",
      GEMINI_CACHE_GUARD_MIN_DELAY_MS: "20",
      GEMINI_CACHE_GUARD_IDLE_CAP_MS: "3000",
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

  // Спим 320ms. При интервале 120ms должно быть ровно 2 пинга (≈120ms, ≈240ms), а не спам!
  await sleep(320);
  assert.equal(calls.length, 2, `ожидалось ровно 2 пинга за 320ms при интервале 120ms, получено ${calls.length}`);
  const gap = timestamps[1] - timestamps[0];
  assert.ok(gap >= 95, `интервал между пингами должен быть >=95ms, получен gap=${gap}ms`);

  pi.emit("session_shutdown", { type: "session_shutdown" });
  restore();
  console.log("plugin honors ping interval pacing: OK");
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
  await testPluginBacksOffOnRepeatedErrors();
  await testPluginReadsAnthropicUsagePath();
  await testPluginClonesPayloadOnCapture();
  await testPluginPacingHonorsInterval();
  console.log("\nALL TESTS PASSED");
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});