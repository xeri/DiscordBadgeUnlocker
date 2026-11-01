# Discord Badge Unlocker

Builds console scripts that unlock Discord's **Game Variety** (100+ games) and **Game Time** (5,000h) profile badges. Pick random games or choose your own, set the hours, then paste the script into Discord's console. Everything runs locally; the page only fetches Discord's public game catalog.

> [!WARNING]
> The scripts send synthetic play-time telemetry to Discord. That breaks Discord's Terms of Service and can get an account flagged. Use at your own risk.

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

- Node.js 18+
- Discord desktop app

## Getting started

```bash
git clone https://github.com/xeri/DiscordBadgeUnlocker.git
cd DiscordBadgeUnlocker
npm start
```

Open <http://127.0.0.1:8080/> and click **Load generator**.

## Agent skill

[`skills/discord-badge-unlocker`](skills/discord-badge-unlocker/SKILL.md) lets an AI agent build and verify the same scripts from the command line.

## Credits

Based on [everyoneexe/discord-game-badge-presence](https://github.com/everyoneexe/discord-game-badge-presence).

## License

[GPL-3.0](LICENSE)
