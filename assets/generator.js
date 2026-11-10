// The generator UI: Random or Custom, then Advanced. Loaded lazily (preloaded on idle) by app.js.
// All script text comes from the shared skill code, so the page and the CLI produce identical files.

import {
    BADGE_TIERS, GAME_TIME_SINCE, ORIGINAL_MAX, TIERS, VIBES, assignHours, catalogIndex, countByVibe, countableHours, fitTier,
    formatCount, formatHours, hoursSince, minHours, normalizeSelection, parseRanking, pickFromRanking, pickRandom, randomPool,
    resolveSelection, roundHours, scaleTo,
    searchCatalog, sendGames, sendHours, splitEvenly, sumHours, summarize, tierAim, tierFor, toTenths, validateTable, vibeKey
} from "../skills/discord-badge-unlocker/scripts/core.mjs";
import {
    BACKDATE_BLURB, CLOCKS, DEFAULT_OPTIONS, FIRST_HEARTBEAT, OUTPUTS, isTimeZone, loadTemplates, normalizeOptions, renderFirstHeartbeat,
    renderScripts, zonedTimeToMs
} from "../skills/discord-badge-unlocker/scripts/templates.mjs";

const DATA = new URL("../data/", import.meta.url);
const STORE_KEY = "discordBadgeUnlocker:v2";
const OLD_KEY = "discordBadgeUnlocker:v1";

const fetchJson = url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))));

// Start downloading everything the generator needs as soon as this module is preloaded.
const templatesPromise = loadTemplates();
const rankingPromise = fetchJson(new URL("rankings/global.json", DATA)).then(parseRanking);
const examplePromise = fetchJson(new URL("presets/example.json", DATA));
for (const p of [templatesPromise, rankingPromise, examplePromise]) p.catch(() => {});

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pos = (value, fallback = 0) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const hrs = h => formatHours(h).replace(/\.0$/, ""); // "1,000", not "1,000.0"
const addHours = (a, b) => (toTenths(a) + toTenths(b)) / 10;
const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;
// "A", "A and B", "A, B and C", "A, B, C and 4 more"
const listNames = (names, max = 3) => {
    const shown = names.length <= max ? names.slice(0, -1) : names.slice(0, max);
    const last = names.length <= max ? names.at(-1) : `${names.length - max} more`;
    return shown.length ? `${shown.join(", ")} and ${last}` : last ?? "";
};
const normalizeHave = have => ({ games: Math.floor(pos(have?.games)), hours: roundHours(pos(have?.hours)) });

// Hover hints (assets/tips.js reads data-tip). Short ones live inline in the markup below.
const TIP = {
    since: "Caps the hours at the time since this day (00:00 UTC). The scripts warn if a session would start before it. Leave empty to skip.",
    variety: "The original-style engine. While it claims, it also shows each game as your activity. Run only one of the three scripts.",
    gameTime: "The main script's engine under the original window.__gameTimePresence.boost() name. Run only one of the three scripts.",
    main: "Both badges in one run. Paste it into the console of the Discord desktop app (Ctrl+Shift+I).",
    // After Copy or Download. Both requirements are from Discord's help article on the badges.
    run: "into the console of the Discord desktop app (Ctrl+Shift+I). Discord in a browser won't work, and nothing counts " +
        "unless “Use data to personalize my Discord experience” is on.",
    hours: "Discord drops any play session over 24h, so each game's hours go out as back-to-back sessions of at most 23h, " +
        "the last ending when the script runs. Game Time only counts time played on " +
        "or after 8 December 2025, and it tops out at 5,000h (Eternal). Badges take about 1–2 days to update.",
    dUntested: "On: every game Discord lists, including the ones it lists no Windows executable for. " +
        "Off: only games with a real Windows executable, like the original Variety script.",
    untested: "Discord's catalog lists no Windows executable for these games, so the scripts send a made-up “name.exe” with them. " +
        "The original Game Time script sent games like these; the original Variety script left them out. " +
        "Nobody has confirmed whether Discord counts them. To be safe, swap them for other games or add a few spare.",
    firstDate: "The date doesn't really matter for badges. A badge shows the date of the latest tier you got, so it moves " +
        "forward on its own: if you later reach the top tier naturally, the date updates to that day. An old first heartbeat " +
        "won't stay as your badge date. Game Time also only counts time played on or after 8 December 2025."
};
const HELP_URL = "https://support.discord.com/hc/en-us/articles/44369363856663";
const MAX_HOURS_EACH = 1e6; // the most per game the scripts sum exactly across the whole catalog
const TABLE_KEY = "discordBadgeUnlocker:danger-table"; // the Danger Zone table, kept apart from the small state
const TABLE_HEAD = "# id\tname\texe\thours  (one game per line, tab-separated; lines starting with # are skipped)";
// Danger Zone script options: [option path, label, max]; no max means on/off. Limits from normalizeOptions({ uncapped }).
const DANGER_OPTIONS = [
    ["batchSize", "Batch size", 100000], ["delayMs", "Delay ms", 86400000],
    ["variety.batchSize", "Variety batch size", 100000], ["variety.delayMs", "Variety delay ms", 86400000],
    ["variety.rotateMinutes", "Minutes per game", 525600], ["dryRun", "Dry run"], ["variety.keepRotating", "Keep rotating (Variety)"]
];
const cleanCell = value => String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();

// Reads the Danger Zone table: [{ id, name, exe, hours }] in table order, plus the lines it can't use.
function parseTable(text, nameFor) {
    const rows = [];
    const problems = [];
    text.split("\n").forEach((line, i) => {
        if (!line.trim() || line.trimStart().startsWith("#")) return;
        const [id = "", name = "", exe = "", hours = ""] = line.split("\t").map(cell => cell.trim());
        const at = `line ${i + 1}`;
        const h = roundHours(Number(hours));
        if (!/^\d+$/.test(id)) problems.push(`${at}: the id must be digits`);
        else if (!exe) problems.push(`${at}: no exe`);
        else if (!(h >= 0.1)) problems.push(`${at}: hours must be a number of at least 0.1`);
        else if (h > MAX_HOURS_EACH) problems.push(`${at}: more than ${formatCount(MAX_HOURS_EACH)}h, the most the scripts add up exactly`);
        else rows.push({ id, name: name || nameFor(id) || id, exe, hours: h });
    });
    return { rows, problems };
}

const INFO_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.6" r="1.25" fill="currentColor" stroke="none"/></svg>`;
const FILE = Object.fromEntries(OUTPUTS.map(o => [o.key, o.file]));
const infoButton = (tip, label = "Why?") =>
    `<button type="button" class="info-btn" data-tip="${esc(tip)}" data-tip-click aria-label="${label}">${INFO_ICON}</button>`;
const span = ms => { // "45 s", "12 min", "3.4 h", "2.1 days"
    const s = ms / 1000;
    return s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`;
};
const bytes = n => (n < 1e6 ? `${Math.round(n / 1e3)} KB` : `${(n / 1e6).toFixed(1)} MB`);
const compact = n => (n < 1e6 ? formatCount(Math.round(n)) : n < 1e9 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e9).toFixed(1)}B`); // "601,536", "197.4M"

// Script options in Advanced: [option path, label, hint, min, max]; no min/max means an on/off switch.
const D = DEFAULT_OPTIONS;
const ms = n => `${formatCount(n)}ms`;
const OPTIONS = [
    ["dryRun", "Dry run", "Build every event but send nothing, for a safe test run"],
    ["variety.keepRotating", "Keep rotating (Variety)", "Variety script only: keep showing games as your activity after the claim finishes, until stop()"],
    ["batchSize", "Batch size", `Games per request in the main and Game Time scripts (default ${D.batchSize})`, 1, 100],
    ["delayMs", "Delay (ms)", `Wait between requests in the main and Game Time scripts (default ${ms(D.delayMs)})`, 0, 60000],
    ["variety.batchSize", "Variety batch size", `Games per request in the Variety script (default ${D.variety.batchSize})`, 1, 50],
    ["variety.delayMs", "Variety delay (ms)", `Wait between requests in the Variety script (default ${ms(D.variety.delayMs)})`, 0, 60000],
    ["variety.rotateMinutes", "Minutes per game", `How long the Variety script shows each game as your activity (default ${D.variety.rotateMinutes} min)`, 1, 1440]
];

// ---------- badge tiers ----------

// `have`: the "Already played" field the badge counts; `add`: played + sent.
const BADGES = {
    variety: { label: "Game Variety", short: "Variety", have: "games", fmt: formatCount, add: (a, b) => a + b,
        amount: n => `${formatCount(n)} game${n === 1 ? "" : "s"}` },
    time: { label: "Game Time", short: "Time", have: "hours", fmt: hrs, add: addHours, amount: n => `${hrs(n)}h` }
};
const BADGE_KEYS = Object.keys(BADGES);
// Each tier's colour, taken from its icon and lightened where needed to read on the dark panel.
const TIER_COLOR = {
    sampler: "#9abbca", dabbler: "#8dbc82", enthusiast: "#58ce6b", ranger: "#39d6d6", explorer: "#4cc6ff",
    adventurer: "#77a0ff", voyager: "#a98bff", maverick: "#ff73ea", polymath: "#ff6b88", universalist: "#ffba54",
    casual: "#9abbca", recreational: "#8dbc82", dedicated: "#58ce6b", committed: "#39d7d7", serious: "#39caff",
    devoted: "#5aa2ff", seasoned: "#a98bff", ironclad: "#ff73ea", unshakeable: "#ff6b88", eternal: "#ffae03"
};
const tierIcon = (badge, tier) => new URL(`./badges/${badge}-${tier.key}.svg`, import.meta.url).href;
const topTier = badge => BADGE_TIERS[badge].length - 1;
const isTier = (badge, i) => Number.isInteger(i) && i >= -1 && i <= topTier(badge);

function setTierIcon(img, badge, tier) {
    img.hidden = !tier;
    if (tier && img.dataset.key !== tier.key) { img.src = tierIcon(badge, tier); img.dataset.key = tier.key; }
}

