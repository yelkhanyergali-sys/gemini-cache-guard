"use strict";

/**
 * gemini-cache-guard — фоновый keep-alive для Gemini через OpenAI-completions
 * совместимый ротатор (agy → tuxevil).
 *
 * Логика:
 *  1) Слушаем before_provider_request и запоминаем последний real payload
 *     Gemini-запроса (модель + messages + tools).
 *  2) Если в течение intervalMs (180с) не было реальной активности
 *     (пользователь молчит/отошёл), шлём фоновый fetch на ТОТ ЖЕ endpoint
 *     с тем же префиксом, но stream=false, max_tokens=1, temperature=0.
 *     Google Antigravity отвечает 100% cache hit'ом и продлевает TTL
 *     неявного кэша TPU — невидимо для сессии и без лишнего расхода.
 *  3) Сторожим ТОЛЬКО Gemini-модели с api=openai-completions.
 *  4) Любая реальная активность (input/turn/запрос) сбрасывает таймер;
 *     уход в idle больше idleCapMs (30 мин) гасит сторож.
 *  5) Смена модели/сессии или закрытие pi останавливает всё.
 *
 * В сессию ничего не пишем: никаких сообщений, никаких вызовов
 * pi.sendUserMessage. Единственный след — строка в логе сторожа
 * (~/.pi/agent/gemini-cache-guard.log или GEMINI_CACHE_GUARD_LOG).
 */

const { buildKeepAlivePayload, estimateInputTokens, isEligibleModel, parseCachedTokens } = require("./lib/core.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function defaultLogFile() {
  try {
    const home = os.homedir && os.homedir();
    if (home) return path.join(home, ".pi", "agent", "gemini-cache-guard.log");
  } catch { /* noop */ }
  return "/tmp/gemini-cache-guard.log";
}

