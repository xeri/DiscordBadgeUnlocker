# Discord Badge Unlocker

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

Builds console scripts that unlock Discord's **Game Variety** (100+ games) and **Game Time** (5,000h) profile badges. Pick random games or choose your own, set the hours, then paste the script into Discord's console. Everything runs locally; the page only fetches Discord's public game catalog.

> [!WARNING]
> **Educational & Research Use Only:** Modifying Discord client internals carries inherent risks. Use responsibly. Review [DISCLAIMER.md](DISCLAIMER.md).

```
/*
* Your warranty is now void.
*
* I am not responsible for bricked devices, dead SD cards,
* thermonuclear war, or you getting fired because the alarm app failed. Please
* do some research if you have any concerns about features included in this tool
* before using it! YOU are choosing to make these modifications, and if
* you point the finger at me for getting you banned, I will laugh at you.
*/
```

## Requirements

- Discord desktop app
- Node.js 18+, only to run the page locally or use the agent skill

## Getting started

Open **<https://xeri.github.io/DiscordBadgeUnlocker/>** and click **Load generator**.

To run it locally instead:

```bash
git clone https://github.com/xeri/DiscordBadgeUnlocker.git
cd DiscordBadgeUnlocker
npm start
```

Open <http://127.0.0.1:8080/> and click **Load generator**.

## What's known about the badges

From Discord's own help article, [Discord Profile Badges: What Each Badge Means](https://support.discord.com/hc/en-us/articles/44369363856663):

- Only the Discord desktop app counts, not the web version. (Vesktop does not work, it's web)
- Progress only counts with **Use data to personalize my Discord experience** turned on.
- Game Time counts time played on or after **8 December 2025**. A session longer than the time since then starts before it.

Consistent across independent sources:

- **Tiers.** Game Variety: 2, 5, 10, 15, 20, 30, 40, 60, 80 and 100 games (Universalist). Game Time: 1, 5, 20, 75, 150, 300, 500, 1,000, 2,000 and 5,000 hours (Eternal). These match the badge timeline in the Discord app, [DiscordPreviews](https://x.com/DiscordPreviews/status/2082864614371467681) and badge guides. Nothing past the top tier raises a badge.
- **Update time.** Badges update about 1–2 days after a run, as reported on the [original project](https://github.com/everyoneexe/discord-game-badge-presence/issues/2) and by several similar ones.

The page warns when your numbers go past these limits. Anything less certain, like whether games Discord lists no Windows executable for count, is marked untested.

## Notes from the original project

What [everyoneexe/discord-game-badge-presence](https://github.com/everyoneexe/discord-game-badge-presence) has shown so far, from its issues and commit history (checked 2026-11-01):

- **Game Variety works.** The maintainer's [screenshot](https://github.com/everyoneexe/discord-game-badge-presence/issues/2#issuecomment-6446302281) shows Universalist, 132 games, unlocked 27 Oct 2026. It came from `multi-game-presence.js` at [`f4548f4`](https://github.com/everyoneexe/discord-game-badge-presence/commit/f4548f4): 125 games at 1.5h each, 5 games per request, 4s apart, sent straight to `/science` with Windows desktop client properties. The Variety engine here keeps that pace.
- **Game Time at high hours isn't confirmed.** The final `game-time-presence.js` sends 6,000h as 250 games × 24h through Discord's own HTTP client, 25 games per request. A tester [reported](https://github.com/everyoneexe/discord-game-badge-presence/issues/3#issuecomment-6504715334) getting "the game badges", but the maintainer's question "both?" went unanswered.
- **Session length is a guess.** The original once sent 125h sessions, saying Discord drops telemetry older than 7 days ([`41d3d66`](https://github.com/everyoneexe/discord-game-badge-presence/commit/41d3d66)). It then moved to 24h sessions "so per-session caps or dropped events still leave enough buffer" ([`382ec00`](https://github.com/everyoneexe/discord-game-badge-presence/commit/382ec00)). Neither limit is confirmed. The scripts here send each game as one session, so a game over 24h assumes there's no cap.

A personal merge of the fixed 150-game scripts ran on 2026-11-01, and Discord accepted all 150 games through its own HTTP client. That run showed two things the scripts here now use:

- **Discord's translated messages pass the old lookups.** They're a Proxy that answers any property name with a function. The Dispatcher lookup picked it (the console showed "Requested message dispatch does not have a value…", so the Rich Presence probably never showed), and the HTTP client lookup could too. The lookups now skip anything that answers a made-up property name.
- **`/users/@me/consent` reads the settings.** The scripts check "Use data to personalize my Discord experience" before sending and stop if it's off, instead of marking games as sent for nothing. `run({ force: true })` sends anyway. They also warn when "Use data to improve Discord" is off.

Also ported, but not yet seen in a live run:

- Rate limits (429) and requests that get no answer are retried with the same events. The main script used to wait 5s and leave that batch for the next run.
- The sent history reaches `localStorage` through a hidden same-origin iframe, so it should survive a reload.

Still only in the personal merge:

- Games over 24h split into back-to-back sessions of at most 24h.
- The main script at the Variety pace (5 games, 4s apart) instead of 25 games every 450ms.
- Falling back to the direct `/science` request when Discord's HTTP client can't be found.

## Agent skill

[`skills/discord-badge-unlocker`](skills/discord-badge-unlocker/SKILL.md) lets an AI agent build and verify the same scripts from the command line.

## Credits

Based on [everyoneexe/discord-game-badge-presence](https://github.com/everyoneexe/discord-game-badge-presence).

## License

[GPL-3.0](LICENSE)
