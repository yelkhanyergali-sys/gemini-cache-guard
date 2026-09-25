# gemini-cache-guard

[![Tests](https://img.shields.io/badge/tests-10%2F10%20passing-brightgreen)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version: 1.1.0](https://img.shields.io/badge/version-1.1.0-blue)]()

Фоновый keep-alive сторож для языковых моделей Google Gemini, подключённых к PI Coding Agent через OpenAI-совместимый шлюз или ротатор (`agy` → Tuxevil / LiteLLM / Cloud Code).

Автоматически держит неявный контекстный кэш (Implicit TPU Cache) горячим в периоды простоя пользователя с **нулевым расходом токенов генерации** (Zero Quota Burn).

---

## Проблема

Неявный контекстный кэш Google Gemini (Google Antigravity / Cloud Code) имеет время жизни (TTL) всего **~5 минут**. 

Если разработчик отвлёкся на чтение документации, обсуждение архитектуры или отошёл на кофе:
1. Кэш контекста в TPU сбрасывается.
2. Следующий запрос отправляется в «холодную» модель: весь контекст (зачастую **80 000 — 160 000+ токенов**) считывается заново.
3. Время ответа вырастает до 15–30 секунд.
4. Резко сжигается дневной лимит токенов (TPM), провоцируя каскадные ошибки `429 RESOURCE_EXHAUSTED` на всех привязанных аккаунтах ротатора.

---

## Решение и принцип работы (Zero-Quota Burn)

Плагин перехватывает хук ядра PI `before_provider_request` и запоминает префикс последнего реального запроса к Gemini (`model`, `messages`, `tools`).

Пока пользователь молчит, плагин раз в `INTERVAL_MS` (по умолчанию 3 минуты) отправляет тихий фоновый запрос на тот же эндпоинт со специальными параметрами:

```javascript
{
  stream: false,
  max_tokens: 1,
  temperature: 0,
  tool_choice: "none",
  reasoning_effort: "low" // Критично для адаптивных Gemini моделей
}
```

### Почему именно `reasoning_effort: "low"`?
Для моделей нового поколения (Gemini 3.8 / 3.7 Flash) со встроенным адаптивным рассуждением (`thinkingBudget: -1`) обычный запрос с `max_tokens: 1` заставляет ротаторы раздувать бюджет токенов до 8192, сжигая 600+ токенов генерации на пустые размышления. 
Параметр `reasoning_effort: "low"` фиксирует минимальный уровень мышления, ротатор не раздувает лимит вывода, и модель моментально останавливается по длине (`finish_reason: "length"`).

**Итог**: `completion_tokens: 0`, тело ответа строго пустое (`""`), кэш в Google продлевается ещё на 5 минут, а квоты генерации не тратятся вовсе.

---

## Жизненный цикл сторожа

| Событие | Поведение |
|---|---|
| Запрос к модели Gemini (`openai-completions`) | Сторож взводится (`armed`), сохраняет payload и сбрасывает таймер активности. |
| Любой ввод (`input`), начало хода (`turn_start`), завершение (`agent_settled`) | Мгновенная отмена висящего пинга (AbortController) и сдвиг таймера простоя. |
| 180 секунд тишины (при контексте > 8192 токенов) | Отправка тихого фонового keep-alive пинга на ротатор. |
| Модель не Gemini (Claude, GPT, DeepSeek) | Сторож мгновенно деактивируется (`guard off: non-gemini provider request`). |
| Простой более 60 минут (`idleCapMs`) | Сторож автоматически засыпает (`idle cap reached`), предотвращая бесконечные ночные пинги. |
| Смена модели / старт новой сессии / выход | Полная остановка таймеров и очистка состояния. |

---

## Установка

### Вариант 1. Локальное расширение (Рекомендуемый)

Клонируйте репозиторий в папку расширений PI:
```bash
git clone https://github.com/yelkhanyergali-sys/gemini-cache-guard.git ~/.pi/agent/extensions/gemini-cache-guard
```

Добавьте путь в `~/.pi/agent/settings.json` в массив `extensions`:
```json
{
  "extensions": [
    "~/.pi/agent/extensions/gemini-cache-guard"
  ]
}
```

### Вариант 2. Git-пакет

Добавьте репозиторий в секцию `packages` в `~/.pi/agent/settings.json`:
```json
{
  "packages": [
    "git:github.com/yelkhanyergali-sys/gemini-cache-guard"
  ]
}
```

Перезапустите PI или выполните команду `/reload` в TUI.

---

## Полная таблица настроек (Environment Variables)

Все параметры имеют разумные значения по умолчанию и не требуют обязательной настройки. При необходимости переопределите их в файле окружения (`~/.pi/agent/.env` или в терминале):

| Переменная | По умолчанию | Описание |
|---|---|---|
| `GEMINI_CACHE_GUARD_ENABLED` | `true` | Включить (`1`/`true`) или выключить (`0`/`false`) плагин. |
| `GEMINI_CACHE_GUARD_INTERVAL_MS` | `180000` (3 мин) | Интервал между фоновыми пингами в режиме простоя. |
| `GEMINI_CACHE_GUARD_IDLE_CAP_MS` | `3600000` (60 мин / 1 час) | Предел времени простоя, после которого сторож отключается. |
| `GEMINI_CACHE_GUARD_TIMEOUT_MS` | `45000` (45 сек) | Таймаут ожидания ответа на пинг (с запасом для контекстов 100k+). |
| `GEMINI_CACHE_GUARD_MIN_CONTEXT_TOKENS` | `8192` | Минимальный размер контекста, при котором имеет смысл греть кэш TPU. |
| `GEMINI_CACHE_GUARD_ENDPOINT` | *(авто)* | Принудительный URL эндпоинта (например, `http://127.0.0.1:51200/v1`). |
| `GEMINI_CACHE_GUARD_API_KEY` | *(авто)* | Принудительный API-ключ шлюза (если не задан, резолвится автоматически). |
| `GEMINI_CACHE_GUARD_MIN_DELAY_MS` | `1000` (1 сек) | Минимальная задержка перед пингом (защита от дребезга). |
| `GEMINI_CACHE_GUARD_LOG` | `~/.pi/agent/gemini-cache-guard.log` | Путь к файлу логов работы сторожа. |
| `GEMINI_CACHE_GUARD_MAX_ERRORS` | `3` | Подряд идущих ошибок пинга (429/500/сеть), после которых сторож гаснет (backoff). Реальная активность обнуляет счётчик. |

### Автоматический каскад поиска эндпоинта
Если `GEMINI_CACHE_GUARD_ENDPOINT` не задан вручную, плагин разрешает адрес по надёжной цепочке:
1. `auth.baseUrl` из `modelRegistry.getApiKeyAndHeaders(model)`
2. `prov.baseUrl` из `modelRegistry.getProvider(model.provider)`
3. `model.baseUrl` напрямую из объекта выбранной модели
4. Fallback на локальный ротатор `http://127.0.0.1:51200/v1` при работе с провайдером `agy`.

---

## Настройка шлюза / ротатора (Tuxevil Rotator)

Если вы используете **Tuxevil Rotator** (`:51200`), убедитесь, что локальные суточные лимиты запросов не блокируют фоновые пинги:
- В файле конфигурации ротатора (`~/.tuxevil-rotator/accounts.json`) рекомендуется выставить:
  ```json
  {
    "dailyAccountStopRequests": 3000,
    "dailyAccountSlowRequests": 2500,
    "dailyProjectStopRequests": 10000
  }
  ```
  Это предотвратит искусственные задержки jitter (`Safety slow-mode jitter`) и ложные срабатывания блокировок аккаунтов.

---

## Мониторинг и логирование

Плагин ведёт чистый лог в `~/.pi/agent/gemini-cache-guard.log`. Вы можете следить за его работой в реальном времени:

```bash
tail -f ~/.pi/agent/gemini-cache-guard.log
```

### Примеры записей:
```
2026-09-23T21:34:19.884Z armed est=30015 model=gemini-3.8-flash-tiered
2026-09-23T21:37:19.920Z ping 200 est=30015 cached=24549 ms=1850
2026-09-23T22:04:19.950Z guard off: idle cap reached (1800s without activity)
```
- `armed est=30015`: сторож зафиксировал запрос объемом ~30k токенов и запустил таймер.
- `ping 200 cached=24549 ms=1850`: фоновый пинг прошёл успешно за 1.85с, Google подтвердил попадание в кэш (`cached=24549`).
- `guard off`: переход в энергосберегающий режим после 30 минут отсутствия активности.

---

## Тестирование

Плагин снабжён встроенным тестовым сьютом (юнит-тесты чистой логики + интеграционные тесты с моком событий рантайма PI):

```bash
cd ~/.pi/agent/extensions/gemini-cache-guard
npm test
# или: node test/run.js
```

Тесты проверяют:
- Фильтрацию моделей (только Gemini через OpenAI-совместимый API).
- Построение payload (`max_tokens: 1`, `reasoning_effort: low`, `tool_choice: none`).
- Сброс по таймауту неактивности (`idleCapMs`).
- Игнорирование контекстов меньше 8k токенов.
- Каскадное разрешение эндпоинта из системного реестра моделей.

---

## Лицензия

MIT License (c) 2026 Yelkhan.
