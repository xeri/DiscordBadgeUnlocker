#!/usr/bin/env node
// Builds data/rankings/global.json: the most-played PC games, ranked, with their top tags.
//
//   node tools/build-ranking.mjs [--pages 40] [--cache .cache/ranking] [--out data/rankings/global.json] [--refresh]
//
// Score = estimated PC hours played in the last 30 days (millions).
//   1. Steam games: steamcharts.com "hours played" (last 30 days), 40 pages = top 1,000 (--pages to change).
//      Games missing there but in Steam's official charts API get peak × 0.7 × 720h.
//   2. Games also sold through other PC launchers (Battle.net, EA app, Epic, Xbox app, own launchers)
//      get a launcher factor; games that aren't on Steam get a researched estimate (ADJUST below).
//   3. Steam games map to Discord app IDs through the catalog's Steam SKUs (name match as a fallback).
//   4. Each game keeps its top SteamSpy user tags (hand-tagged for games not on Steam); the generator
//      turns tags into "vibes" at runtime (VIBES in core.mjs), so changing a vibe needs no rebuild.
// Non-games (tools, overlays, wallpapers), idle/clicker farms, adult games, demos and servers are dropped.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VIBES, countByVibe, normalizeText, pickExe } from "../skills/discord-badge-unlocker/scripts/core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
    a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true] : null).filter(Boolean));
const CACHE = resolve(args.cache && args.cache !== true ? args.cache : join(ROOT, ".cache/ranking"));
const OUT = resolve(args.out && args.out !== true ? args.out : join(ROOT, "data/rankings/global.json"));
const REFRESH = !!args.refresh;
const PAGES = Number(args.pages) > 0 ? Number(args.pages) : 40; // 25 games per page
const TOP_TAGS = 12; // tags kept per game (vibes only look at these)

// ---------- curation ----------

// Steam app IDs that aren't games (or aren't fair game for a "most played" list).
const EXCLUDE_STEAM = new Map(Object.entries({
    // tools, overlays, desktop toys
    3419430: "Bongo Cat", 431960: "Wallpaper Engine", 3678970: "TBH: Task Bar Hero", 480: "Spacewar",
    1366800: "Crosshair X", 2250040: "Crosshair V2", 1905180: "OBS Studio", 365670: "Blender", 629520: "Soundpad",
    632810: "Soundpad Demo", 1325860: "VTube Studio", 1283970: "YoloMouse", 993090: "Lossless Scaling", 1812620: "DSX",
    1920960: "VPet", 431730: "Aseprite", 3301060: "Desktop Mate", 400040: "ShareX", 1447430: "Xiaoheihe accelerator",
    1477830: "HudSight", 3474900: "Anima Engine", 1173510: "XSOverlay", 1068820: "OVR Toolkit",
    1009850: "OVR Advanced Settings", 2538150: "OyasumiVR", 404790: "Godot Engine", 280680: "Krita",
    3413340: "Wallpaper Play", 4056970: "Live Wallpaper", 3511030: "Mini Cozy Room", 3861430: "Bongo Waifu",
    // servers, SDKs, demos, playtests, trials
    8710: "dedicated server", 34120: "dedicated server", 243750: "Source SDK", 63220: "dedicated server",
    70010: "dedicated server", 382030: "dedicated server", 8770: "dedicated server", 2642680: "Half Sword Demo",
    1482520: "Space Station 14 Playtest", 2189700: "nanos world Playtest", 312060: "FFXIV Free Trial",
    // idle / clicker / farming
    1476970: "IdleOn", 1454400: "Cookie Clicker", 2763740: "Revolution Idle", 977400: "Cell to Singularity",
    1267910: "Melvor Idle", 2471100: "Unnamed Space Idle", 1891700: "Tap Ninja", 1147690: "NGU IDLE",
    627690: "Idle Champions", 2897580: "Idle Hero TD", 1013320: "Firestone", 363970: "Clicker Heroes",
    346900: "AdVenture Capitalist", 1546320: "Your Chronicle", 459820: "Crush Crush", 2923300: "Banana",
    4623570: "Deskrawl: Idle ARPG", 4891320: "War of Genesis: Idle Loot", 583950: "Artifact Classic (bot farm)",
    // adult
    2808930: "Lust Goddess", 4005870: "FreshWomen", 3850550: "Isekai: Waifu Overlord",
    // duplicates of another entry
    3564400: "Umamusume (JP client)"
}));

