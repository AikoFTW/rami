# Rami

Moroccan Rami for two, played in the browser with live turns, the way you'd play chess online.

## Rules it plays by

- Two decks plus jokers (0 to 4). Everyone gets 14 cards, and the starting player gets 15 and opens by discarding.
- On your turn, draw from the deck or take the top discard, then throw one card away.
- Nothing goes on the table until you have a full **Rami**: every card except your final discard is in a meld.
- A Rami needs at least one **swivi** (same suit, numbers in a row) and one **tirci** (same number, different suits). Both counts can be changed in Settings.
- The ace is low (A-2-3) or high (Q-K-A). No wrap-around.
- The first player to Rami wins, and the scoreboard counts wins.

The server checks every Rami automatically, so it can't be declared by mistake.

While you play, your hand is grouped into the melds you already have (gold for swivi, blue for tirci), with loose cards after them. A card you just drew sits apart until you've thrown a card. When a throw would win, that card gets a green ring and Declare Rami pulses. You can turn grouping off in Settings.

**Turn notifications:** turn them on in Settings on each phone or computer. You get a notification when it's your turn, when a new game is dealt, and when someone wins, but not while you're looking at the game. On iPhone, add Rami to your home screen first (Share, then "Add to Home Screen") and turn them on from there. The keys that sign the notifications are created on first start and stored in the database, so nothing needs configuring.

**Sound effects** are on by default; switch them off in Settings. There's also a little hidden extra at the bottom of Settings.

The site is in **English, Arabic and French**. Pick a language on the sign-in screen, at the top of any page, or in Settings. Arabic reads right to left. Every rule above can be changed on the **Settings** page. Each player also picks their own table colour, card size, suit colours, theme and turn sound there.

## Run it

```bash
npm install
cp .env.example .env    # or set the same variables in your environment
npm start
```

Open the site and both of you tap **Create an account**. Sign-up closes once both accounts exist (`MAX_USERS`).

### Environment variables

| Variable | Default | |
|---|---|---|
| `PORT` | `3333` | Port to listen on |
| `mongoURI` | _none_ | MongoDB connection string (`MONGODB_URI` and `MONGO_URI` work too). Without it, data goes to `data/db.json` |
| `MONGODB_DB` | from the URI, else `rami` | Database name, only if you want to override the one in the URI |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` behind a reverse proxy |
| `SECURE_COOKIES` | `0` | `1` when served over https |
| `MAX_USERS` | `2` | Accounts allowed to sign up |
| `VAPID_SUBJECT` | your site's address | Optional contact for push services, e.g. `mailto:you@example.com` |

### MongoDB collections

`users` (names, password hashes, display settings, notification subscriptions), `sessions` (logins; expired ones are removed automatically), `settings` (house rules and the notification signing keys), `games` (every game, current and finished, which the stats and history are built from).

### Handy commands

```bash
node server.js passwd <name>     # reset a password
node server.js list-users
npm test
```