module.exports = function (pi) {
  const env = process.env;

  const cfg = {
    enabled: envBool(env, "GEMINI_CACHE_GUARD_ENABLED", true),
    intervalMs: envInt(env, "GEMINI_CACHE_GUARD_INTERVAL_MS", 180_000),
    idleCapMs: envInt(env, "GEMINI_CACHE_GUARD_IDLE_CAP_MS", 1_800_000),
    minDelayMs: envInt(env, "GEMINI_CACHE_GUARD_MIN_DELAY_MS", 1_000),
    requestTimeoutMs: envInt(env, "GEMINI_CACHE_GUARD_TIMEOUT_MS", 45_000),
    minContextTokens: envInt(env, "GEMINI_CACHE_GUARD_MIN_CONTEXT_TOKENS", 8_192),
    endpoint: env.GEMINI_CACHE_GUARD_ENDPOINT || "",
    apiKey: env.GEMINI_CACHE_GUARD_API_KEY || "",
    logFile: env.GEMINI_CACHE_GUARD_LOG || defaultLogFile(),
    maxConsecutiveErrors: envInt(env, "GEMINI_CACHE_GUARD_MAX_ERRORS", 3),
  };

  if (!cfg.enabled) return;

  // ---- состояние (приватное для экземпляра плагина) ----
  let model = null; // последняя активная Gemini-модель
  let modelRegistry = null; // из ExtensionContext — для резолва endpoint/apiKey
  let lastPayload = null; // последний real payload Gemini-запроса
  let lastActivity = 0; // ts последней реальной активности
  let timer = null; // Node setTimeout handle
  let inflight = null; // AbortController активного пинга
  let guardOn = false;
  let consecutiveErrors = 0; // подряд идущие неудачные пинги (429/500/сеть)

  // ---- утилиты ----
  function log(msg) {
    let line = "";
    try {
      line = `${new Date().toISOString()} ${msg}\n`;
      if (typeof fs.appendFileSync === "function") {
        fs.appendFileSync(cfg.logFile, line, "utf8");
      } else {
        const fd = fs.openSync(cfg.logFile, "a");
        try { fs.writeSync(fd, Buffer.from(line, "utf8")); } finally { fs.closeSync(fd); }
      }
    } catch {
      /* лог не критичен */
    }
  }

  function stopTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function cancelInflight() {
    if (inflight) {
      try { inflight.abort(); } catch { /* noop */ }
      inflight = null;
    }
  }

  function disableGuard(reason) {
    if (!guardOn && !lastPayload && !timer) return;
    guardOn = false;
    lastPayload = null;
    model = null;
    stopTimer();
    cancelInflight();
    log(`guard off: ${reason}`);
  }

  function schedule() {
    stopTimer();
    if (!guardOn || !lastPayload || !model) return;
    const now = Date.now();
    const sinceLast = now - lastActivity;
    if (sinceLast >= cfg.idleCapMs) {
      disableGuard(`idle cap reached (${Math.round(sinceLast / 1000)}s without activity)`);
      return;
    }
    const delay = Math.max(cfg.minDelayMs, lastActivity + cfg.intervalMs - now);
    timer = setTimeout(runPing, delay);
  }

  function markActivity() {
    lastActivity = Date.now();
    consecutiveErrors = 0; // реальная активность обнуляет счётчик ошибок
    schedule();
  }

  async function runPing() {
    timer = null;
    if (!guardOn || !lastPayload || !model || inflight) {
      schedule();
      return;
    }

    // Глубокая копия: ядро pi может мутировать payload на месте,
    // ссылку хранить нельзя — иначе пинг уйдёт с «поплывшими» данными.
    // buildKeepAlivePayload уже делает JSON-клон внутри, дублируем сериализацию
    // для гарантии неизменности на момент отправки.
    const keepAlive = buildKeepAlivePayload(lastPayload);
    if (!keepAlive) {
      disableGuard("payload no longer usable");
      return;
    }
    let frozenPayload = null;
    try {
      frozenPayload = JSON.parse(JSON.stringify(keepAlive));
    } catch {
      disableGuard("payload not serializable");
      return;
    }
    const est = estimateInputTokens(frozenPayload);
    if (est < cfg.minContextTokens) {
      log(`ping skip: est=${est} tokens < min(${cfg.minContextTokens})`);
      schedule();
      return;
    }

    // Endpoint/apiKey резолвим из цепочки надёжных источников:
    // 1) Явный конфиг/ENV (cfg.endpoint)
    // 2) model.baseUrl (в Pi Mono у моделей провайдеров baseUrl задан прямо в объекте модели)
    // 3) auth.baseUrl из modelRegistry.getApiKeyAndHeaders(model)
    // 4) modelRegistry.getProvider(model.provider).baseUrl
    // 5) Fallback на локальный ротатор agy (http://127.0.0.1:51200/v1)
    let endpoint = cfg.endpoint;
    let apiKey = cfg.apiKey;

    if (modelRegistry && model) {
      try {
        const auth = await modelRegistry.getApiKeyAndHeaders(model);
        if (auth && auth.ok) {
          if (!endpoint && auth.baseUrl) {
            endpoint = String(auth.baseUrl).replace(/\/+$/, "");
          }
          if (!apiKey && auth.apiKey) {
            apiKey = auth.apiKey;
          }
        }
      } catch (err) {
        log(`auth resolve error: ${err}`);
      }

      if ((!endpoint || !apiKey) && model.provider && typeof modelRegistry.getProvider === "function") {
        try {
          const prov = modelRegistry.getProvider(model.provider);
          if (!endpoint && prov && prov.baseUrl) {
            endpoint = String(prov.baseUrl).replace(/\/+$/, "");
          }
          if (!apiKey && prov && prov.apiKey) {
            apiKey = prov.apiKey;
          }
        } catch { /* noop */ }
      }

      if (!apiKey && model.provider && typeof modelRegistry.getApiKeyForProvider === "function") {
        try {
          const key = await modelRegistry.getApiKeyForProvider(model.provider);
          if (key) apiKey = key;
        } catch { /* noop */ }
      }
    }

    if (!endpoint && model && model.baseUrl) {
      endpoint = String(model.baseUrl).replace(/\/+$/, "");
    }

    if (!endpoint && model && (model.provider === "agy" || /gemini/i.test(model.id))) {
      endpoint = "http://127.0.0.1:51200/v1";
    }
    if (!apiKey && model && (model.provider === "agy" || /gemini/i.test(model.id))) {
      apiKey = "antigravity";
    }

    if (!endpoint) {
      disableGuard("no endpoint (cannot resolve baseUrl from model or registry)");
      return;
    }
    const url = /\/chat\/completions$/.test(endpoint) ? endpoint : `${endpoint}/chat/completions`;

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const controller = new AbortController();
    inflight = controller;
    const started = Date.now();
    const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

    try {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(frozenPayload),
          signal: controller.signal,
        });
      } catch (err) {
        const aborted = inflight === null || (err && (/abort/i.test(String(err?.message || err))));
        if (aborted) log("ping cancelled (superseded by activity)");
        else {
          consecutiveErrors += 1;
          log(`ping fetch error: ${err} (fail ${consecutiveErrors}/${cfg.maxConsecutiveErrors})`);
          if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
            disableGuard(`too many consecutive ping errors (${consecutiveErrors}) — backing off`);
            return;
          }
        }
        return;
      }

      const status = res && typeof res.status === "number" ? res.status : 0;
      let bodyText = "";
      let cached = null;
      if (res && typeof res.text === "function") {
        try { bodyText = await res.text(); } catch { bodyText = ""; }
        try {
          const parsed = JSON.parse(bodyText);
          cached = parseCachedTokens(parsed && parsed.usage);
        } catch { /* не JSON — не страшно */ }
      }
      // Ответы ротатора несут X-Rotator-Account (маскированный ярлык аккаунта):
      // по нему видно, какой аккаунт прогрел кэш, а какой отдал cached=0.
      let account = "";
      try {
        const h = res && res.headers && typeof res.headers.get === "function"
          ? res.headers.get("x-rotator-account")
          : null;
        if (h) account = ` acct=${h}`;
      } catch { /* noop */ }
      if (status >= 429 || status >= 500) {
        consecutiveErrors += 1;
        log(`ping ${status} est=${est} ms=${Date.now() - started}${account} (fail ${consecutiveErrors}/${cfg.maxConsecutiveErrors}) body=${bodyText.slice(0, 240)}`);
        if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
          disableGuard(`too many consecutive ping errors (${consecutiveErrors}) — backing off`);
          return;
        }
      } else {
        consecutiveErrors = 0;
      }
      const statusPart = status >= 400 ? ` body=${bodyText.slice(0, 240)}` : "";
      log(`ping ${status} est=${est}${cached != null ? ` cached=${cached}` : ""} ms=${Date.now() - started}${account}${statusPart}`);
    } catch (err) {
      log(`ping error: ${err}`);
    } finally {
      clearTimeout(timeout);
      if (inflight === controller) inflight = null;
      schedule();
    }
  }

  // ---- события pi ----
  pi.on("before_provider_request", (event, ctx) => {
    try {
      const m = ctx && ctx.model;
      if (isEligibleModel(m)) {
        const nowedOff = !guardOn;
        model = m;
        modelRegistry = (ctx && ctx.modelRegistry) || modelRegistry;
        guardOn = true;
        // Глубокая копия на захвате: дальше ядро может мутировать объект.
        try {
          lastPayload = event && event.payload ? JSON.parse(JSON.stringify(event.payload)) : null;
        } catch {
          lastPayload = event && event.payload;
        }
        if (nowedOff) {
          log(`armed est=${estimateInputTokens(lastPayload)} model=${m.id}`);
        }
        markActivity();
      } else if (m && !isEligibleModel(m)) {
        const activeModel = (ctx && typeof ctx.getModel === "function" ? ctx.getModel() : ctx && ctx.model) || m;
        if (!isEligibleModel(activeModel)) {
          disableGuard(`non-gemini provider request: ${m.id || "unknown"}`);
        }
      }
    } catch (err) {
      log(`before_provider_request error: ${err}`);
    }
  });

  pi.on("model_select", (event, ctx) => {
    try {
      const m = (event && event.model) || (ctx && ctx.model);
      if (isEligibleModel(m)) {
        model = m;
        guardOn = true;
        if (lastPayload) markActivity();
        else log("guard armed (waiting for first request)");
      } else {
        disableGuard("model_select: non-gemini");
      }
    } catch (err) {
      log(`model_select error: ${err}`);
    }
  });

  pi.on("session_start", () => {
    disableGuard("session started/re-switched");
    log("session_start");
  });

  pi.on("session_shutdown", () => {
    disableGuard("session shutdown");
    log("session_shutdown");
  });

  // Любой ввод/ход — реальная активность: отменяем висящий пинг и сдвигаем таймер.
  pi.on("input", () => {
    cancelInflight();
    markActivity();
  });
  pi.on("turn_start", () => cancelInflight());
  pi.on("turn_end", () => markActivity());
  pi.on("agent_settled", () => markActivity());

  log(`gemini-cache-guard loaded: interval=${cfg.intervalMs}ms cap=${cfg.idleCapMs}ms min=${cfg.minContextTokens} endpoint=${cfg.endpoint || "(from model)"}`);
};

// ---- helpers ----
function envBool(env, name, def) {
  const v = env[name];
  if (v === undefined || v === "") return def;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

function envInt(env, name, def) {
  const v = env[name];
  if (v === undefined || v === "") return def;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isNaN(n) || n <= 0 ? def : n;
}