// Same idea by name, for games SteamSpy hasn't tagged yet. The pattern catches most idle games on its own.
const IDLE_NAME = /\bidl(e|ing)\b|clicker|incremental/i;
const EXCLUDE_NAMES = new Set([
    "Chill with You: Lo-Fi Story", "Antimatter Dimensions", "Trimps", "Tap Tap Loot", "Upload Labs",
    "Dungeon Crusher: Soul Hunters", // idle / desktop
    "Dead or Alive Xtreme: Venus Vacation", "Being a DIK", "How to Train Your Cock", "Taimanin Squad", "Everlusting Life" // adult
].map(normalizeText));

// Tags that mark a non-game or an idle farm when they rank high on a game.
const AUTO_EXCLUDE_TAGS = ["Utilities", "Software", "Video Production", "Audio Production",
    "Animation & Modeling", "Game Development", "Photo Editing", "Idler", "Clicker", "Hentai", "NSFW"];

// Adjustments keyed by Discord app ID.
//   factor: Steam hours × factor (the rest of the PC audience plays through another launcher)
//   estimate: replaces the score (millions of PC hours / 30 days) for games that aren't (mainly) on Steam
const ADJUST = [
    // Not on Steam
    { id: "1402418491272986635", name: "Minecraft", estimate: 560, basis: "Newzoo #2 PC by MAU (2025); ~2.8M concurrent, all platforms",
        tags: ["Sandbox", "Survival", "Crafting", "Open World", "Building", "Cute", "Family Friendly", "Multiplayer", "Adventure", "Voxel"] },
    { id: "363445589247131668", name: "ROBLOX", estimate: 540, basis: "Newzoo #3 PC by MAU (2025); 120M+ daily players, all platforms",
        tags: ["Sandbox", "Multiplayer", "Family Friendly", "Cute", "Building", "Free to Play", "Casual", "Party Game"] },
    { id: "1402418696126992445", name: "League of Legends", estimate: 520, basis: "#1 on Twitch (2026 State of Gaming); 100M+ MAU estimates; PC only",
        tags: ["MOBA", "Multiplayer", "Competitive", "Free to Play", "Strategy", "Fantasy", "Team-Based", "PvP"] },
    { id: "700136079562375258", name: "VALORANT", estimate: 330, basis: "Newzoo #9 PC by MAU (2025); Twitch top 5; 14–35M monthly players",
        tags: ["FPS", "Shooter", "Tactical Shooter", "Hero Shooter", "Competitive", "Free to Play", "Multiplayer", "Team-Based"] },
    { id: "1402418703554842694", name: "Fortnite", estimate: 300, basis: "Newzoo #5 PC by MAU (2025); 0.6–1.4M concurrent, all platforms",
        tags: ["Battle Royale", "Shooter", "Third-Person Shooter", "Building", "Multiplayer", "Free to Play", "Cartoony", "Colorful"] },
    { id: "762434991303950386", name: "Genshin Impact", estimate: 110, basis: "MMO-Population: 8.2M daily players, all platforms",
        tags: ["Anime", "Open World", "Action RPG", "RPG", "Gacha", "Cute", "Free to Play", "Adventure", "Fantasy"] },
    { id: "1544195652903247973", name: "Teamfight Tactics", estimate: 70, basis: "League client mode; Twitch top 30",
        tags: ["Auto Battler", "Strategy", "Free to Play", "Cute", "Multiplayer", "Competitive", "Colorful"] },
    { id: "356875762940379136", name: "World of Warcraft", estimate: 60, basis: "#5 on Twitch (2026); MMO-Population 510k daily players",
        tags: ["MMORPG", "RPG", "Massively Multiplayer", "Fantasy", "Open World", "Adventure", "Multiplayer"] },
    { id: "1500967742772215959", name: "Call of Duty: Warzone", estimate: 50, basis: "Battle.net/Steam; Warzone launches inside Call of Duty HQ",
        tags: ["FPS", "Shooter", "Battle Royale", "Multiplayer", "Free to Play", "Military", "Action"] },
    { id: "1121201675240210523", name: "Honkai: Star Rail", estimate: 45, basis: "~20M MAU (mostly mobile); HoYoPlay on PC",
        tags: ["Anime", "RPG", "JRPG", "Turn-Based Combat", "Gacha", "Cute", "Free to Play", "Sci-fi"] },
    { id: "1423760184819581080", name: "Call of Duty: Black Ops 7", estimate: 40, basis: "2025 Call of Duty; Battle.net + Steam (Call of Duty HQ)",
        tags: ["FPS", "Shooter", "Multiplayer", "Military", "Action", "Zombies"] },
    { id: "1402416706776989886", name: "Crossfire", estimate: 30, basis: "Tencent/Smilegate; among China's most played PC shooters",
        tags: ["FPS", "Shooter", "Free to Play", "Multiplayer", "Military", "Competitive"] },
    { id: "1180205756998488064", name: "Old School RuneScape", estimate: 30, basis: "MMO-Population: 460k daily players; Jagex launcher > Steam",
        tags: null },
    { id: "1402416795352305716", name: "Dungeon & Fighter", estimate: 25, basis: "Nexon/Tencent; one of the most played PC games in China and Korea",
        tags: ["Action", "Beat 'em up", "RPG", "Anime", "2D", "Free to Play", "Massively Multiplayer"] },
    { id: "356889262362329098", name: "FINAL FANTASY XIV ONLINE", estimate: 25, basis: "MMO-Population: 200k daily players; own launcher > Steam",
        tags: null },
    { id: "1257819671114289184", name: "Zenless Zone Zero", estimate: 25, basis: "HoYoPlay on PC (small Steam share)", tags: null },
    { id: "1402418239342120960", name: "osu!", estimate: 20, basis: "Standalone client; ~30–50k online",
        tags: ["Rhythm", "Music", "Anime", "Cute", "Free to Play", "Competitive", "Indie", "Difficult"] },
    { id: "356875890958925834", name: "Hearthstone", estimate: 20, basis: "Battle.net only",
        tags: ["Card Game", "Strategy", "Free to Play", "Fantasy", "Turn-Based Strategy", "Colorful", "Deckbuilding"] },
    { id: "615752773690064908", name: "World of Warcraft Classic", estimate: 15, basis: "Battle.net only",
        tags: ["MMORPG", "RPG", "Massively Multiplayer", "Fantasy", "Open World", "Classic"] },
    { id: "742897755160313986", name: "Fall Guys", estimate: 15, basis: "Epic Games Store (Steam delisted)",
        tags: ["Battle Royale", "Party Game", "Cute", "Colorful", "Multiplayer", "Funny", "Free to Play", "Casual"] },
    { id: "357606832899883008", name: "RuneScape", estimate: 15, basis: "MMO-Population: 310k daily players; Jagex launcher > Steam", tags: null },
    { id: "358425800766128128", name: "StarCraft II", estimate: 8, basis: "Battle.net only",
        tags: ["RTS", "Strategy", "Sci-fi", "Competitive", "Free to Play", "Multiplayer"] },
    { id: "1417993715611467826", name: "2XKO", estimate: 4, basis: "Riot client only",
        tags: ["Fighting", "2D Fighter", "Free to Play", "Multiplayer", "Competitive", "Team-Based"] },

    // On Steam, but most PC players use another launcher
    { id: "359509007423242240", name: "The Sims 4", factor: 4, basis: "EA app majority; Newzoo #6 PC by MAU (2025)" },
    { id: "356877880938070016", name: "Rocket League", factor: 4, basis: "Epic-only for new players" },
    { id: "1402418078813523999", name: "World of Tanks", factor: 6, basis: "Wargaming launcher is the main client" },
    { id: "356875221078245376", name: "Overwatch", factor: 2.5, basis: "Battle.net majority" },
    { id: "1539812812854132867", name: "Call of Duty", factor: 2.5, basis: "Battle.net majority" },
    { id: "1113966530531704943", name: "Diablo IV", factor: 2.5, basis: "Battle.net majority" },
    { id: "406637848297472017", name: "Escape from Tarkov", factor: 2.5, basis: "BSG launcher majority" },
    { id: "1247227126416146462", name: "Wuthering Waves", factor: 3, basis: "Kuro launcher majority" },
    { id: "1328876348361412619", name: "Path of Exile 2", factor: 2, basis: "Standalone client" },
    { id: "356888453796986880", name: "Path of Exile", factor: 2, basis: "Standalone client" },
    { id: "359510095811444736", name: "MapleStory", factor: 2, basis: "Nexon launcher" },
    { id: "1402418714716143646", name: "Grand Theft Auto V Legacy", factor: 1.5, basis: "Rockstar launcher / Epic" },
    { id: "1421192030440263791", name: "Grand Theft Auto V Enhanced", factor: 1.5, basis: "Rockstar launcher / Epic" },
    { id: "542075586886107149", name: "Apex Legends", factor: 1.5, basis: "EA app" },
    { id: "356876590342340608", name: "Rainbow Six Siege", factor: 1.5, basis: "Ubisoft Connect" },
    { id: "357607478105604096", name: "War Thunder", factor: 1.6, basis: "Gaijin launcher; MMO-Population 690k daily" },
    { id: "1402418586244612216", name: "Warframe", factor: 1.3, basis: "Own launcher; MMO-Population 830k daily" },
    { id: "1314682894106497096", name: "Delta Force", factor: 1.5, basis: "Tencent launcher (China)" },
    { id: "1314395942253756416", name: "Marvel Rivals", factor: 1.3, basis: "Epic / NetEase launcher" },
    { id: "357607133254254632", name: "Dead by Daylight", factor: 1.2, basis: "Epic / Xbox app" },
    { id: "1402418440685486130", name: "Among Us", factor: 2, basis: "Epic / Xbox app / itch" },
];

