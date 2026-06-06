# Gromovenko Monorepo — правила для Claude Code

Этот файл применяется ко всем проектам в репозитории.

## Git — единственный источник истины

- Все изменения — только через git. Никакого прямого редактирования без коммита.
- После каждого Edit/Write → сразу `git add <file> && git commit -m "..."`.
- Контекст и состояние проекта берём из `git log`, `git diff`, `git show` — не лопатим код без необходимости.
- Никогда не оставлять незакоммиченных изменений.
- После коммита — `git push`.

## Деплой на серверы

| Сервер | IP | Деплой |
|--------|----|--------|
| EU (Aeza) | 147.45.75.59 | git bundle → SSH → git pull |
| RU (Selectel) | 80.249.150.234 | git bundle → SSH (server_key) → git pull |

Не использовать rsync. Не использовать прямое копирование файлов в обход git.

## Проекты

| Папка | Продукт | Сервер | Порт |
|-------|---------|--------|------|
| lifeprotocol | lifeprotocol.ru | RU | 3001 |
| letov-app | letov.lifeprotocol.ru | RU | 3002 |
| soundrussian | soundrussian.uz | EU | 3003 |
| gromdash | 147.45.75.59 | EU | 80 |
| proxy | grom-proxy API | EU | — |

Детали каждого проекта — в его собственном CLAUDE.md.
