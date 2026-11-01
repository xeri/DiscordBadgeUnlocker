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

## Agent skill

[`skills/discord-badge-unlocker`](skills/discord-badge-unlocker/SKILL.md) lets an AI agent build and verify the same scripts from the command line.

## Credits

Based on [everyoneexe/discord-game-badge-presence](https://github.com/everyoneexe/discord-game-badge-presence).

## License

[GPL-3.0](LICENSE)