// Steam apps whose Discord SKU points at the wrong Discord game.
const STEAM_TO_DISCORD = new Map([
    ["271590", "1402418714716143646"] // GTA V Legacy (Discord files both Steam apps under GTA V Enhanced)
]);

// Executables to use instead of the catalog's default pick, which for these games is a launcher,
// an anti-cheat wrapper, a regional client, a demo or a mod tool.
const EXE_FIXES = new Map([
    ["363445589247131668", "robloxplayerbeta.exe"], // ROBLOX
    ["1421192030440263791", "grand theft auto v enhanced/gta5_enhanced.exe"], // Grand Theft Auto V Enhanced
    ["1402418703554842694", "fortniteclient-win64-shipping_eac_eos.exe"], // Fortnite
    ["1402418696126992445", "league of legends.exe"], // League of Legends
    ["356942674672091136", "geometry dash/geometrydash.exe"], // Geometry Dash
    ["1402418717781921935", "win64/tslgame_uc.exe"], // PUBG: BATTLEGROUNDS
    ["1445161512720269435", "hl.exe"], // Counter-Strike
    ["1402418594532298837", "rustclient.exe"], // Rust
    ["356876590342340608", "tom clancy's rainbow six siege/rainbowsix_vulkan.exe"], // Rainbow Six Siege
    ["1402418714716143646", "grand theft auto v/gta5.exe"], // Grand Theft Auto V Legacy
    ["1314395942253756416", "win64/marvel-win64-shipping.exe"], // Marvel Rivals
    ["425778010222886912", "assettocorsa.exe"], // Assetto Corsa
    ["787443973538971748", "x64/cyberpunk2077.exe"], // Cyberpunk 2077
    ["1402416803866738808", "unturned_be.exe"], // Unturned
    ["1402418440685486130", "among us/among us.exe"], // Among Us
    ["1124349969906815007", "tmodloader/tmodloader64bit.exe"], // tModLoader
    ["356879032584896512", "win64/gmod.exe"], // Garry's Mod
    ["1402418586244612216", "warframe.x64.exe"], // Warframe
    ["356944273133928458", "brawlhalla.exe"], // Brawlhalla
    ["1276737795012165766", "win64/project8.exe"], // Deadlock
    ["1425690433018925056", "battlefield 6/bf6.exe"], // Battlefield 6
    ["1182713227491147776", "win64/discovery.exe"], // THE FINALS
    ["1500967742772215959", "cod.exe"], // Call of Duty: Warzone
    ["356875762940379136", "_retail_/wow.exe"], // World of Warcraft
    ["1544195652903247973", "league of legends.exe"], // Teamfight Tactics
    ["1180205756998488064", "win64/osclient.exe"], // Old School RuneScape
    ["358425800766128128", "sc2.exe"], // StarCraft II: Battle Chest
    ["1328876348361412619", "path of exile 2 - poe2_production/pathofexile.exe"], // Path of Exile 2
    ["1334673895453884566", "content/vampiresurvivors.exe"], // Vampire Survivors
    ["1137125502985961543", "bin/bg3_dx11.exe"], // Baldur's Gate III
    ["1353866015351636098", "schedule i/schedule i.exe"], // Schedule I
    ["356954277803065354", "left 4 dead 2/left4dead2.exe"], // Left 4 Dead 2
    ["1402416959819350078", "factorygameegs-win64-shipping.exe"], // Satisfactory
    ["363413465584500737", "rimworldwin.exe"], // RimWorld
    ["426526722322726912", "projectzomboid32.exe"], // Project Zomboid
    ["359509007423242240", "ts4.exe"], // The Sims 4
    ["1402418309189603418", "age of empires ii definitive edition/aoe2de_s.exe"] // Age of Empires II: Definitive Edition
]);

