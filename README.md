# Discord Badge Unlocker

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

Builds console scripts that unlock Discord's **Game Variety** (100+ games) and **Game Time** (5,000h) profile badges, and stream time for the **Streaming** badge. Pick random games or choose your own, set the hours, then paste the script into Discord's console. Everything runs locally; the page only fetches Discord's public game catalog.
<img alt="image" src="https://github.com/user-attachments/assets/766afe49-e35d-479d-9f06-c29fbd90d3d0" width="50%" height="50%"/>


Why have custom games instead of random? Discord could use this game data for new features and personalisation in the future, 

<img width="25%" height="25%" alt="image" src="https://github.com/user-attachments/assets/477c6c4c-87ac-4ebe-92cc-5bde2c79fe12" />

for example, the "Suggested for you" for some widgets


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

## Streaming badge

> [!NOTE]
> **Untested as of 11/11/26.** No run of the Streaming script has been checked against a real badge yet.

Open the generator and click the **green button** in the sidebar (on phones, **Open Streaming**). Set the hours, then choose:

- **Turbo:** Auto claims 10h a minute while someone watches. Off claims one minute a minute.
- **Nobody watching:** Pause (the default) waits for a viewer. Drop keeps sending one minute a minute, which probably counts for nothing.

Then:

1. In the Discord desktop app, join a server voice channel and **Go Live**. Any window works; no game needed.
2. Have someone watch. An alt counts. Stream time only counts with a viewer.
3. Paste `stream-time.js` into the console and stay live until it says Done.

Start with a small target like 100h.

## What's known about the badges

- Only the Discord desktop app counts, not the web version. (Vesktop does not work, it's web)
- Progress only counts with **Use data to personalize my Discord experience** turned on.
- Game Time counts time played on or after **8 December 2025**. A session longer than the time since then starts before it.
- Badges usually appear after 1D 7H (31 hours). Range is 24-48hrs.
- Play sessions over 24h don't count at all, so the scripts split each game into back-to-back sessions of at most 23h.

## Agent skill

[`skills/discord-badge-unlocker`](skills/discord-badge-unlocker/SKILL.md) lets an AI agent build and verify the same scripts from the command line.

## Credits

Based on [everyoneexe/discord-game-badge-presence](https://github.com/everyoneexe/discord-game-badge-presence). The Vencord-aware client lookup and the analytics-token refresh come from [Zwuiix-cmd/discord-game-badge-presence](https://github.com/Zwuiix-cmd/discord-game-badge-presence). The Streaming script follows [lawerth/discord-streamer](https://github.com/lawerth/discord-streamer)'s stream events and [aboveproof/BadgeFarmer](https://github.com/aboveproof/BadgeFarmer)'s Turbo mode (both MIT); its tier icons are from lawerth/discord-streamer.

## License

[GPL-3.0](LICENSE)
