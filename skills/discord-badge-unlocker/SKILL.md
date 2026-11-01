---
name: discord-badge-unlocker
description: Build Discord console scripts for the Game Variety (100+ games) and Game Time (5,000h) profile badges from a fixed, verified game table. Use when someone asks for a Discord game badge script, Game Variety / Game Time badge, "games played" or "hours played" badge, multi-game-presence or game-time-presence script, or wants a list of games with hours turned into a Discord script.
---

# Discord Badge Unlocker

Turns a list of games and hours into three deterministic console scripts, then checks them in a mocked Discord client:

| File | What it is |
|---|---|
| `discord-badge-unlocker.js` | **Main.** Covers both badges. Sends each game once, with its hours, through Discord's own HTTP client. Never reads the token. |
| `multi-game-presence.js` | Advanced. Original-style Variety engine with a Rich Presence rotation, which stops after the claim by default. Reads the token in memory. |
| `game-time-presence.js` | Advanced. Same engine as Main under the original `window.__gameTimePresence` (`boost()`) name. |

All three embed the same table and share a per-account "already sent" history, so running any mix of them never sends a game twice.

The web generator (`index.html` at the repo root) uses this same code, so the page and this skill produce byte-identical files.

All commands below run from the repo root. `$S` is `skills/discord-badge-unlocker/scripts`. Node 18+ is required.

## Workflow

### 1. Understand the request
Ask only what you can't infer. You need one of these:
- **Specific games** with hours.
- **Random**, like the original scripts: a game count and total hours, or "max" (250 games, 6,000h).
- **A vibe and a size**, e.g. "120 cozy games". The vibes are `popular`, `competitive`, `cozy`, `adventurer`, `builder` and `friends`.
- **An hour budget**, e.g. "the most hours possible since 2026-09-15". That budget is floor(hours from that date at 00:00 UTC to now); put the date in `trackStart`.

Also ask about must-include games, games to leave out, and whether they want a dry run first.

**Targets:** Game Variety's top tier needs 100+ games. Game Time tops out at 5,000h, and more hours don't raise it.

### 2. Get the catalog
```bash
node $S/build.mjs fetch-catalog --out /tmp/catalog.json   # live from discord.com, then the CDN
```
If Discord can't be reached, skip `--catalog` in later steps: the CLI falls back to the repo snapshot `data/catalog.min.json`. The user can also supply their own `games.json` (`slim-catalog --in games.json`).

### 3. Pick games
- **Random, like the original scripts:** random games from the whole catalog, hours split evenly.
  ```bash
  node $S/build.mjs random --count 125 --hours 5000 --out selection.json
  node $S/build.mjs random --max --out selection.json   # the original's 250 games, 6,000h
  ```
  Pass `--seed N` to get the same pick again.
- **By vibe or popularity:** use the researched global ranking in `data/rankings/global.json` (most-played PC games, with Steam tags).
  ```bash
  node $S/build.mjs vibes                         # how many ranked games each vibe has
  node $S/build.mjs pick --vibe cozy --top 120 --mode weighted --total 2000 --out selection.json
  node $S/build.mjs pick --vibe competitive --top 40 --add selection.json --out selection.json   # mix vibes
  ```
  - **`--mode weighted`** gives more popular games more hours (by the square root of popularity), scaled to `--total`.
  - **`--mode even`** splits `--total` evenly across the games.
  - **`--mode flat`** gives every game `--hours`.
- **Specific games:** look up IDs, then write the selection yourself.
  ```bash
  node $S/build.mjs search "valorant"             # prints: id <tab> name <tab> exe
  ```
- **"Most played" requests outside the ranking:** research first.
  - Skip meme games, non-games (overlays, wallpaper and crosshair tools), idle/clicker games, adult games and demos.
  - Keep well-known indies.

### 4. Write `selection.json`
```json
{
  "version": 1,
  "name": "Optional label",
  "trackStart": "2026-09-15",
  "options": { "dryRun": false },
  "games": [
    { "id": "359509387670192128", "hours": 128.4 },
    { "name": "Balatro", "hours": 38.6 },
    { "id": "1137125502985961543", "hours": 92.7, "exe": "bin/bg3_dx11.exe" }
  ]
}
```
- Match each game by `id` (best) or by exact `name`.
- `exe` is optional. It overrides the catalog's executable when the catalog's first win32 exe is a launcher or tool.
- Hours round to 0.1 and must be at least 0.1.
- `trackStart` is optional. When set, the scripts warn if a session would start before that date.
- `data/presets/example.json` is a worked example: a made-up player's 120 games and 1,000h, with exe overrides.

### 5. Build
```bash
node $S/build.mjs build --selection selection.json --out out/my-badges [--catalog /tmp/catalog.json]
```
- **Files written:** the three scripts, `GAMES.md` (a readable table) and `table.json`.
- **Unmatched names:** it exits non-zero on missing or ambiguous names and on bad hours. Fix them and rebuild.
- **Warnings:** under 100 games, over 5,000h, or more hours than the window since `trackStart`. Pass them on to the user.
- **Option flags:** `--dry-run`, `--batch-size 25`, `--delay-ms 450`, `--variety-batch-size 5`, `--variety-delay-ms 4000`, `--rotate-minutes 30`, `--keep-rotating`, `--track-start YYYY-MM-DD` and `--no-track-start`.

### 6. Verify (always)
```bash
node $S/verify.mjs out/my-badges
```
It runs all three scripts in a mocked Discord client and checks the following:
- the files parse, with no `Math.random`, and the table is byte-identical across files and matches `table.json`
- re-rendering gives identical bytes
- each script sends every game exactly once, and the hours add up exactly
- every ordered pair of scripts sends nothing on the second run
- another account in the same client still gets everything
- `resetClaimed()` resends, and the Variety rotation stops after its claim

Don't hand over files that fail.

### 7. Hand over
Give the user the Main script (`discord-badge-unlocker.js`), plus `GAMES.md`, and tell them:
- **Run it:** in the Discord desktop app, press Ctrl+Shift+I → Console. Type `allow pasting` if asked, then paste and press Enter.
- **Run only one script.** The advanced ones are alternatives, not extra steps.
- **Wait:** badges can take 24–48h to update. Don't re-run it in the meantime.
- **Resending:** `window.__discordBadgeUnlocker.resetClaimed()` forgets what was sent. Discord usually hides `localStorage`, so the history may reset when Discord reloads.
- **Risk:** this sends synthetic play-time telemetry, which breaks Discord's Terms of Service. Their account, their risk.

Credit: based on [everyoneexe/discord-game-badge-presence](https://github.com/everyoneexe/discord-game-badge-presence) (GPL-3.0).