// Factors by catalog name for the rest of the multi-launcher games (applied when the ID isn't in ADJUST).
const FACTOR_BY_NAME = [
    [/^EA SPORTS FC/i, 2, "EA app"], [/^Battlefield/i, 2, "EA app"], [/^Forza Horizon/i, 2, "Xbox app / Game Pass"],
    [/^Sea of Thieves/i, 2, "Xbox app / Game Pass"], [/^Halo/i, 2, "Xbox app / Game Pass"],
    [/^Microsoft Flight Simulator/i, 2, "Xbox app / Game Pass"], [/^Grounded/i, 2, "Xbox app / Game Pass"],
    [/^Gears of War/i, 2, "Xbox app / Game Pass"], [/^World of Warships/i, 2.5, "Wargaming launcher"],
    [/^Black Desert/i, 2, "Pearl Abyss launcher"], [/^Lost Ark/i, 1.2, "Smilegate launcher (Korea)"],
    [/^NARAKA/i, 1.5, "NetEase launcher (China)"], [/^Diablo II/i, 3, "Battle.net majority"],
    [/^Guild Wars 2/i, 2, "ArenaNet launcher"], [/^The Elder Scrolls Online/i, 2, "Own launcher"],
    [/^EVE Online/i, 2, "Own launcher"], [/^Albion Online/i, 1.5, "Own launcher"]
];