const DEFAULT_STATE = () => ({
    mode: "random",
    have: { games: 0, hours: 0 }, // what Discord already counts; everything sent adds to it
    // goal: the tiers picked in Random, kept while "Already played" changes so the sent amounts follow
    random: { count: tierAim("variety", topTier("variety")), hours: tierAim("time", topTier("time")), seed: newSeed(), goal: null },
    custom: { name: null, vibe: "popular", top: 100, total: tierAim("time", topTier("time")), spread: "weighted", games: [], manual: null },
    // count null: every game in the pool. The table itself lives under TABLE_KEY.
    danger: { count: null, hours: 24, untested: true, seed: newSeed(), options: normalizeOptions({}, { uncapped: true }) },
    // Danger Zone test: one game, one session, first heartbeat at `first` (datetime-local, read in timeZone or this computer's).
    // Backdate is a switch; clock is "off", "page" or "system" (system shifts the page clock too).
    dzTest: { game: null, first: "", hours: 1, untilNow: false, backdate: true, clock: "off", timeZone: "" },
    trackStart: null,
    options: normalizeOptions()
});

function loadState() {
    const state = DEFAULT_STATE();
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
        if (saved) {
            state.mode = saved.mode === "custom" ? "custom" : "random";
            state.random = { ...state.random, ...(saved.random ?? {}) };
            state.custom = { ...state.custom, ...(saved.custom ?? {}) };
            state.custom.vibe = vibeKey(state.custom.vibe);
            state.danger = { ...state.danger, ...(saved.danger ?? {}) };
            state.danger.options = normalizeOptions(state.danger.options, { uncapped: true });
            state.dzTest = { ...state.dzTest, ...(saved.dzTest ?? {}) };
            state.have = normalizeHave(saved.have);
            state.custom.games = normalizeSelection({ games: state.custom.games ?? [] }).games;
            if (!state.custom.manual || typeof state.custom.manual !== "object") state.custom.manual = null;
            state.trackStart = saved.trackStart ?? null;
            state.options = normalizeOptions(saved.options);
            return state;
        }
        const old = JSON.parse(localStorage.getItem(OLD_KEY) || "null"); // earlier page version
        if (old?.selection?.games?.length) {
            const sel = normalizeSelection(old.selection);
            Object.assign(state, { mode: "custom", trackStart: sel.trackStart, options: normalizeOptions(old.options) });
            Object.assign(state.custom, { name: sel.name ?? null, games: sel.games, spread: "manual" });
        }
    } catch (_) {}
    return state;
}

function download(name, text, type = "text/javascript") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (_) {
        const area = Object.assign(document.createElement("textarea"), { value: text });
        document.body.append(area);
        area.select();
        const ok = document.execCommand?.("copy") ?? false;
        area.remove();
        return ok;
    }
}

export function mount(root, { catalogPromise }) {
    root.innerHTML = `<div class="wait"><span class="spinner"></span>Loading Discord's catalog…</div>`;
    Promise.all([catalogPromise, templatesPromise]).then(
        ([catalog, templates]) => build(root, catalog, templates),
        error => { root.innerHTML = `<div class="wait">${esc(error.message)}</div>`; }
    );
}

// Random: one row of tier icons per badge, plus the exact number next to the tier's name.
const picker = (badge, ref, unit, attrs, tip) => `
  <div class="badge-pick">
    <div class="badge-head">
      <span class="cat">${BADGES[badge].label}${badge === "time" ? infoButton(TIP.hours, "About Game Time") : ""}</span>
      <span class="badge-now"><b class="tier-name" data-ref="name-${badge}"></b>
        <span class="sent"><span class="have-plus" data-ref="plus-${badge}" hidden></span>
          <label class="mini-field" data-tip="${tip}"><input type="number" ${attrs} data-ref="${ref}" aria-label="${BADGES[badge].label}: new ${unit}"> ${unit}</label></span></span>
    </div>
    <div class="tier-row" role="group" aria-label="${BADGES[badge].label} tier">
      ${BADGE_TIERS[badge].map((tier, i) => `<button type="button" class="tier-btn" data-tier="${badge}" data-i="${i}" aria-pressed="false" aria-label="${tier.name}" style="--tier:${TIER_COLOR[tier.key]}"><img src="${tierIcon(badge, tier)}" alt="" width="32" height="32" draggable="false"></button>`).join("")}
    </div>
  </div>`;

const haveField = (badge, attrs, label, unit) => `<label class="have-field" data-ref="haveField-${badge}"><img data-ref="haveIcon-${badge}" alt="" width="20" height="20" draggable="false" hidden><input type="number" min="0" ${attrs} placeholder="0" data-ref="have-${badge}" aria-label="${label}"> ${unit}</label>`;

const optionRow = ([path, label, tip, min, max]) => min == null
    ? `<label class="opt" data-tip="${tip}">${label}<span class="switch"><input type="checkbox" data-opt="${path}"><span></span></span></label>`
    : `<label class="opt" data-tip="${tip}">${label}<input type="number" min="${min}" max="${max}" data-opt="${path}"></label>`;

