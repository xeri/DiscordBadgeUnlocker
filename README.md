# Discord Badge Unlocker

A personal, local tool that builds console scripts for Discord's **Game Variety** (100+ games) and **Game Time** (5,000h) profile badges. You choose the games and hours, and the output is fixed: no randomness, and the same input always gives the same script.

It works two ways, using the same code:

1. **Web generator:** a page that runs on localhost. Discord's game catalog loads in the background. Click **Load generator**, then:
   - **Quick pick** from a researched global most-played ranking, by vibe (Popular, Competitive, Cozy & cute, Adventurer, Builder, With friends), or **search** all ~25,000 games
   - set hours (weighted, even, the same for each, or "fill the window since a date")
   - copy the script
2. **AI agent skill:** [`skills/discord-badge-unlocker/SKILL.md`](skills/discord-badge-unlocker/SKILL.md) plus a Node CLI. Any agent can follow it: catalog → pick → build → verify in a mocked Discord client.

## Run the page

```bash
npm start            # or: node serve.mjs   (or: python3 -m http.server 8080)
```

Open <http://127.0.0.1:8080/>.

- **What it fetches:** the page only requests Discord's public catalog (`discord.com/api/v9/applications/detectable`, then the CDN). If neither answers, it falls back to `data/catalog.min.json`.
- **What it sends:** nothing. Scripts are built in your browser.
- **Saving:** your list is saved in the page's localStorage. Export/Import JSON uses the same format as the CLI.

## Outputs

| File | Use |
|---|---|
| `discord-badge-unlocker.js` | **Main, both badges.** Sends each game once with its hours through Discord's own HTTP client. Never reads your token. |
| `multi-game-presence.js` | Advanced. Original-style Variety engine with a Rich Presence rotation, which stops once the claim finishes unless "Keep rotating" is on. |
| `game-time-presence.js` | Advanced. Same engine as Main under the original `window.__gameTimePresence.boost()` name. |

**Run one.** All three share a per-account history, so mixing them never sends a game twice.

**How to run it:** in Discord desktop, press Ctrl+Shift+I → Console. Type `allow pasting` if asked, then paste and press Enter. Badges can take 24–48h to update.

## CLI

```bash
S=skills/discord-badge-unlocker/scripts
node $S/build.mjs fetch-catalog --out data/catalog.min.json      # refresh the offline snapshot
node $S/build.mjs vibes                                          # ranked games per vibe
node $S/build.mjs pick --vibe cozy --top 120 --total 2000 --out selection.json
node $S/build.mjs search "hollow knight"
node $S/build.mjs build --selection selection.json --out out/mine
node $S/verify.mjs out/mine                                      # mocked Discord run
npm run verify                                                   # build + verify the example preset
```

## The global ranking

The ranking lives in `data/rankings/global.json` and is rebuilt with `node tools/build-ranking.mjs`.

**Score:** estimated PC hours played in the last 30 days.
- **Steam games:** [Steam Charts](https://steamcharts.com/top) 30-day hours for the top 600. [Steam's official chart API](https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/) fills in the games Steam Charts misses.
- **Other launchers:** games that are mostly played elsewhere (Battle.net, EA app, Epic, Xbox app, their own launchers) get a launcher factor.
- **Not on Steam:** games like League of Legends, Minecraft, Roblox, Fortnite, VALORANT and Genshin get an estimate. The estimates draw on [Newzoo's 2025 PC MAU ranking](https://wbgsv0a.gigazine.net/gsc_news/en/20251220-2025-top-10-games), [Twitch State of Gaming 2026](https://streamer.guide/blog/twitch-state-of-gaming-2026), [TwitchTracker](https://twitchtracker.com/games), [MMO-Population](https://mmo-population.com/), [ActivePlayer.io](https://activeplayer.io/most-played-games/), [DemandSage](https://demandsage.com/most-played-games-right-now), [LinuxBuz](https://linuxbuz.com/best-resources/most-popular-pc-games-by-monthly-active-users-2026) and [Shane the Gamer](https://www.shanethegamer.com/research/most-played-video-games-statistics/).

**Matching to Discord:** games map to Discord IDs through the catalog's Steam SKUs.

**Tags and vibes:** each game keeps its top [SteamSpy](https://steamspy.com/) tags. Vibes are tag lists in `core.mjs`, so changing one needs no rebuild.

**Excluded:** tools, overlays, wallpapers, idle/clicker farms, adult games, demos and servers.

## Layout

```
index.html, assets/          the page (app.js boots it, generator.js is lazy-loaded)
data/                        catalog snapshot, global ranking, example preset
skills/discord-badge-unlocker/
  SKILL.md                   agent workflow
  scripts/core.mjs           shared logic (page + CLI)
  scripts/templates.mjs      renders the three scripts from templates/*.js
  scripts/build.mjs          CLI
  scripts/verify.mjs         mocked Discord harness
tools/build-ranking.mjs      rebuilds the global ranking
serve.mjs                    local static server
```

## Credit and license

Based on **[everyoneexe/discord-game-badge-presence](https://github.com/everyoneexe/discord-game-badge-presence)**, the original `multi-game-presence.js` and `game-time-presence.js`. GPL-3.0, like the original (see `LICENSE`). Generated scripts carry the same credit in their header.

**Warning:** the scripts send synthetic play-time telemetry to Discord. That breaks Discord's Terms of Service and can get an account flagged. Use your own account, at your own risk.