const SOURCES = [
    { label: "Steam Charts (steamcharts.com): 30-day hours played", url: "https://steamcharts.com/top" },
    { label: "Steam official charts API (most played, concurrent)", url: "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/" },
    { label: "SteamSpy: user tags", url: "https://steamspy.com/api.php" },
    { label: "Discord detectable games catalog", url: "https://discord.com/api/v9/applications/detectable" },
    { label: "SteamDB charts", url: "https://steamdb.info/charts/" },
    { label: "Newzoo top PC games by MAU, 2025 (via Gigazine)", url: "https://wbgsv0a.gigazine.net/gsc_news/en/20251220-2025-top-10-games" },
    { label: "Twitch State of Gaming 2026", url: "https://streamer.guide/blog/twitch-state-of-gaming-2026" },
    { label: "TwitchTracker: top games by viewers", url: "https://twitchtracker.com/games" },
    { label: "MMO-Population: daily player estimates", url: "https://mmo-population.com/" },
    { label: "ActivePlayer.io: most played games", url: "https://activeplayer.io/most-played-games/" },
    { label: "DemandSage: most played games right now", url: "https://demandsage.com/most-played-games-right-now" },
    { label: "LinuxBuz: PC games by monthly users", url: "https://linuxbuz.com/best-resources/most-popular-pc-games-by-monthly-active-users-2026" },
    { label: "Shane the Gamer: most played video games statistics", url: "https://www.shanethegamer.com/research/most-played-video-games-statistics/" },
    { label: "Statista: PC gaming worldwide", url: "https://www.statista.com/topics/11985/pc-gaming-worldwide" }
];