const markup = catalogSize => `
<section class="have" aria-label="Already played" data-ref="have">
  <span class="cat" data-tip="What Discord already counts for your badges. Everything you send adds to it.">Already played</span>
  ${haveField("variety", `step="1" inputmode="numeric"`, "Games already played", "games")}
  ${haveField("time", `step="0.1" inputmode="decimal"`, "Hours already played", "h")}
</section>

<div class="seg big" role="group" aria-label="Mode" data-ref="modes">
  <button type="button" data-mode="random" data-tip="Pick the badge tiers you want. Random games from Discord's catalog get you there, like the original scripts.">Random</button>
  <button type="button" data-mode="custom" data-tip="Choose the games yourself: the top games of a vibe, or search. Then spread the hours.">Custom</button>
</div>

<section class="card" data-pane="random">
  ${picker("variety", "rCount", "games", `min="1" step="1" inputmode="numeric"`, "Or type an exact number of random games")}
  <div class="divider"></div>
  ${picker("time", "rHours", "h", `min="0.1" step="1" inputmode="decimal"`, "Or type exact hours, split evenly across the games")}
  <div class="row">
    <button class="btn" type="button" data-action="max" data-ref="max" data-tip="The original script's defaults: ${ORIGINAL_MAX.games} games and ${formatCount(ORIGINAL_MAX.hours)}h">Max</button>
    <button class="btn" type="button" data-action="shuffle" data-tip="Pick a different random set of games">Shuffle</button>
  </div>
  <details class="peek"><summary data-ref="rSummary" data-tip="See which games this pick sends"></summary><ol class="peek-list" data-ref="rList"></ol></details>
</section>

<section class="dz" data-pane="danger" hidden>
  <div class="dz-side">
    <section class="dz-box">
      <h3 class="cat">Generate</h3>
      <div class="dz-fields">
        <label><span>Games <small data-ref="dOf"></small></span><input type="number" min="1" step="1" inputmode="numeric" data-ref="dCount" data-gen></label>
        <label>Hours each<input type="number" min="0.1" max="${MAX_HOURS_EACH}" step="0.1" inputmode="decimal" data-ref="dHours" data-gen></label>
        <label>Seed<input type="number" min="0" max="4294967295" step="1" inputmode="numeric" data-ref="dSeed" data-gen></label>
        <label class="opt dz-opt" data-tip="${TIP.dUntested}">Include untested<span class="switch"><input type="checkbox" data-ref="dUntested"><span></span></span></label>
      </div>
      <div class="dz-buttons">
        <button class="btn primary sm" type="button" data-action="d-generate" data-tip="Replace the table using these fields. Enter in a field does the same.">Generate</button>
        <button class="btn sm" type="button" data-action="d-all" data-ref="dAll">All games</button>
        <button class="btn sm" type="button" data-action="shuffle" data-tip="A new seed, then Generate">Shuffle</button>
        <button class="btn sm" type="button" data-action="d-max" data-tip="Every game Discord lists, each with the most hours Game Time can count">Max everything</button>
      </div>
      <div class="dz-buttons dz-three"><span class="dz-label">Every row</span>
        <button class="btn sm" type="button" data-action="d-apply" data-tip="Set every row's hours to Hours each">Hours each</button>
        <button class="btn sm" type="button" data-action="d-24" data-tip="The original Game Time script's final choice: 250 games × 24h">24h</button>
        <button class="btn sm" type="button" data-action="d-since" data-ref="dSince">Max that counts</button>
      </div>
    </section>
    <section class="dz-box">
      <h3 class="cat">Script options</h3>
      <div class="dz-fields">
        ${DANGER_OPTIONS.filter(([, , max]) => max != null).map(([path, label, max]) =>
            `<label>${label}<input type="number" min="${path.endsWith("delayMs") ? 0 : 1}" max="${max}" step="1" inputmode="numeric" data-dopt="${path}"></label>`).join("\n        ")}
        <label data-tip="${TIP.since}">Played since<input type="date" data-ref="dTrack"></label>
        ${DANGER_OPTIONS.filter(([, , max]) => max == null).map(([path, label]) =>
            `<label class="opt dz-opt dz-wide">${label}<span class="switch"><input type="checkbox" data-dopt="${path}"><span></span></span></label>`).join("\n        ")}
      </div>
    </section>
    <section class="dz-box"><h3 class="cat">Run (main script)</h3><dl class="dz-stats" data-ref="blast"></dl></section>
    <section class="dz-box">
      <h3 class="cat">Scripts</h3>
      ${OUTPUTS.map(o => `<div class="dz-script"><code>${o.file}</code><button class="btn sm" type="button" data-copy="${o.key}">Copy</button><button class="btn sm" type="button" data-download="${o.key}">Download</button></div>`).join("\n      ")}
    </section>
    <section class="dz-box dz-test">
      <h3 class="cat">Test: first heartbeat</h3>
      <p class="dz-help">One game, one session, with its first heartbeat on the date you set. Every run sends another session and adds its hours.</p>
      <div class="dz-fields">
        <div class="dz-wide"><span>Game</span><div class="search"><svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.6-4.6"/></svg><input type="search" placeholder="Search games" autocomplete="off" data-ref="tSearch" aria-label="Test game"><ul class="menu" data-ref="tResults" hidden></ul></div></div>
        <div class="dz-wide"><span class="t-first-head"><span data-tip="Read in the time zone below, or this computer's when that's empty">First heartbeat</span>
          <button type="button" class="info-btn t-info" data-tip="${esc(TIP.firstDate)}" data-tip-click aria-label="Does the date matter?">${INFO_ICON}<span>Does the date matter?</span></button></span>
          <input type="datetime-local" step="60" data-ref="tFirst" aria-label="First heartbeat"></div>
        <label>Hours<input type="number" min="0.1" step="0.1" inputmode="decimal" data-ref="tHours"></label>
        <label class="opt dz-opt" data-ref="tUntilField" data-tip="Run the session from the first heartbeat right up to the moment the script runs. That can be thousands of hours.">Until now<span class="switch"><input type="checkbox" data-ref="tUntilNow"><span></span></span></label>
        <label class="opt dz-opt dz-wide" data-tip="${esc(BACKDATE_BLURB)}">Backdate<span class="switch"><input type="checkbox" data-ref="tBackdate"><span></span></span></label>
        <div class="dz-wide"><span>Clock</span><div class="seg dz-seg" role="group" aria-label="Clock">
          ${CLOCKS.map(c => `<button type="button" data-t-clock="${c.key}" data-tip="${esc(c.blurb)}">${c.short}</button>`).join("")}</div></div>
        <div class="dz-wide" data-ref="tZoneField"><span data-tip="What the shifted page clock reports as its time zone, and the zone the first heartbeat is read in. Empty keeps yours.">Time zone</span>
          <div class="search"><input type="search" placeholder="${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}" autocomplete="off" spellcheck="false" data-ref="tZone" aria-label="Page clock time zone"><ul class="menu" data-ref="tZones" hidden></ul></div></div>
      </div>
      <p class="dz-help" data-ref="tMethod"></p>
      <ul class="dz-notes" data-ref="tNotes"></ul>
      <div class="dz-script"><code>${FIRST_HEARTBEAT.file}</code><button class="btn sm" type="button" data-t="copy">Copy</button><button class="btn sm" type="button" data-t="download">Download</button></div>
    </section>
    <section class="dz-box"><h3 class="cat">What Discord says</h3><ul class="fact-list" data-ref="facts"></ul></section>
  </div>
  <div class="dz-main">
    <div class="dz-toolbar"><span data-ref="dRows"></span><span class="dz-spacer"></span>
      <button class="btn sm" type="button" data-action="d-copy-table">Copy table</button>
      <button class="btn sm" type="button" data-action="d-clear" data-ref="dClear" data-tip="Empty the table">Clear</button>
    </div>
    <textarea class="dz-table" data-ref="dTable" spellcheck="false" autocomplete="off" wrap="off" aria-label="Game table: id, name, exe and hours, tab-separated" aria-describedby="dz-table-help"></textarea>
    <p class="dz-help" id="dz-table-help">Edit anything: this is exactly what the scripts send, in this order. Tab inserts a tab; press Esc, then Tab, to move on.</p>
    <ul class="dz-problems" data-ref="dProblems"></ul>
    <details class="dz-box dz-preview peek" data-ref="dPreviewBox"><summary>Main script preview</summary><textarea class="dz-code" readonly spellcheck="false" wrap="off" data-ref="dPreview" aria-label="Main script"></textarea></details>
  </div>
</section>

<section class="card" data-pane="custom">
  <h3 class="cat">Hours${infoButton(TIP.hours, "About hours")}</h3>
  <div class="row">
    <div class="seg grow" role="group" aria-label="Spread" data-ref="spread">
      <button type="button" data-spread="weighted" data-tip="More hours for the most played games, fewer for niche ones (by the square root of popularity)">Weighted</button>
      <button type="button" data-spread="even" data-tip="The same hours for every game">Even</button>
      <button type="button" data-spread="manual" data-tip="Type each game's hours yourself. The total adds itself up.">Manual</button>
    </div>
    <label class="inline-field" data-ref="cTotalField"><input type="number" min="0.1" step="1" inputmode="decimal" data-ref="cTotal" aria-label="Total hours"> h</label>
  </div>
  <h3 class="cat">Games</h3>
  <div class="find">
    <div class="search">
      <svg class="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.6-4.6"/></svg>
      <input type="search" placeholder="Search games" autocomplete="off" data-ref="search" aria-label="Search games"
        data-tip="Search all ${formatCount(catalogSize)} games Discord can detect. ↑ ↓ to pick, Enter to add.">
      <ul class="menu" data-ref="results" hidden></ul>
    </div>
    <div class="presets">
      <button class="btn" type="button" data-action="presets" data-ref="presetsBtn" aria-expanded="false" aria-controls="presets-menu"
        data-tip="Add the most played games of a vibe in one go">Presets<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      <div class="presets-menu" id="presets-menu" data-ref="presetsMenu" role="group" aria-label="Presets" hidden>
        <div class="preset-list" data-ref="vibes"></div>
        <div class="preset-foot">
          <label class="inline-field" data-tip="How many of the vibe's most played games Add puts in your list">Top <input type="number" min="1" step="1" inputmode="numeric" data-ref="cTop" aria-label="How many"></label>
          <button class="btn primary sm" type="button" data-action="add-vibe" data-ref="addVibe">Add</button>
        </div>
      </div>
    </div>
  </div>
  <div class="list-head"><span data-ref="cCount"></span><button class="link" type="button" data-action="clear" data-ref="clear" data-tip="Remove every game from your list">Clear</button></div>
  <ul class="list" data-ref="cList"></ul>
</section>

<details class="advanced" data-ref="advanced">
  <summary data-tip="Played-since date, import and export, script options and the two separate scripts">Advanced</summary>
  <div class="adv">
    <div class="adv-row"><span class="label" data-tip="${TIP.since}">Played since</span><input type="date" data-ref="trackStart" aria-label="Played since" data-tip="${TIP.since}">
      <button class="btn sm" type="button" data-action="use-window" data-ref="useWindow">Use all hours</button></div>
    <div class="adv-row"><span class="label">List</span>
      <button class="btn sm" type="button" data-action="example" data-ref="example" data-tip="Replace your list with the example list">Load example</button>
      <button class="btn sm" type="button" data-action="export" data-tip="Download your list and options as selection.json. The CLI reads it too.">Export</button>
      <label class="btn sm" data-tip="Load a selection.json from Export or the CLI. It replaces your list.">Import<input type="file" accept="application/json,.json" data-ref="importFile" hidden></label></div>
    <div class="divider"></div>
    <div class="opts">
      ${OPTIONS.map(optionRow).join("\n      ")}
    </div>
    <div class="divider"></div>
    ${[["variety", "Variety", TIP.variety], ["gameTime", "Game Time", TIP.gameTime]].map(([key, label, tip]) => `
    <div class="script-row"><div data-tip="${tip}"><b>${label}</b><code data-file="${key}"></code></div>
      <div class="actions"><button class="btn sm" type="button" data-copy="${key}">Copy</button><button class="btn sm" type="button" data-download="${key}">Download</button></div></div>`).join("")}
    <details class="peek" data-ref="previewBox"><summary data-tip="Read the main script before you run it">Preview</summary><textarea class="preview" readonly spellcheck="false" data-ref="preview" aria-label="Main script"></textarea></details>
  </div>
</details>

<ul class="notes" data-ref="notes"></ul>

<div class="dock">
  <div class="sum"><span data-tip="Games the script sends"><b data-ref="sumGames">0</b> games</span><span>·</span><span data-tip="Hours the script sends, in total"><b data-ref="sumHours">0</b>h</span>
    ${BADGE_KEYS.map(badge => `<span class="tier" data-ref="pill-${badge}" hidden><img alt="" width="16" height="16" draggable="false" hidden>${BADGES[badge].short}</span>`).join("")}</div>
  <div class="actions">
    <button class="btn" type="button" data-download="main">Download</button>
    <button class="btn primary" type="button" data-copy="main">Copy script</button>
  </div>
  <div class="toast" data-ref="toast" hidden></div>
</div>`;

