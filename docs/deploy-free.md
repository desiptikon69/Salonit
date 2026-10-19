# Бесплатная публикация SalonIt (Vercel + Neon)

Обновлено 19 октября 2026 года. Это рабочая бесплатная схема для демо-версии:
**Vercel Hobby** для Next.js и **Neon Free** для PostgreSQL. Платная карта не нужна.

Живая демо-версия: [https://salonit.vercel.app](https://salonit.vercel.app).

> **Ограничения бесплатных тарифов.** Vercel Hobby предназначен для личных и
> некоммерческих проектов. Neon Free даёт 1 ГБ и 100 CU-часов в месяц; после
> простоя компьютер базы «просыпается» с задержкой. Для реального салона с
> потоком клиентов нужен платный тариф или VPS. Сейчас приложение работает в
> `APP_MODE=demo`: реальная SMS-доставка не подключена, реальные записи и
> персональные данные принимать нельзя.

## Что уже сделано

- Проект Vercel: `mraamosov-9659s-projects/salonit`, production-алиас
  `https://salonit.vercel.app`.
- База: Neon Free `salonit-db`, регион Frankfurt (`fra1`), создана через
  Vercel Storage. Переменные `DATABASE_URL` (pooled) и
  `DATABASE_URL_UNPOOLED` подключены к проекту.
- Выполнены миграции и демо-данные: каталог, команда, роли, смены.
- Vercel Authentication отключена, сайт публичный; HTTPS и установка PWA работают.
- Проверки: `installabilityErrors: []`, service worker активен, офлайн-страница
  открывается, ошибок в консоли нет.

## Переменные Vercel

| Переменная | Значение |
| --- | --- |
| `DATABASE_URL` | pooled-строка Neon (создаётся интеграцией) |
| `DATABASE_URL_UNPOOLED` | прямая строка Neon (для миграций) |
| `BETTER_AUTH_URL` | `https://salonit.vercel.app` — точный адрес без слэша |
| `BETTER_AUTH_SECRET` | случайная строка, `openssl rand -hex 48` |
| `APP_MODE` | `demo` |
| `INSTALLATION_ID` | `salonit-main` |
| `DEMO_PASSWORD` | случайный пароль демо-сотрудников |
| `TZ` | Vercel не разрешает задавать это имя; приложение и так использует Europe/Moscow |

## Если нужно развернуть с нуля

1. Создайте проект на Vercel из репозитория
   `https://github.com/desiptikon69/Salonit` (Framework Preset: **Next.js**,
   Node.js **24.x**).
2. В **Storage → Neon** создайте бесплатную базу в регионе Frankfurt и
   подключите её к проекту. Vercel добавит `DATABASE_URL` и
   `DATABASE_URL_UNPOOLED`.
3. Добавьте остальные переменные из таблицы. `BETTER_AUTH_URL` должен
   совпадать с адресом, по которому открывается сайт.
4. Примените схему к базе **с прямого адреса** (pooled-подключение не подходит
   для `CREATE EXTENSION` и миграций):

   ```powershell
   $env:DATABASE_URL = "<DATABASE_URL_UNPOOLED из Neon>"
   npm run db:migrate
   $env:APP_MODE = "demo"
   $env:DEMO_PASSWORD = "<пароль>"
   npm run db:seed:free
   ```

   `db:seed:free` специально делает паузы и повторы: бесплатный Neon иногда
   сбрасывает слишком частые соединения. Он создаёт каталог, команду, демо-роли
   и смены; полный `db:seed` с визитами на бесплатном Neon может не успеть
   выполниться в одной транзакции.
5. Задеплойте:

   ```powershell
   npx vercel deploy --prod --yes
   ```

   Или подключите Git-репозиторий в настройках Vercel и включите автодеплой.

## Домен

- `https://salonit.vercel.app` — бесплатный адрес Vercel, уже работает.
- Можно подключить **`salonit.amosovatanya.ru`**: в Vercel
  **Settings → Domains** добавить домен, в Timeweb — CNAME `salonit` на
  `cname.vercel-dns.com`. После проверки DNS Vercel выпустит SSL.
- Домен `salonit.twc1.net` из панели Timeweb-хостинга использовать нельзя:
  это технический домен, он привязывается только к сайту внутри хостинга.
- Если меняете основной домен, поменяйте и `BETTER_AUTH_URL`, затем
  переdeploy-те проект.

## Установка на телефон

Android/Chrome: откройте `https://salonit.vercel.app`, через несколько секунд
появится подсказка «Установить» (или меню ⋮ → «Установить приложение»).
iPhone/Safari: «Поделиться» → «На экран „Домой“». После установки сайт
открывается без адресной строки.

## Обновления

Код лежит в GitHub. После изменений:

```powershell
git push origin main
npx vercel deploy --prod --yes
```

Если подключите Git в Vercel, второй шаг будет выполняться автоматически.
