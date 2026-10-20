# Telegram Task Bot

Telegram bot jekhane user channel join kore, website (Mini App) theke task complete kore taka earn kore, ar bKash / Nagad e withdraw kore.

## Features

- `/start` e force-join channel + Verify
- Main menu: Tasks, Balance, Refer, Daily Bonus, Withdraw, Help
- Tasks website (Telegram Mini App), bot er vitor-i khole
- Task type:
  - Telegram channel join (auto verify)
  - Timer task, ad ba link dekha (server e time check)
  - Proof task, YouTube subscribe (screenshot proof, coming soon)
- Referral bonus, daily bonus
- Database: Firebase Firestore

## Folder structure

```
Task-Bot/
├── index.js
├── api.js
├── admin-api.js
├── features.js
├── db.js
├── config.js
├── package.json
├── .gitignore
└── public/
    ├── index.html   <- user website (Mini App)
    └── admin.html   <- admin panel
```

`public` folder (choto haater) `index.js` er pashe-i rakho. `index.html` ar `admin.html` ek folder e thakbe.

## Environment variables

Render: Service -> Environment -> Add Environment Variable

| Key | Value | Kothay pabe |
|---|---|---|
| `BOT_TOKEN` | Bot token | Telegram e @BotFather -> `/newbot` |
| `FIREBASE_SERVICE_ACCOUNT` | JSON file er puro content | Firebase Console -> Project settings -> Service accounts -> Generate new private key |
| `ADMIN_IDS` | `8361587941` | Admin er Telegram ID (comma diye aro dewa jay) |
| `NODE_VERSION` | `20` | Optional |

`WEBAPP_URL` ar `WEBHOOK_URL` dite hobe na, Render nijei set kore.

## Firebase setup

1. console.firebase.google.com e project banao
2. Build -> Firestore Database -> Create database
3. Project settings -> Service accounts -> Generate new private key
4. Download hoya JSON file er content `FIREBASE_SERVICE_ACCOUNT` e paste koro

## Render e deploy

1. Code GitHub e upload koro
2. Render e New -> Web Service, repo select koro
3. Jodi files kono folder er vitor thake, Settings -> **Root Directory** e oi folder er nam dao (jemon `Task-Bot`)
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Environment variable gulo boshao
7. Deploy

Bot ke force-join channel e **Admin** banate hobe, noile join check kaj korbe na.

## Force-join channel add kora

`config.js` e `CHANNELS` array te notun object add koro:

```js
{ title: 'Channel 2', username: '@channel_username', url: 'https://t.me/channel_username' }
```

## Security

- `.env` ar Firebase JSON kokhono GitHub e upload korba na
- Kono key leak hole sathe sathe revoke kore notun nao:
  - Bot token: @BotFather -> `/revoke`
  - Firebase: notun private key generate kore purano ta delete koro

## Roadmap

- [x] Step 1: Bot core, force-join, menu
- [x] Step 2: Task API + Mini App website
- [x] Step 3: YouTube proof submit + admin approve/reject
- [x] Step 4: Withdraw (bKash / Nagad), admin Paid / Reject
- [x] Step 5: Admin panel (stats, tasks, users, broadcast)

## Admin

- Bot e `/admin` (shudhu admin), Admin Panel khole
- Bot e `/pending`, pending proof ar withdraw abar pathay
- Proof ar withdraw bot chat e Approve / Paid button soho ashe
- Withdraw e taka tumi nijer bKash/Nagad theke pathabe, tarpor **Paid** chapbe
