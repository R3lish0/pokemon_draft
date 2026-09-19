# Autumn Pokémon Draft

A live snake-draft for Pokémon teams. Everyone joins a room with a four-letter
code, a shared pool appears, and players take turns claiming from it until the
pool is empty.

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end protocol suite (boots its own server)
npm run roster     # re-scrape the Pokémon Champions roster + artwork
```

## Draft rules

- **Snake order.** With three players it runs `1 2 3 · 3 2 1 · 1 2 3 …`, so
  picking last in one round means picking first in the next.
- **The pool is exact-fit.** By default it holds exactly `players × team size`
  Pokémon, so the choices narrow every round and the final pick is whatever
  nobody else wanted. The *Spare picks* option adds a buffer per player if you
  want the last trainer to still have a real decision.
- **Every pick is on a clock.** When it runs out the server picks the highest
  remaining BST for that seat. This is what stops a dropped connection from
  deadlocking the room.
- **Seats survive a refresh.** Identity lives in `sessionStorage`, so reloading
  puts you back in your seat, while a second tab is a genuinely separate player.

## The WebSocket protocol

One rule governs everything: **the server sends a full authoritative `state`
snapshot after every change, and separate `event` messages that carry no state
at all.** A client that ignored every `event` would still render correctly —
events exist only to drive toasts.

Client → server. None of these carry a room code; the server derives the room
from the socket's session.

| Message | Payload |
| --- | --- |
| `hello` | `{ playerId }` — resumes a seat, or starts fresh |
| `createRoom` | `{ name, config }` |
| `joinRoom` | `{ name, code }` |
| `setName` | `{ name }` |
| `startDraft` | — (host only) |
| `pick` | `{ pokemonId }` |
| `leaveRoom` | — |

Server → client:

| Message | Meaning |
| --- | --- |
| `welcome` | your `playerId` (store it), plus config limits |
| `state` | the whole room: phase, players, pool, picks, turn, upcoming |
| `event` | ephemeral: `pick`, `playerJoined`, `draftStarted`, … |
| `error` | `{ code, message }` — shown as a toast, never an `alert` |
| `left` | you are out of the room |

`state` deliberately does **not** include teams. They are derived on the client
from `picks`, so there is exactly one record of who owns what and the two can
never disagree.

## Layout

```
server.js                  HTTP + WebSocket wiring, message routing
src/rooms.js               rooms, snake order, turn clock, serialization
src/pokedex.js             loads the roster, draws random pools
scripts/fetch-champions.js scrapes pokebase.app → champions.json + sprites
scripts/smoke-test.js      drives a full draft over real sockets
public/                    index.html · styles.css · app.js · sprites/
champions.json             342 Pokémon with Champions stats and usage %
pokedex.json               legacy dex, used only if champions.json is missing
```

## Refreshing the roster

`npm run roster` re-reads
<https://pokebase.app/pokemon-champions/pokemon> and rewrites `champions.json`,
downloading any artwork it doesn't already have into `public/sprites/`.

Two things to know if it ever breaks: the site's `?page=N` pagination is
unreliable (pages overlap and come back short), so the scraper asks for
`?pageSize=2000` and takes the whole roster in one request; and it parses
server-rendered table markup, so a redesign of that page will need the regexes
in `parseRows` updated. The script fails loudly rather than writing a partial
file, and it checks its row count against the roster's own "N results" footer.

Stats in `champions.json` are the Champions values shown on that site, not
mainline base stats — Rillaboom is HP 175 there and HP 100 in the main games.
