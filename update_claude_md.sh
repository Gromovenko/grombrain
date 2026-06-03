#!/bin/bash
# Автообновляемый слепок инфраструктуры — запускается при деплое
cat > /root/gromovenko/gromdash/CLAUDE.md << EOF
# Command Center — Слепок инфраструктуры
Обновлено: $(date '+%Y-%m-%d %H:%M UTC')

## Серверы
| Роль | IP | ОС | SSH |
|------|----|----|-----|
| EU (Aeza, дирижабль) | 147.45.75.59 | Ubuntu 24.04 | пароль |
| RU (Selectel, Olive) | 80.249.150.234 | Ubuntu 22.04 | ~/Downloads/server_key |

## Проекты
$(curl -s http://127.0.0.1:3010/projects | python3 -c "
import sys,json
ps=json.load(sys.stdin)
print('| Проект | Домен | Порт | Сервер | Репо |')
print('|--------|-------|------|--------|------|')
for p in ps:
    print(f'| {p[\"name\"]} | {p[\"domain\"]} | {p[\"port\"]} | {p[\"prod_server\"].upper()} | {p[\"frontend_repo\"]} |')
")

## Тестовые версии (EU)
| pm2 | Порт | Домен |
|-----|------|-------|
| test-life | 3091 | test.lifeprotocol.ru |
| test-letov | 3092 | letovtest.lifeprotocol.ru |

## Ключевые файлы
| Файл | Назначение |
|------|-----------|
| /root/gromovenko/gromdash/index.html | Исходник дашборда |
| /var/www/dashboard/index.html | Боевой дашборд |
| /root/gromovenko/proxy/server.js | API прокси |
| /etc/nginx/conf.d/dashboard.conf | Nginx дашборда |
| /etc/wireguard/wg1.conf | WireGuard конфиг (на RU) |
| /opt/lifeprotocol/supabase/.env | Supabase LP |
| /opt/letovtravel/supabase/.env | Supabase летов |
| /opt/life/ecosystem.config.js | PM2 life (RU) |

## WireGuard пиры (RU :51821)
$(curl -s http://127.0.0.1:3010/wg-peers | python3 -c "
import sys,json
peers=json.load(sys.stdin)
print('| Имя | IP | PubKey |')
print('|-----|----|--------|')
for p in peers:
    print(f'| {p[\"name\"]} | {p[\"ip\"]} | {p[\"pubkey\"][:20]}... |')
")

## Туннели
| Тип | Адрес | UUID/Пароль |
|-----|-------|-------------|
| WireGuard | 80.249.150.234:51821 | pubkey: avYjwYOl... |
| VLESS+REALITY | 147.45.75.59:58867 | a3705e06... |
| VLESS+WS+TLS | tunnel.lifeprotocol.online:443 | ad37e149... |
| Hysteria2 | 147.45.75.59:1194/UDP | 66e37f85 |

## Правила для Claude Code
1. Дашборд: редактировать /root/gromovenko/gromdash/index.html → cp → /var/www/dashboard/
2. Прокси: /root/gromovenko/proxy/server.js → systemctl restart grom-proxy
3. После изменений: запустить /tmp/update_claude_md.sh для обновления этого файла
4. Не трогать: туннель :443, 3X-UI :54321, letovtravel-db данные
5. Деплой EU→RU: через /api/deploy или rsync + pm2 restart
EOF

cd /root/gromovenko/gromdash && git add CLAUDE.md && git commit -m "auto: update infrastructure snapshot $(date '+%Y-%m-%d')" && git push
echo "✓ CLAUDE.md обновлён"