function build(root, catalog, templates) {
    const state = loadState();
    const { byId, search: index } = catalogIndex(catalog.games);
    // Games Discord lists without any executable get a made-up "<name>.exe": untested for the badges (see TIP.untested).
    const untested = id => byId.get(id)?.noExe === true;
    let ranking = null;
    let scoreById = new Map();
    let minScore = 1;
    let latest = null;
    let cautions = 0; // Custom warnings that could cost a tier: they make Copy/Download ask twice
    // "safe" or "danger": zone.js switches it (the red DBU in the sidebar) and announces it with a zonechange event.
    let zone = document.body.dataset.zone === "danger" ? "danger" : "safe";

    root.innerHTML = markup(catalog.games.length);

    // Every element the code touches, looked up once.
    const ref = {};
    for (const el of root.querySelectorAll("[data-ref]")) ref[el.dataset.ref] = el;
    const tierButtons = Object.fromEntries(BADGE_KEYS.map(badge => [badge, [...root.querySelectorAll(`[data-tier="${badge}"]`)]]));
    const scriptButtons = [...root.querySelectorAll("[data-copy], [data-download]")];
    const fileLabels = [...root.querySelectorAll("[data-file]")];
    const vibeButtons = () => ref.vibes.querySelectorAll("[data-vibe]");

    const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {} };
    const setValue = (input, value) => { if (document.activeElement !== input) input.value = value; }; // never fight the typist
    // Played + sent, per badge.
    const total = (badge, sent) => BADGES[badge].add(state.have[BADGES[badge].have], sent);
    const totals = sent => Object.fromEntries(BADGE_KEYS.map(badge => [badge, total(badge, sent[badge])]));

    // ---------- ask twice ----------
    // Clear, replacing the list, and copying a Custom list with warnings take a second click within 4s.

    let armed = null;
    function disarm() {
        if (!armed) return;
        clearTimeout(armed.timer);
        armed.el.classList.remove("armed");
        armed.el.textContent = armed.text;
        armed.el.dataset.tip = armed.tip;
        armed = null;
    }
    function confirmed(el, label, tip) {
        if (armed?.el === el) { disarm(); return true; }
        disarm();
        armed = { el, text: el.textContent, tip: el.dataset.tip ?? "", timer: setTimeout(disarm, 4000) };
        el.classList.add("armed");
        el.textContent = label;
        el.dataset.tip = tip;
        return false;
    }

    // ---------- hours ----------

    let spreadError = null;
    function respread() {
        spreadError = null;
        const c = state.custom;
        if (c.spread === "manual" || !c.games.length) return;
        try {
            const scored = c.games.map(g => ({ ...g, score: scoreById.get(g.id) ?? minScore }));
            const out = assignHours(scored, { mode: c.spread === "weighted" ? "weighted" : "even", total: pos(c.total, 5000) });
            c.games.forEach((g, i) => { g.hours = out[i].hours; });
        } catch (error) {
            spreadError = error.message;
        }
    }

    let randomCache = null;
    function randomGames() {
        const { count, seed } = state.random;
        const key = `${count}:${seed}`;
        if (randomCache?.key !== key) randomCache = { key, games: pickRandom(catalog.games, { count: pos(count, 110), seed }) };
        return randomCache.games;
    }

    // ---------- Danger Zone: a free-form table ----------
    // Generate fills it from a random pick (every game, or every tested one); after that it's plain text to edit.

    let dangerText = null; // null until first generated
    try { dangerText = localStorage.getItem(TABLE_KEY); } catch (_) {}
    let dangerEdited = false; // typed into since the last Generate: Generate then asks twice
    let tableTimer = null;
    const saveTable = () => {
        clearTimeout(tableTimer);
        tableTimer = setTimeout(() => { try { localStorage.setItem(TABLE_KEY, dangerText ?? ""); } catch (_) {} }, 600);
    };

    const dangerPool = () => (state.danger.untested ? catalog.games : randomPool(catalog.games));
    const dangerCount = () => Math.min(Math.floor(pos(state.danger.count, Infinity)), dangerPool().length);
    const dangerHours = () => roundHours(Math.min(pos(state.danger.hours, 24), MAX_HOURS_EACH));
    const maxCountable = () => Math.floor(countableHours() * 10) / 10;

    function setTable(text, { edited = false } = {}) {
        dangerText = text;
        dangerEdited = edited;
        ref.dTable.value = text;
        saveTable();
        changed({ now: true });
        renderDanger();
    }

    function generateTable() {
        const { seed, untested } = state.danger;
        const hours = dangerHours();
        const games = pickRandom(catalog.games, { count: dangerCount(), seed, all: untested });
        setTable([TABLE_HEAD, ...games.map(g => [g.id, cleanCell(g.name), cleanCell(g.exe), hours].join("\t"))].join("\n") + "\n");
    }

    // Sets the hours column on every data line; keeps everything else as typed.
    function applyHours(hours) {
        state.danger.hours = hours;
        const lines = (dangerText ?? "").split("\n").map(line => {
            const cells = line.split("\t");
            return /^\s*\d+\s*$/.test(cells[0]) && cells.length >= 3 ? [...cells.slice(0, 3), hours, ...cells.slice(4)].join("\t") : line;
        });
        setTable(lines.join("\n"), { edited: dangerEdited });
    }

    let parsedCache = null;
    function parsedTable() {
        if (parsedCache?.text !== dangerText) parsedCache = { text: dangerText, ...parseTable(dangerText ?? "", id => byId.get(id)?.name) };
        return parsedCache;
    }

    function currentSelection() {
        if (state.mode === "random") {
            const picked = randomGames();
            const games = splitEvenly(picked.map(g => ({ id: g.id, name: g.name, hours: 1 })), pos(state.random.hours, 5000));
            return { version: 1, name: `Random ${games.length} games`, trackStart: state.trackStart, games };
        }
        return { version: 1, name: state.custom.name, trackStart: state.trackStart, games: state.custom.games };
    }

    // ---------- render ----------

    function renderMode() {
        const danger = zone === "danger";
        for (const b of root.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
        for (const p of root.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== (danger ? "danger" : state.mode);
        ref.have.hidden = danger;
        ref.modes.hidden = danger;
        ref.advanced.hidden = danger;
    }

    function renderDanger() {
        const d = state.danger;
        const poolSize = dangerPool().length;
        const countable = maxCountable();
        setValue(ref.dCount, dangerCount());
        setValue(ref.dHours, dangerHours());
        setValue(ref.dSeed, d.seed);
        ref.dUntested.checked = !!d.untested;
        ref.dOf.textContent = `of ${formatCount(poolSize)}`;
        ref.dAll.dataset.tip = `Generate all ${formatCount(poolSize)} ${d.untested ? "games Discord lists" : "games with a real Windows executable"}`;
        ref.dSince.dataset.tip = `${hrs(countable)}h: all the time since ${GAME_TIME_SINCE}, the day Game Time starts counting`;
        if (dangerText != null && ref.dTable.value !== dangerText && document.activeElement !== ref.dTable) ref.dTable.value = dangerText;
        for (const input of root.querySelectorAll("[data-dopt]")) {
            const value = input.dataset.dopt.split(".").reduce((o, k) => o?.[k], d.options);
            if (input.type === "checkbox") input.checked = !!value;
            else setValue(input, value);
        }
        setValue(ref.dTrack, state.trackStart ?? "");
        ref.facts.innerHTML = [
            `Game Time only counts time played on or after 8 December 2025: at most ${hrs(countable)}h for one game today.`,
            "Only the Discord desktop app counts, and only with “Use data to personalize my Discord experience” on."
        ].map(text => `<li>${esc(text)}</li>`).join("") +
            `<li class="source">Source: <a href="${HELP_URL}" target="_blank" rel="noopener noreferrer">Discord's help article on profile badges</a></li>`;
    }

    // What the table adds up to, and what a run of the main script takes.
    function renderBlast(summary, problems) {
        const o = state.danger.options;
        const n = summary.games;
        const requests = Math.ceil(n / o.batchSize);
        const varietyRequests = Math.ceil(n / o.variety.batchSize);
        const stats = [
            ["Games", formatCount(n)],
            ["Total hours", `${compact(summary.totalHours)}h`],
            ["Past Eternal (5,000h)", summary.totalHours > TIERS.hours ? `×${compact(Math.floor(summary.totalHours / TIERS.hours))}` : "—"],
            ["Untested games", formatCount(summary.untested)],
            ["Requests", formatCount(requests)],
            ["Events", formatCount(n * 3)],
            ["Delays alone", span(Math.max(0, requests - 1) * o.delayMs)],
            ["Variety script delays", span(Math.max(0, varietyRequests - 1) * o.variety.delayMs)],
            ["Script size", latest ? bytes(latest.main.text.length) : "—"]
        ];
        ref.blast.innerHTML = stats.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("");
        ref.dRows.textContent = `${plural(n, "row")} · ${compact(summary.totalHours)}h${problems ? ` · ${plural(problems, "problem")}` : ""}`;
    }

    // ---------- random: tier goals (the maths lives in core.mjs) ----------

    function syncGoal() {
        const r = state.random;
        r.goal = {
            variety: tierFor("variety", total("variety", Math.floor(pos(r.count, 1)))),
            time: tierFor("time", total("time", pos(r.hours, 0.1)))
        };
    }

    // "Already played" changed: re-work the amounts to send so Random stays on the picked tiers.
    function retarget() {
        const r = state.random, have = state.have;
        if (r.goal.variety >= 0) r.count = sendGames(fitTier("variety", r.goal.variety, have.games), have.games);
        const games = Math.floor(pos(r.count, 1));
        if (r.goal.time >= 0) r.hours = sendHours(fitTier("time", r.goal.time, have.hours, games), games, have.hours);
        else if (pos(r.hours) < minHours(games)) r.hours = minHours(games);
    }

    // A Variety tier button's hint; disabled when no number of new games lands on it.
    function varietyTierTip(i, have) {
        const tier = BADGE_TIERS.variety[i];
        const next = BADGE_TIERS.variety[i + 1];
        const n = sendGames(i, have);
        if (n == null) {
            return [true, have >= next.min
                ? `${tier.name}: ${tier.min}–${next.min - 1} games. You've already played ${formatCount(have)}, past it.`
                : `${tier.name}: ${tier.min}–${next.min - 1} games. You've played ${formatCount(have)}, so even one new game takes you past it.`];
        }
        const sum = have + n;
        return [false, `${tier.name}: ${tier.min}+ games. Sends ${plural(n, "new game")}` +
            `${have ? ` (${formatCount(have)} played + ${formatCount(n)} = ${formatCount(sum)})` : ""}, ${formatCount(sum - tier.min)} spare in case Discord skips one.`];
    }

    // A Time tier button's hint; disabled when the picked games can't land on it.
    function timeTierTip(i, games, have) {
        const tier = BADGE_TIERS.time[i];
        const next = BADGE_TIERS.time[i + 1];
        const h = sendHours(i, games, have);
        if (h == null) {
            return [true, have >= next.min
                ? `${tier.name}: under ${formatCount(next.min)}h. You've already played ${hrs(have)}h, past it.`
                : `${tier.name}: under ${formatCount(next.min)}h. ${plural(games, "new game")} need at least ${hrs(minHours(games))}h (0.1h each)` +
                  `${have ? ` on top of your ${hrs(have)}h` : ""}, which takes you past it. Pick fewer games first.`];
        }
        const sum = addHours(have, h);
        return [false, `${tier.name}: ${formatCount(tier.min)}+ hours. Sends ${hrs(h)}h` +
            `${have ? ` (${hrs(have)} played + ${hrs(h)} = ${hrs(sum)}h)` : ""}, ${hrs(sum - tier.min)}h spare in case Discord skips a game.`];
    }

    function renderPickers() {
        const r = state.random, have = state.have;
        const games = Math.floor(pos(r.count, 1));
        const sums = totals({ variety: games, time: pos(r.hours, 0.1) });
        for (const badge of BADGE_KEYS) {
            const { amount, fmt } = BADGES[badge];
            const tiers = BADGE_TIERS[badge];
            const at = tierFor(badge, sums[badge]);
            const name = ref[`name-${badge}`];
            name.textContent = at >= 0 ? tiers[at].name : "No badge";
            name.style.color = at >= 0 ? TIER_COLOR[tiers[at].key] : "";
            const already = have[BADGES[badge].have];
            const plus = ref[`plus-${badge}`];
            plus.hidden = !already;
            plus.textContent = `${fmt(already)} +`;
            plus.dataset.tip = `${amount(already)} already played, plus what you send: ${amount(sums[badge])} in all`;
            tierButtons[badge].forEach((b, i) => {
                b.setAttribute("aria-pressed", String(i === at));
                b.classList.toggle("above", i > at);
                [b.disabled, b.dataset.tip] = badge === "variety" ? varietyTierTip(i, have.games) : timeTierTip(i, games, have.hours);
            });
        }
    }

    function renderHave() {
        const have = state.have;
        setValue(ref["have-variety"], have.games || "");
        setValue(ref["have-time"], have.hours || "");
        for (const badge of BADGE_KEYS) {
            const tier = BADGE_TIERS[badge][tierFor(badge, have[BADGES[badge].have])];
            setTierIcon(ref[`haveIcon-${badge}`], badge, tier);
            ref[`haveField-${badge}`].dataset.tip = (badge === "variety"
                ? "Games Discord already counts for your Game Variety badge. New games add to it; one you've played before doesn't count again."
                : "Hours Discord already counts for your Game Time badge. The hours you send add to it.")
                + (tier ? ` You're ${tier.name} now.` : "");
        }
    }

    let listed = null; // the picked games the peek list shows
    function renderRandom() {
        const r = state.random;
        setValue(ref.rCount, r.count);
        setValue(ref.rHours, r.hours);
        renderPickers();
        const picked = randomGames();
        const each = picked.length ? Math.round((pos(r.hours, 5000) / picked.length) * 10) / 10 : 0;
        ref.rSummary.textContent = `${formatCount(picked.length)} games · ${formatHours(each)}h each`;
        if (picked !== listed) {
            ref.rList.innerHTML = picked.slice(0, 500).map(g => `<li data-tip-overflow>${esc(g.name)}</li>`).join("");
            listed = picked;
        }
        ref.max.classList.toggle("primary", Number(r.count) === ORIGINAL_MAX.games && Number(r.hours) === ORIGINAL_MAX.hours);
    }

    function renderVibes() {
        const counts = ranking ? countByVibe(ranking) : null;
        const tip = v => !counts ? v.blurb
            : v.key === "popular" ? `${v.blurb}: ${formatCount(counts.popular)} PC games, ranked by hours played`
            : `${v.blurb}. ${formatCount(counts[v.key])} of the most played PC games fit.`;
        ref.vibes.innerHTML = VIBES.map(v => `<button type="button" class="preset" data-vibe="${v.key}" aria-pressed="${state.custom.vibe === v.key}" data-tip="${esc(tip(v))}"><span>${esc(v.label)}</span>${counts ? `<small>${formatCount(counts[v.key])}</small>` : ""}</button>`).join("");
    }

    function renderVibe() {
        const c = state.custom;
        for (const b of vibeButtons()) b.setAttribute("aria-pressed", String(b.dataset.vibe === c.vibe));
        const vibe = VIBES.find(v => v.key === c.vibe) ?? VIBES[0];
        const n = formatCount(Math.floor(pos(c.top, 100)));
        ref.addVibe.dataset.tip = !ranking ? "Loading the most played ranking…"
            : `Add the ${n} most played ${vibe.key === "popular" ? "" : `“${vibe.label}” `}games that aren't in your list yet`;
    }

    // "Game Variety: Explorer, 22 games (12 played + 10 new). 8 more games for Adventurer." for what a list sends.
    function tierLine(badge, sent) {
        const { label, amount, fmt } = BADGES[badge];
        const tiers = BADGE_TIERS[badge];
        const already = state.have[BADGES[badge].have];
        const value = total(badge, sent);
        const at = tierFor(badge, value);
        const next = tiers[at + 1];
        const now = at >= 0 ? `${label}: ${tiers[at].name}` : `${label}: no badge yet`;
        const parts = already ? ` (${fmt(already)} played + ${fmt(sent)} new)` : "";
        const gap = next ? Math.round((next.min - value) * 10) / 10 : 0;
        const more = !next ? "The top tier."
            : badge === "variety" ? `${plural(gap, "more game")} for ${next.name}.` : `${hrs(gap)}h more for ${next.name}.`;
        return `${now}, ${amount(value)}${parts}. ${more}`;
    }

    function renderCustom() {
        const c = state.custom;
        setValue(ref.cTop, c.top);
        renderVibe();
        for (const b of ref.spread.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.spread === c.spread));
        const manual = c.spread === "manual";
        ref.cTotal.disabled = manual;
        setValue(ref.cTotal, manual ? sumHours(c.games) : c.total);
        ref.cTotalField.dataset.tip = manual
            ? "The sum of your hours. Pick Weighted or Even to set a total instead."
            : "Total hours to spread across your games";
        ref.cCount.textContent = `${formatCount(c.games.length)} games`;
        ref.cCount.dataset.tip = tierLine("variety", c.games.length);
        const setBy = `Set by ${c.spread === "even" ? "Even" : "Weighted"}. Pick Manual to type your own.`;
        ref.clear.hidden = !c.games.length;
        ref.cList.innerHTML = c.games.map((g, i) => `
<li><span class="name" data-tip-overflow>${esc(g.name ?? byId.get(g.id)?.name ?? g.id)}</span>
${manual ? `<input class="hrs" type="number" min="0.1" step="0.1" value="${esc(g.hours)}" data-hours="${i}" aria-label="Hours" data-tip="Hours for this game, at least 0.1">`
        : `<span class="hrs-val" data-tip="${setBy}">${formatHours(g.hours || 0)}h</span>`}
<button class="icon-btn" type="button" data-remove="${i}" aria-label="Remove" data-tip="Remove">×</button></li>`).join("");
    }

    const windowHours = () => {
        const since = state.trackStart ? hoursSince(state.trackStart) : null;
        return since > 0 ? Math.floor(since * 10) / 10 : null;
    };

    function renderUseWindowTip() {
        const hours = windowHours();
        ref.useWindow.dataset.tip = hours != null
            ? `Set the hours to all ${hrs(hours)}h since ${state.trackStart}`
            : "Set the hours to all the time since the played-since day. Pick a day first.";
    }

    function renderAdvanced() {
        ref.trackStart.value = state.trackStart ?? "";
        setValue(ref.dTrack, state.trackStart ?? "");
        renderUseWindowTip();
        for (const input of root.querySelectorAll("[data-opt]")) {
            const value = input.dataset.opt.split(".").reduce((o, k) => o?.[k], state.options);
            if (input.type === "checkbox") input.checked = !!value;
            else input.value = value;
        }
    }

    // Custom lists get extra care: warn where a skipped game could cost a tier, and flag untested games.
    // [{ text, info?, confirm }]: `info` adds an (i) hint; `confirm` makes Copy/Download ask twice.
    function customCautions(table, summary) {
        const out = [];
        const have = state.have;
        const values = totals({ variety: summary.games, time: summary.totalHours });
        for (const badge of BADGE_KEYS) {
            const tiers = BADGE_TIERS[badge];
            const at = tierFor(badge, values[badge]);
            if (at < 0 || values[badge] >= tierAim(badge, at)) continue;
            const below = at > 0 ? tiers[at - 1].name : "no badge";
            out.push({
                confirm: true,
                text: badge === "variety"
                    ? `${formatCount(values.variety)} games${have.games ? " in all" : ""} is only just ${tiers[at].name}. If Discord skips one, you get ${below}. Add ${tierAim("variety", at) - values.variety} more for some spare.`
                    : `${hrs(values.time)}h${have.hours ? " in all" : ""} is only just ${tiers[at].name}. If Discord skips a game, you could get ${below}. Aim for ${hrs(tierAim("time", at))}h in all.`
            });
        }
        const risky = table.filter(row => untested(row.id));
        if (risky.length) {
            const sure = { variety: values.variety - risky.length, time: addHours(values.time, -sumHours(risky)) };
            const drops = BADGE_KEYS
                .filter(badge => tierFor(badge, sure[badge]) < tierFor(badge, values[badge]))
                .map(badge => { const at = tierFor(badge, sure[badge]); return `${BADGES[badge].short} drops to ${at >= 0 ? BADGE_TIERS[badge][at].name : "no badge"}`; });
            out.push({
                confirm: drops.length > 0,
                info: TIP.untested,
                text: `${plural(risky.length, "game")} ${risky.length === 1 ? "is" : "are"} untested: Discord lists no Windows executable for ` +
                    `${listNames(risky.map(r => r.name))}.${drops.length ? ` If it doesn't count them, ${drops.join(" and ")}.` : ""}`
            });
        }
        return out;
    }

    function renderPills(summary) {
        const custom = state.mode === "custom" || zone === "danger";
        const sent = { variety: summary.games, time: summary.totalHours };
        const values = totals(sent);
        for (const badge of BADGE_KEYS) {
            const pill = ref[`pill-${badge}`];
            pill.hidden = !custom;
            if (!custom) continue;
            const tier = BADGE_TIERS[badge][tierFor(badge, values[badge])];
            setTierIcon(pill.firstElementChild, badge, tier);
            pill.classList.toggle("none", !tier);
            pill.style.setProperty("--tier", tier ? TIER_COLOR[tier.key] : "");
            pill.dataset.tip = tierLine(badge, sent[badge]);
        }
    }

    // The 50 KB+ preview only fills while it's open (and when it opens).
    const renderPreview = () => {
        for (const [box, area] of [[ref.previewBox, ref.preview], [ref.dPreviewBox, ref.dPreview]]) {
            if (box.open) area.value = latest ? latest.main.text : "";
        }
    };

    // Random and Custom: the selection, resolved against the catalog.
    function resolvedTable(notes, custom) {
        let resolved = null;
        try {
            resolved = resolveSelection(catalog.games, currentSelection());
        } catch (error) {
            notes.push({ level: "error", text: error.message });
        }
        if (custom && spreadError) notes.push({ level: "error", text: spreadError });
        if (resolved) {
            const name = e => e.name ?? e.id;
            if (resolved.missing.length) notes.push({ level: "error", text: `Not in Discord's catalog: ${resolved.missing.map(name).join(", ")}` });
            if (resolved.ambiguous.length) notes.push({ level: "error", text: `Ambiguous: ${resolved.ambiguous.map(name).join(", ")}` });
            if (resolved.invalid.length) notes.push({ level: "error", text: `Hours must be at least 0.1: ${resolved.invalid.map(name).join(", ")}` });
        }
        return resolved?.table ?? [];
    }

    // Danger Zone: the table as typed. Ids outside Discord's catalog are allowed.
    function dangerTable(notes) {
        const { rows, problems } = parsedTable();
        if (problems.length) {
            notes.push({ level: "error", text: `${plural(problems.length, "line")} in the table can't be used. See the list under the table.` });
        }
        ref.dProblems.innerHTML = problems.slice(0, 200).map(text => `<li>${esc(text)}</li>`).join("") +
            (problems.length > 200 ? `<li>and ${formatCount(problems.length - 200)} more</li>` : "");
        const unknown = rows.filter(row => !byId.has(row.id)).length;
        if (unknown) notes.push({ level: "info", text: `${plural(unknown, "id")} in the table ${unknown === 1 ? "isn't" : "aren't"} in Discord's catalog.` });
        return rows;
    }

    function renderOutput() {
        const notes = [];
        const danger = zone === "danger";
        const custom = !danger && state.mode === "custom";
        const table = danger ? dangerTable(notes) : resolvedTable(notes, custom);
        const check = validateTable(table, { trackStart: state.trackStart });
        if (table.length) {
            for (const text of check.errors.slice(0, 10)) notes.push({ level: "error", text });
            if (check.errors.length > 10) notes.push({ level: "error", text: `and ${formatCount(check.errors.length - 10)} more problems like these` });
        }
        // "since": a session reaching back before 8 December 2025 (Discord's start date for Game Time).
        for (const w of check.warnings) if (w.kind === "window" || w.kind === "since") notes.push({ level: "warn", text: w.text });

        const summary = summarize(table);
        if (!danger && table.length) notes.push(...pastTopTiers(summary));
        if (danger && table.length) notes.push(...dangerNotes(table));
        const care = custom && table.length ? customCautions(table, summary) : [];
        for (const { text, info } of care) notes.push({ level: "warn", text, info });
        cautions = care.filter(c => c.confirm).length;
        if (custom && table.length && state.have.games) {
            notes.push({ level: "info", text: "Game Variety only counts games you haven't played before. Any game here you've already played won't add to it, though its hours still count for Game Time." });
        }

        ref.sumGames.textContent = formatCount(summary.games);
        ref.sumHours.textContent = formatHours(summary.totalHours);
        renderPills(summary);
        ref.notes.innerHTML = notes.map(n => `<li class="${n.level}">${esc(n.text)}${n.info
            ? ` <button type="button" class="info-btn" data-tip="${esc(n.info)}" data-tip-click aria-label="Why?">${INFO_ICON}</button>` : ""}</li>`).join("");

        latest = null;
        if (table.length && check.ok && !notes.some(n => n.level === "error")) {
            latest = danger
                ? renderScripts(table, { trackStart: state.trackStart, options: state.danger.options, uncapped: true }, templates)
                : renderScripts(table, { trackStart: state.trackStart, options: state.options }, templates);
        }
        const blocked = !table.length ? "Add some games first" : "Fix the notes above first";
        for (const b of scriptButtons) {
            if (b === armed?.el) continue;
            const key = b.dataset.copy ?? b.dataset.download;
            b.disabled = !latest;
            b.dataset.tip = !latest ? blocked
                : b.dataset.copy ? (key === "main" ? `Copy ${FILE.main}. ${TIP.main}` : `Copy ${FILE[key]}`)
                : `Save ${FILE[key]}`;
        }
        for (const code of fileLabels) code.textContent = latest ? latest[code.dataset.file].file : "";
        renderPreview();
        if (danger) renderBlast({ ...summary, untested: table.filter(row => untested(row.id)).length }, parsedTable().problems.length);
    }

    // Past the spare above a top tier (110 games, 5,500h): more doesn't raise the badge.
    function pastTopTiers(summary) {
        const values = totals({ variety: summary.games, time: summary.totalHours });
        const out = [];
        if (values.variety > tierAim("variety", topTier("variety"))) {
            out.push({ level: "info", text: `${formatCount(values.variety)} games${state.have.games ? " in all" : ""} is past Game Variety's top tier ` +
                `(Universalist, ${TIERS.games} games). Games past it don't raise the badge.` });
        }
        if (values.time > tierAim("time", topTier("time"))) {
            out.push({ level: "info", text: `${hrs(values.time)}h${state.have.hours ? " in all" : ""} is past Game Time's top tier ` +
                `(Eternal, ${formatCount(TIERS.hours)}h). Hours past it don't raise the badge.` });
        }
        return out;
    }

    function dangerNotes(table) {
        const out = [];
        const risky = table.filter(row => untested(row.id));
        if (risky.length) {
            out.push({ level: "info", info: TIP.untested,
                text: `${formatCount(risky.length)} of these games are untested: Discord lists no Windows executable for them.` });
        }
        return out;
    }

    let outputTimer = null;
    function changed({ custom = false, random = false, now = false, wait = 120 } = {}) {
        disarm();
        if (state.mode === "custom" || custom) respread();
        save();
        if (custom) renderCustom();
        if (random) renderRandom();
        clearTimeout(outputTimer);
        outputTimer = setTimeout(renderOutput, now ? 0 : wait);
    }

    let toastTimer = null;
    function toast(text, ms = 3200) {
        ref.toast.textContent = text;
        ref.toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { ref.toast.hidden = true; }, ms);
    }

    // ---------- random: tiers ----------

    function pickTier(badge, i) {
        const r = state.random, have = state.have;
        if (badge === "variety") {
            const n = sendGames(i, have.games);
            if (n == null) return;
            r.count = n;
            r.goal.variety = i;
            // Keep Game Time on its tier: more games may need more hours (0.1h each).
            const want = r.goal.time >= 0 ? r.goal.time : tierFor("time", total("time", pos(r.hours, 0.1)));
            const onTier = tierFor("time", total("time", pos(r.hours))) === want && pos(r.hours) >= minHours(n);
            if (!onTier && want >= 0) {
                const j = fitTier("time", want, have.hours, n);
                r.hours = sendHours(j, n, have.hours);
                if (j !== want) toast(`Game Time moved up to ${BADGE_TIERS.time[j].name}: ${plural(n, "game")} need at least ${hrs(minHours(n))}h.`);
            } else if (pos(r.hours) < minHours(n)) {
                r.hours = minHours(n);
            }
        } else {
            const h = sendHours(i, Math.floor(pos(r.count, 1)), have.hours);
            if (h == null) return;
            r.hours = h;
            r.goal.time = i;
        }
        changed({ random: true, now: true });
    }

    // ---------- menus and expanders stay in view ----------
    // Menus float over everything (dock included) and open on whichever side has room; if neither side
    // fits them, they scroll inside themselves. Expanders scroll the page just enough to show what opened.

    const panel = root.closest(".panel");
    const dock = root.querySelector(".dock");
    const motion = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
    const titleBottom = () => document.querySelector(".titlebar")?.getBoundingClientRect().bottom ?? 0;

    function place(menu, anchor, { stretch = false, maxHeight = Infinity } = {}) {
        if (menu.hidden) return;
        const r = anchor.getBoundingClientRect();
        menu.style.visibility = r.bottom < titleBottom() || r.top > window.innerHeight ? "hidden" : ""; // anchor scrolled away
        const vw = document.documentElement.clientWidth;
        const top = titleBottom() + 8;
        const bottom = window.innerHeight - 8;
        Object.assign(menu.style, { position: "fixed", right: "auto", bottom: "auto" });
        if (stretch) Object.assign(menu.style, { left: `${r.left}px`, width: `${r.width}px` });
        else menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, vw - 8 - menu.offsetWidth))}px`;
        const height = Math.min(menu.scrollHeight + 2, maxHeight);
        const below = bottom - r.bottom - 4;
        const above = r.top - 4 - top;
        const up = height > below && above > below;
        const fit = Math.min(height, Math.max(120, up ? above : below));
        menu.style.maxHeight = `${fit}px`;
        menu.style.top = `${up ? r.top - 4 - fit : r.bottom + 4}px`;
    }

    const placePresets = () => place(ref.presetsMenu, ref.presetsBtn);
    const placeResults = () => place(ref.results, ref.search, { stretch: true, maxHeight: 320 });
    const placeTestResults = () => place(ref.tResults, ref.tSearch, { stretch: true, maxHeight: 280 });
    const placeMenus = () => {
        placePresets(); placeResults(); placeTestResults();
        place(ref.tZones, ref.tZone, { stretch: true, maxHeight: 280 });
    };
    window.addEventListener("scroll", event => {
        if (!(event.target instanceof Element && event.target.closest(".presets-menu, .menu"))) placeMenus();
    }, { capture: true, passive: true });
    window.addEventListener("resize", placeMenus, { passive: true });

    // Scroll just enough that an opened section shows between the title bar and the dock, summary kept on screen.
    function reveal(el) {
        const inPanel = getComputedStyle(panel).overflowY !== "visible";
        const scroller = inPanel ? panel : document.scrollingElement;
        const frame = inPanel ? panel.getBoundingClientRect() : { top: titleBottom(), bottom: window.innerHeight };
        const r = el.getBoundingClientRect();
        const over = r.bottom - (Math.min(frame.bottom, window.innerHeight) - dock.offsetHeight - 12);
        const room = r.top - (Math.max(frame.top, titleBottom()) + 12);
        const by = Math.min(over, room);
        if (over > 0 && by > 0) scroller.scrollBy({ top: by, behavior: motion() });
    }
    root.addEventListener("toggle", event => {
        if (!(event.target instanceof HTMLDetailsElement) || !event.target.open) return;
        if (event.target === ref.previewBox || event.target === ref.dPreviewBox) renderPreview();
        requestAnimationFrame(() => reveal(event.target));
    }, true);

    // ---------- custom: presets dropdown ----------

    function setPresets(open) {
        ref.presetsMenu.hidden = !open;
        ref.presetsBtn.setAttribute("aria-expanded", String(open));
        if (open) placePresets();
    }
    document.addEventListener("pointerdown", event => {
        if (!ref.presetsMenu.hidden && !event.target.closest?.(".presets")) setPresets(false);
    });
    root.addEventListener("keydown", event => {
        if (event.key === "Escape" && !ref.presetsMenu.hidden && event.target.closest?.(".presets")) {
            setPresets(false);
            ref.presetsBtn.focus();
        }
    });

    // ---------- custom: add games ----------

    function addGames(entries) {
        const have = new Set(state.custom.games.map(g => g.id));
        const fresh = entries.filter(g => !have.has(g.id)).map(g => ({ id: g.id, name: g.name, hours: 1.5, ...(g.exe ? { exe: g.exe } : {}) }));
        state.custom.games.push(...fresh);
        state.custom.name = null;
        changed({ custom: true, now: true });
        return fresh.length;
    }

    function setSpread(spread) {
        const c = state.custom;
        if (spread === c.spread) return;
        if (c.spread === "manual") {
            c.manual = Object.fromEntries(c.games.map(g => [g.id, g.hours])); // kept, so Manual can bring them back
        } else {
            c.total = pos(ref.cTotal.value, c.total);
        }
        c.spread = spread;
        if (spread === "manual" && c.manual) {
            let restored = 0;
            for (const g of c.games) if (pos(c.manual[g.id])) { g.hours = c.manual[g.id]; restored += 1; }
            if (restored) toast(`Brought back your manual hours for ${restored} game${restored === 1 ? "" : "s"}.`);
        }
        changed({ custom: true });
    }

    let activeResult = 0;
    function renderResults() {
        const q = ref.search.value;
        if (!q.trim()) { ref.results.hidden = true; return; }
        const have = new Set(state.custom.games.map(g => g.id));
        const results = searchCatalog(index, q, { limit: 12, boostIds: scoreById.size ? scoreById : null });
        activeResult = 0;
        ref.results.innerHTML = results.length
            ? results.map((g, i) => `<li data-add="${esc(g.id)}" class="${i === 0 ? "active" : ""}"><span>${esc(g.name)}</span>${have.has(g.id) ? `<span class="muted">Added</span>` : ""}</li>`).join("")
            : `<li class="none">No games found</li>`;
        ref.results.hidden = false;
        ref.results.scrollTop = 0;
        placeResults();
    }

    // ---------- Danger Zone test: first heartbeat ----------

    let testScript = null;

    function renderTestResults() {
        const q = ref.tSearch.value;
        if (!q.trim()) { ref.tResults.hidden = true; return; }
        const results = searchCatalog(index, q, { limit: 8, boostIds: scoreById.size ? scoreById : null });
        ref.tResults.innerHTML = results.length
            ? results.map((g, i) => `<li data-t-pick="${esc(g.id)}" class="${i === 0 ? "active" : ""}"><span>${esc(g.name)}</span>${untested(g.id) ? `<span class="muted">untested</span>` : ""}</li>`).join("")
            : `<li class="none">No games found</li>`;
        ref.tResults.hidden = false;
        ref.tResults.scrollTop = 0;
        placeTestResults();
    }

    const ZONES = Intl.supportedValuesOf?.("timeZone") ?? [];
    function renderZoneResults() {
        const q = ref.tZone.value.trim().toLowerCase().replace(/[\s_]+/g, " ");
        if (!q) { ref.tZones.hidden = true; return; }
        const hits = ZONES.filter(z => z.toLowerCase().replace(/_/g, " ").includes(q))
            .sort((a, b) => a.toLowerCase().replace(/_/g, " ").indexOf(q) - b.toLowerCase().replace(/_/g, " ").indexOf(q)).slice(0, 30);
        ref.tZones.innerHTML = hits.length
            ? hits.map((z, i) => `<li data-t-zone="${esc(z)}" class="${i === 0 ? "active" : ""}"><span>${esc(z.replace(/_/g, " "))}</span></li>`).join("")
            : `<li class="none">No time zones found</li>`;
        ref.tZones.hidden = false;
        ref.tZones.scrollTop = 0;
        place(ref.tZones, ref.tZone, { stretch: true, maxHeight: 280 });
    }

    function renderTest() {
        const t = state.dzTest;
        const clock = CLOCKS.find(c => c.key === t.clock) ?? CLOCKS[0];
        const shifted = clock.key !== "off";
        const system = clock.key === "system";
        const backdate = t.backdate !== false;
        ref.tBackdate.checked = backdate;
        for (const b of root.querySelectorAll("[data-t-clock]")) b.setAttribute("aria-pressed", String(b.dataset.tClock === clock.key));
        ref.tSearch.placeholder = t.game ? t.game.name : "Search games";
        setValue(ref.tFirst, t.first || "");
        setValue(ref.tHours, t.hours || "");
        setValue(ref.tZone, t.timeZone || "");
        ref.tZoneField.hidden = !shifted;
        const untilOk = backdate && !system;
        const untilNow = t.untilNow && untilOk;
        ref.tUntilNow.checked = untilNow;
        ref.tUntilNow.disabled = !untilOk;
        ref.tUntilField.classList.toggle("off", !untilOk);
        ref.tHours.disabled = untilNow;
        ref.tMethod.textContent = [backdate && BACKDATE_BLURB, shifted && clock.blurb,
            shifted && (backdate ? "With Backdate on, the page clock reads the session's end while it's sent." : "The page clock reads the first heartbeat while it's sent.")]
            .filter(Boolean).join(" ");

        const notes = [];
        const now = Date.now();
        const zone = shifted && t.timeZone ? t.timeZone : null;
        testScript = null;
        try {
            if (zone && !isTimeZone(zone)) {
                // Still typing: a hint, not an error, until the field is left.
                if (document.activeElement === ref.tZone) throw Object.assign(new Error("Pick a time zone from the list."), { level: "info" });
                throw new Error(`"${zone}" isn't a time zone. Pick one from the list, like America/New_York.`);
            }
            const firstMs = t.first ? zonedTimeToMs(t.first, zone) : NaN;
            if (Number.isFinite(firstMs) && !system) {
                if (firstMs >= now) throw new Error("The first heartbeat is in the future. Only the system clock can send a session that hasn't happened yet.");
                if (!untilNow && firstMs + toTenths(t.hours) * 360000 > now) throw new Error("The date plus the hours ends in the future. Pick fewer hours or an earlier date.");
            }
            testScript = renderFirstHeartbeat({
                game: t.game, firstMs, hours: t.hours, untilNow, backdate, clock: clock.key, timeZone: zone, dryRun: state.danger.options.dryRun
            }, templates);
            if (zone) notes.push({ level: "info", text: `First heartbeat: ${new Date(firstMs).toISOString().slice(0, 16).replace("T", " ")} UTC (${t.first.replace("T", " ")} in ${zone}).` });
            if (untested(t.game.id)) notes.push({ level: "warn", text: `${t.game.name} is untested: Discord lists no executables for it.` });
            if (firstMs < Date.UTC(2015, 4, 13)) notes.push({ level: "warn", text: "That's before Discord launched (May 2015)." });
            if (firstMs < Date.parse(`${GAME_TIME_SINCE}T00:00:00Z`)) {
                notes.push({ level: "warn", text: `Game Time only counts time played on or after ${GAME_TIME_SINCE}, so this session's hours likely won't count toward that badge.` });
            }
            const hours = untilNow ? (now - firstMs) / 3600000 : t.hours;
            if (hours > 5000) notes.push({ level: "warn", text: `One ${hrs(Math.floor(hours * 10) / 10)}h session is an obvious outlier.` });
            notes.push({ level: "info", text: "Every method sends the same timestamps. The clocks only change what your Discord client reads while it sends; the server still sees when the request really arrived." });
            if (system) {
                const at = backdate ? firstMs + toTenths(t.hours) * 360000 : firstMs;
                notes.push({ level: "info", text: `Set your computer's clock to about ${new Date(at).toLocaleString()} (within 12h), restart Discord, then paste. Far-off dates can break HTTPS.` });
            }
            if (state.danger.options.dryRun) notes.push({ level: "info", text: "Dry run is on (Script options): it builds the session but sends nothing." });
        } catch (error) {
            notes.unshift({ level: error.level ?? "error", text: error.message });
        }
        ref.tNotes.innerHTML = notes.map(n => `<li class="${n.level}">${esc(n.text)}</li>`).join("");
        for (const b of root.querySelectorAll("[data-t]")) {
            b.disabled = !testScript;
            b.dataset.tip = testScript ? (b.dataset.t === "copy" ? `Copy ${FIRST_HEARTBEAT.file}` : `Save ${FIRST_HEARTBEAT.file}`) : "Fix the notes above first";
        }
    }

    // ---------- events ----------

    root.addEventListener("click", async event => {
        if (event.target.closest(".info-btn")) return; // only shows its hint (tips.js); keeps an armed button armed
        const target = event.target.closest("button, [data-add], [data-t-pick], [data-t-zone]");
        if (armed && target !== armed.el) disarm();
        if (!event.target.closest(".dz-test .search")) { ref.tResults.hidden = true; ref.tZones.hidden = true; }
        if (!target || !root.contains(target)) {
            if (!event.target.closest(".search")) ref.results.hidden = true;
            return;
        }
        const d = target.dataset;
        if (d.mode) {
            setPresets(false);
            state.mode = d.mode;
            renderMode();
            changed({ now: true });
        } else if (d.tier) {
            pickTier(d.tier, Number(d.i));
        } else if (d.vibe) {
            state.custom.vibe = d.vibe;
            save();
            renderVibe();
        } else if (d.spread) {
            setSpread(d.spread);
        } else if (d.add) {
            const game = byId.get(d.add);
            if (game) addGames([game]);
            ref.search.value = "";
            ref.results.hidden = true;
        } else if (d.tPick) {
            const game = byId.get(d.tPick);
            if (game) state.dzTest.game = { id: game.id, name: game.name, exe: game.exe };
            ref.tSearch.value = "";
            ref.tResults.hidden = true;
            save();
            renderTest();
        } else if (d.tClock) {
            state.dzTest.clock = d.tClock;
            save();
            renderTest();
        } else if (d.tZone != null) {
            state.dzTest.timeZone = d.tZone;
            ref.tZone.value = d.tZone;
            ref.tZones.hidden = true;
            save();
            renderTest();
        } else if (d.t) {
            if (!testScript) return;
            if (d.t === "copy") {
                if (await copyText(testScript.text)) toast(`Copied. Paste it ${TIP.run}`, 9000);
            } else {
                download(testScript.file, testScript.text);
                toast(`Saved ${testScript.file}. Paste its contents ${TIP.run}`, 9000);
            }
        } else if (d.remove != null) {
            state.custom.games.splice(Number(d.remove), 1);
            changed({ custom: true });
        } else if (d.copy || d.download) {
            const key = d.copy ?? d.download;
            const out = latest?.[key];
            if (!out) return;
            if (zone === "safe" && state.mode === "custom" && cautions
                && !confirmed(target, d.copy ? "Copy anyway?" : "Save anyway?", "Check the warnings above first. Click again to go ahead.")) return;
            if (d.copy) {
                if (await copyText(out.text)) toast(`Copied. Paste it ${TIP.run}`, 9000);
            } else {
                download(out.file, out.text);
                toast(`Saved ${out.file}. Paste its contents ${TIP.run}`, 9000);
            }
        } else if (d.action) {
            await runAction(d.action, target);
        }
        if (!event.target.closest(".search")) ref.results.hidden = true;
    });

    async function runAction(action, button) {
        const c = state.custom;
        try {
            if (action === "max") {
                Object.assign(state.random, { count: ORIGINAL_MAX.games, hours: ORIGINAL_MAX.hours });
                syncGoal();
                changed({ random: true, now: true });
            } else if (action === "shuffle") {
                if (zone === "danger") {
                    if (dangerEdited && !confirmed(button, "Replace your edits?", "Click again to replace the edited table")) return;
                    state.danger.seed = newSeed();
                    generateTable();
                } else {
                    state.random.seed = newSeed();
                    changed({ random: true, now: true });
                }
            } else if (["d-generate", "d-all", "d-max"].includes(action)) {
                if (dangerEdited && !confirmed(button, "Replace your edits?", "Click again to replace the edited table")) return;
                const d = state.danger;
                if (action !== "d-generate") d.count = null;
                if (action === "d-max") Object.assign(d, { untested: true, hours: maxCountable() });
                generateTable();
            } else if (action === "d-apply" || action === "d-24" || action === "d-since") {
                applyHours(action === "d-24" ? 24 : action === "d-since" ? maxCountable() : dangerHours());
            } else if (action === "d-clear") {
                if (!confirmed(button, "Clear the table?", "Click again to empty the table")) return;
                setTable(TABLE_HEAD + "\n", { edited: true });
            } else if (action === "d-copy-table") {
                if (await copyText(dangerText ?? "")) toast("Copied the table (tab-separated).");
            } else if (action === "presets") {
                setPresets(ref.presetsMenu.hidden);
            } else if (action === "add-vibe") {
                if (!ranking) return;
                // Skip games already listed, and untested ones (the ranking leaves those out; this covers a newer live catalog).
                const listed = new Set(c.games.map(g => g.id));
                const skipIds = { has: id => listed.has(id) || untested(id) };
                const added = addGames(pickFromRanking(ranking, { vibe: c.vibe, count: Math.floor(pos(c.top, 100)), skipIds }));
                const vibe = VIBES.find(v => v.key === c.vibe) ?? VIBES[0];
                setPresets(false);
                toast(added ? `Added ${plural(added, "game")} from ${vibe.label}.` : `Every ${vibe.label} game is already in your list.`);
            } else if (action === "clear") {
                if (!confirmed(button, `Clear ${formatCount(c.games.length)} games?`, "Click again to remove every game from your list")) return;
                c.games = [];
                c.name = null;
                c.manual = null;
                changed({ custom: true, now: true });
            } else if (action === "use-window") {
                const hours = windowHours();
                if (hours == null) { ref.trackStart.focus(); return; }
                if (state.mode === "random") {
                    state.random.hours = hours;
                    syncGoal();
                    changed({ random: true, now: true });
                } else {
                    if (c.spread === "manual") c.games = scaleTo(c.games, hours);
                    else c.total = hours;
                    changed({ custom: true, now: true });
                }
            } else if (action === "example") {
                if (c.games.length && !confirmed(button, "Replace your list?", `Click again to replace your ${formatCount(c.games.length)} games with the example`)) return;
                applyImport(await examplePromise);
            } else if (action === "export") {
                const sel = currentSelection();
                const file = { version: 1, ...(sel.name ? { name: sel.name } : {}), trackStart: sel.trackStart, options: state.options, games: sel.games };
                download("selection.json", JSON.stringify(file, null, 2) + "\n", "application/json");
            }
        } catch (error) {
            toast(error.message);
        }
    }

    function applyImport(data) {
        const sel = normalizeSelection(data);
        state.mode = "custom";
        Object.assign(state.custom, { name: sel.name ?? null, games: sel.games, spread: "manual", manual: null });
        state.trackStart = sel.trackStart;
        if (data.options) state.options = normalizeOptions(data.options);
        renderMode();
        renderAdvanced();
        changed({ custom: true, now: true });
    }

    root.addEventListener("input", event => {
        const t = event.target;
        if (t === ref.tSearch) {
            renderTestResults();
            return;
        }
        if (t === ref.tZone) renderZoneResults();
        if ([ref.tFirst, ref.tHours, ref.tUntilNow, ref.tBackdate, ref.tZone].includes(t)) {
            Object.assign(state.dzTest, {
                first: ref.tFirst.value, hours: Number(ref.tHours.value), untilNow: ref.tUntilNow.checked,
                backdate: ref.tBackdate.checked, timeZone: ref.tZone.value.trim()
            });
            save();
            renderTest();
            return;
        }
        if (t === ref.rCount || t === ref.rHours) {
            state.random.count = Math.floor(pos(ref.rCount.value, state.random.count));
            state.random.hours = pos(ref.rHours.value, state.random.hours);
            syncGoal();
            changed({ random: true });
        } else if (t === ref["have-variety"] || t === ref["have-time"]) {
            state.have = normalizeHave({ games: ref["have-variety"].value, hours: ref["have-time"].value });
            retarget();
            renderHave();
            changed({ random: true, custom: state.mode === "custom", now: true });
        } else if (t === ref.cTop) {
            state.custom.top = Math.floor(pos(t.value, state.custom.top));
            renderVibe();
            save();
        } else if (t === ref.cTotal) {
            state.custom.total = pos(t.value, state.custom.total);
            respread();
            for (const [i, g] of state.custom.games.entries()) {
                const cell = ref.cList.children[i]?.querySelector(".hrs-val");
                if (cell) cell.textContent = `${formatHours(g.hours || 0)}h`;
            }
            changed();
        } else if (t.dataset.hours != null) {
            const entry = state.custom.games[Number(t.dataset.hours)];
            if (entry) entry.hours = Number(t.value);
            ref.cTotal.value = sumHours(state.custom.games);
            changed();
        } else if (t === ref.dTable) {
            dangerText = t.value;
            dangerEdited = true;
            saveTable();
            changed({ wait: 400 });
        } else if (t.dataset.gen != null || t === ref.dUntested) {
            const d = state.danger;
            if (t === ref.dCount) d.count = Math.floor(pos(t.value, d.count ?? Infinity));
            if (t === ref.dHours) d.hours = Math.min(pos(t.value, d.hours), MAX_HOURS_EACH);
            if (t === ref.dSeed && t.value !== "" && Number.isFinite(Number(t.value))) d.seed = Number(t.value) >>> 0;
            if (t === ref.dUntested) d.untested = t.checked;
            save();
            renderDanger();
        } else if (t.dataset.dopt) {
            const path = t.dataset.dopt.split(".");
            const draft = structuredClone(state.danger.options);
            (path.length > 1 ? draft[path[0]] : draft)[path.at(-1)] = t.type === "checkbox" ? t.checked : Number(t.value);
            state.danger.options = normalizeOptions(draft, { uncapped: true });
            changed();
        } else if (t === ref.search) {
            renderResults();
        } else if (t.dataset.opt) {
            const path = t.dataset.opt.split(".");
            const draft = structuredClone(state.options);
            (path.length > 1 ? draft[path[0]] : draft)[path.at(-1)] = t.type === "checkbox" ? t.checked : Number(t.value);
            state.options = normalizeOptions(draft);
            changed();
        }
    });

    root.addEventListener("change", async event => {
        const t = event.target;
        if (t === ref.trackStart) {
            state.trackStart = t.value || null;
            renderUseWindowTip();
            changed({ now: true });
        } else if (t === ref.importFile && t.files?.[0]) {
            try {
                applyImport(JSON.parse(await t.files[0].text()));
            } catch (error) {
                toast(`Couldn't import: ${error.message}`);
            }
            t.value = "";
        } else if (t === ref.rCount || t === ref.rHours) {
            renderRandom(); // show the stored number again if the field was left empty or invalid
        } else if (t === ref.dTrack) {
            state.trackStart = t.value || null;
            renderAdvanced();
            changed({ now: true });
        } else if (t === ref.tZone) {
            renderTest(); // left the field: a half-typed zone is an error now
        } else if (t.dataset.gen != null || t.dataset.dopt) {
            renderDanger();
            renderTest(); // Dry run applies to the test script too
        } else if (t === ref["have-variety"] || t === ref["have-time"]) {
            renderHave();
        } else if (t.dataset.opt) {
            renderAdvanced();
        }
    });

    root.addEventListener("keydown", event => {
        const t = event.target;
        if (event.key === "Enter" && t.dataset?.gen != null) {
            event.preventDefault();
            root.querySelector('[data-action="d-generate"]').click();
        }
    });
    let tabEscaped = false;
    ref.dTable.addEventListener("keydown", event => {
        if (event.key === "Escape") { tabEscaped = true; return; }
        if (event.key !== "Tab" || event.shiftKey || tabEscaped || event.ctrlKey || event.altKey || event.metaKey) { tabEscaped = false; return; }
        event.preventDefault();
        if (!document.execCommand?.("insertText", false, "\t")) ref.dTable.setRangeText("\t", ref.dTable.selectionStart, ref.dTable.selectionEnd, "end");
        ref.dTable.dispatchEvent(new Event("input", { bubbles: true }));
    });
    ref.dTable.addEventListener("blur", () => { tabEscaped = false; });

    // ↑ ↓ to move, Enter to pick, Esc to close: the same keys as the Custom search.
    function menuKeys(input, menu, selector) {
        input.addEventListener("keydown", event => {
            const items = menu.hidden ? [] : [...menu.querySelectorAll(selector)];
            const at = Math.max(0, items.findIndex(li => li.classList.contains("active")));
            if (event.key === "Escape") {
                menu.hidden = true;
            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
                event.preventDefault();
                const next = (at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
                items.forEach((li, i) => li.classList.toggle("active", i === next));
                items[next].scrollIntoView({ block: "nearest" });
            } else if (event.key === "Enter" && items[at]) {
                event.preventDefault();
                items[at].click();
            }
        });
    }
    menuKeys(ref.tSearch, ref.tResults, "[data-t-pick]");
    menuKeys(ref.tZone, ref.tZones, "[data-t-zone]");

    ref.search.addEventListener("keydown", event => {
        const items = [...ref.results.querySelectorAll("[data-add]")];
        if (event.key === "Escape") {
            ref.results.hidden = true;
        } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
            event.preventDefault();
            activeResult = (activeResult + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
            items.forEach((li, i) => li.classList.toggle("active", i === activeResult));
            items[activeResult].scrollIntoView({ block: "nearest" });
        } else if (event.key === "Enter" && items[activeResult]) {
            event.preventDefault();
            items[activeResult].click();
        }
    });

    examplePromise.then(data => {
        const games = data?.games ?? [];
        ref.example.dataset.tip = `Replace your list with an example: ${formatCount(games.length)} games, ${hrs(sumHours(games))}h`;
    }, () => {});

    rankingPromise.then(data => {
        ranking = data;
        scoreById = new Map(ranking.games.map(g => [g.id, g.score]));
        minScore = Math.min(...ranking.games.map(g => g.score)) || 1;
        renderVibes();
        renderCustom();
        changed({ custom: state.mode === "custom" });
    }, () => {});

    if (!isTier("variety", state.random.goal?.variety) || !isTier("time", state.random.goal?.time)) syncGoal();
    renderHave();
    renderVibes();
    renderMode();
    renderRandom();
    respread();
    renderCustom();
    renderAdvanced();
    renderDanger();
    renderTest();
    if (zone === "danger" && dangerText == null) generateTable();
    renderOutput();

    document.addEventListener("zonechange", event => {
        zone = event.detail?.zone === "danger" ? "danger" : "safe";
        disarm();
        setPresets(false);
        ref.results.hidden = true;
        ref.tResults.hidden = true;
        ref.tZones.hidden = true;
        renderMode();
        if (zone === "danger" && dangerText == null) generateTable();
        else if (zone === "danger") renderDanger();
        changed({ now: true });
    });
}