// ---------- fetching (cached) ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cached(name, url, { type = "text", delay = 0 } = {}) {
    const path = join(CACHE, name);
    if (!REFRESH && existsSync(path)) {
        const text = await readFile(path, "utf8");
        if (text.length > 2) return type === "json" ? JSON.parse(text) : text;
    }
    if (delay) await sleep(delay);
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 DiscordBadgeUnlocker ranking builder" } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const text = await res.text();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    return type === "json" ? JSON.parse(text) : text;
}

const decode = s => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&#43;/g, "+").trim();

function parseSteamcharts(html) {
    const re = /<td class="game-name left">\s*<a href="\/app\/(\d+)">\s*([\s\S]*?)\s*<\/a>[\s\S]*?<td class="num">(\d+)<\/td>[\s\S]*?peak-concurrent">(\d+)<\/td>\s*<td class="num period-col player-hours">(\d+)<\/td>/g;
    const rows = [];
    let m;
    while ((m = re.exec(html))) rows.push({ appid: m[1], name: decode(m[2]), current: +m[3], peak30: +m[4], hours30: +m[5] });
    return rows;
}

// ---------- build ----------

const log = (...a) => console.error(...a);

const charts = [];
for (let p = 1; p <= PAGES; p++) {
    charts.push(...parseSteamcharts(await cached(`steamcharts-p${p}.html`, `https://steamcharts.com/top/p.${p}`, { delay: 1000 })));
}
log(`steamcharts: ${charts.length} rows`);
const mostPlayed = (await cached("steam-mostplayed.json", "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/", { type: "json" })).response.ranks;
const concurrent = (await cached("steam-concurrent.json", "https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/", { type: "json" })).response.ranks;
const apps = await cached("detectable-raw.json", "https://discord.com/api/v9/applications/detectable", { type: "json" });
log(`Discord catalog: ${apps.length} apps`);

// Steam rows: steamcharts first, then official-chart games steamcharts doesn't list.
const steamRows = new Map();
for (const row of charts) if (!steamRows.has(row.appid)) steamRows.set(row.appid, { appid: row.appid, name: row.name, score: row.hours30 / 1e6, basis: "Steam: 30-day hours" });
for (const r of [...mostPlayed, ...concurrent]) {
    const appid = String(r.appid);
    if (steamRows.has(appid)) continue;
    const peak = Math.max(...[mostPlayed, concurrent].map(list => list.find(x => String(x.appid) === appid)?.peak_in_game ?? 0));
    steamRows.set(appid, { appid, name: null, score: (peak * 0.7 * 720) / 1e6, basis: "Steam: daily peak × 0.7 × 720h" });
}

// SteamSpy tags (1 request/second when not cached).
const tagsBySteam = new Map();
let fetched = 0;
for (const appid of steamRows.keys()) {
    const path = `steamspy/${appid}.json`;
    const isCached = !REFRESH && existsSync(join(CACHE, path));
    try {
        const data = await cached(path, `https://steamspy.com/api.php?request=appdetails&appid=${appid}`, { type: "json", delay: isCached ? 0 : 1100 });
        const tags = Object.entries(data?.tags && !Array.isArray(data.tags) ? data.tags : {}).sort((a, b) => b[1] - a[1]).map(([t]) => t);
        tagsBySteam.set(appid, tags);
        if (!steamRows.get(appid).name && data?.name) steamRows.get(appid).name = data.name;
    } catch (e) {
        log(`  SteamSpy ${appid}: ${e.message}`);
    }
    if (!isCached && ++fetched % 50 === 0) log(`  SteamSpy: ${fetched} fetched`);
}

// Discord mapping.
const bySteam = new Map();
const byName = new Map();
const byId = new Map(apps.map(a => [String(a.id), a]));
for (const app of apps) {
    for (const sku of app.third_party_skus ?? []) if (sku.distributor === "steam" && sku.id) bySteam.set(String(sku.id), app);
    const key = normalizeText(String(app.name).replace(/[™®©]/g, ""));
    if (!byName.has(key)) byName.set(key, app);
}

const adjustById = new Map(ADJUST.map(a => [a.id, a]));
const entries = new Map(); // discord id -> entry
const dropped = [];

