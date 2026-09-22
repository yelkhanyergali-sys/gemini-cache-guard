# gemini-cache-guard

Фоновый keep-alive для Gemini-моделей, подключённых к PI через OpenAI-completions
совместимый ротатор (`agy` → tuxevil :51200).

## Проблема

Неявный кэш Gemini (Antigravity / Cloud Code) живёт ~5 минут. Если пользователь
отошёл и вернулся позже, следующий реальный запрос уходит в холод — весь контекст
(часто 100–160k токенов) прогоняется заново и в секунды выжигает квоту (TPM)
и заставляет ротатор веерно жечь все аккаунты (429 каскад).

## Решение

Плагин запоминает последний реальный payload Gemini-запроса и, пока пользователь
молчит, каждые `INTERVAL_MS` (по умолчанию 3 мин) отправляет **тот же префикс**
на тот же endpoint, но с `stream=false, max_tokens=1, temperature=0`.
Google отвечает cache hit, продлевая TTL кэша. Сессию не трогает:
никаких сообщений, никаких вызовов в контекст, след только в лог-файле.

## Поведение

| Событие | Действие |
|---|---|
| `before_provider_request` (gemini + openai-completions) | запоминает payload, сбрасывает таймер |
| Модель не gemini / native google api | сторож полностью выключен |
| `intervalMs` без активности | фоновый keep-alive пинг |
| Любой `input` / `turn_end` / `agent_settled` | отмена висящего пинга, сброс таймера |
| Простой больше `idleCapMs` (30 мин) | сторож гаснет, кэш остывает |
| Смена модели / `session_start` / `session_shutdown` / закрытие pi | полная остановка |

Дополнительно: пинг не уходит для контекста меньше `minContextTokens` (8k токенов)
— кэшу Google всё равно нечего греть.

## Настройка (env-переменные, необязательны)

| Переменная | По умолчанию |
|---|---|
| `GEMINI_CACHE_GUARD_ENABLED` | `1` |
| `GEMINI_CACHE_GUARD_INTERVAL_MS` | `180000` (3 мин) |
| `GEMINI_CACHE_GUARD_IDLE_CAP_MS` | `1800000` (30 мин) |
| `GEMINI_CACHE_GUARD_TIMEOUT_MS` | `8000` |
| `GEMINI_CACHE_GUARD_MIN_CONTEXT_TOKENS` | `8192` |
| `GEMINI_CACHE_GUARD_ENDPOINT` | авто (из `model.baseUrl` → `/chat/completions`) |
| `GEMINI_CACHE_GUARD_API_KEY` | пусто (берётся из modelRegistry) |
| `GEMINI_CACHE_GUARD_LOG` | `/tmp/gemini-cache-guard.log` |
| `GEMINI_CACHE_GUARD_MIN_DELAY_MS` | `1000` (техническое, для тестов) |

## Установка

Путь `~/.pi/agent/extensions/gemini-cache-guard` добавлен
в `settings.json` → `extensions`. Плагин активируется после `/reload` или
перезапуска pi.

## Лог

```
2026-09-22T21:00:00.000Z ping 200 est=163687 cached=163000 ms=1204
2026-09-22T21:04:00.000Z guard off: idle cap reached (1800s without activity)
```

`cached` — сколько токенов Google отдал из кэша (cache hit подтверждён).

## Тесты

```bash
node test/run.js   # юнит core + интеграция с фейковым pi
```