for (const row of steamRows.values()) {
    const tags = tagsBySteam.get(row.appid) ?? [];
    const top = tags.slice(0, TOP_TAGS);
    if (EXCLUDE_STEAM.has(row.appid)) { dropped.push(`${row.name} (${EXCLUDE_STEAM.get(row.appid)})`); continue; }
    const bad = AUTO_EXCLUDE_TAGS.find(t => top.slice(0, 8).includes(t));
    if (bad) { dropped.push(`${row.name} (tag: ${bad})`); continue; }
    if (row.name && (IDLE_NAME.test(row.name) || EXCLUDE_NAMES.has(normalizeText(row.name)))) { dropped.push(`${row.name} (name)`); continue; }
    const app = byId.get(STEAM_TO_DISCORD.get(row.appid)) ?? bySteam.get(row.appid) ?? byName.get(normalizeText(String(row.name ?? "").replace(/[™®©]/g, "")));
    if (!app) { dropped.push(`${row.name} (not in Discord's catalog)`); continue; }
    const id = String(app.id);
    const prev = entries.get(id);
    if (prev) { prev.score += row.score; continue; } // two Steam apps → one Discord game
    entries.set(id, { id, app, steam: row.appid, score: row.score, basis: row.basis, tags });
}

for (const adj of ADJUST) {
    const app = byId.get(adj.id);
    if (!app) { log(`  ADJUST: ${adj.name} (${adj.id}) not in catalog`); continue; }
    let entry = entries.get(adj.id);
    if (adj.estimate != null) {
        if (!entry) {
            const steamSku = (app.third_party_skus ?? []).find(s => s.distributor === "steam")?.id;
            entry = { id: adj.id, app, steam: steamSku ? String(steamSku) : null, score: 0, basis: "", tags: [] };
            entries.set(adj.id, entry);
        }
        entry.score = adj.estimate;
        entry.basis = `Estimate: ${adj.basis}`;
    } else if (entry) {
        entry.score *= adj.factor;
        entry.basis = `${entry.basis} × ${adj.factor} (${adj.basis})`;
    } else {
        log(`  ADJUST: ${adj.name} has a factor but no Steam data`);
        continue;
    }
    if (adj.tags) entry.tags = adj.tags;
    else if (!entry.tags.length && entry.steam && tagsBySteam.has(entry.steam)) entry.tags = tagsBySteam.get(entry.steam);
}

for (const entry of entries.values()) {
    if (adjustById.has(entry.id)) continue;
    const hit = FACTOR_BY_NAME.find(([re]) => re.test(entry.app.name));
    if (hit) {
        entry.score *= hit[1];
        entry.basis = `${entry.basis} × ${hit[1]} (${hit[2]})`;
    }
}

const games = [...entries.values()]
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score || (a.app.name < b.app.name ? -1 : 1))
    .map((e, i) => ({
        rank: i + 1,
        id: e.id,
        name: e.app.name,
        exe: EXE_FIXES.get(e.id) ?? pickExe(e.app.executables, e.app.name),
        score: Math.round(e.score * 10) / 10,
        tags: e.tags.slice(0, TOP_TAGS),
        basis: e.basis
    }))
    .filter(g => g.exe);

const counts = countByVibe({ games });
const out = {
    version: 1,
    kind: "ranking",
    name: "Global most played (PC)",
    updated: new Date().toISOString().slice(0, 10),
    metric: "Estimated PC hours played in the last 30 days, in millions",
    method: "Steam: steamcharts.com 30-day hours (official chart API for games it misses). Games mostly played " +
        "through other launchers get a launcher factor; games not on Steam get an estimate from the sources below. " +
        "Each game keeps its top SteamSpy tags; vibes are derived from them. Tools, idle games, adult games, demos and servers are excluded.",
    sources: SOURCES,
    count: games.length,
    games
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, '{\n' + Object.entries(out).filter(([k]) => k !== "games").map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") +
    ',\n  "games": [\n' + games.map(g => "    " + JSON.stringify(g)).join(",\n") + "\n  ]\n}\n");

log(`Dropped ${dropped.length}: ${dropped.join("; ")}`);
log(`Wrote ${games.length} games to ${OUT}`);
log(`Vibes: ${VIBES.map(v => `${v.key} ${counts[v.key]}`).join(", ")}`);
log(`Top 25: ${games.slice(0, 25).map(g => `${g.rank}. ${g.name} (${g.score})`).join(", ")}`);
