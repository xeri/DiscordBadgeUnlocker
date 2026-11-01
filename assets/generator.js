// The generator UI: Random or Custom, then Advanced. Loaded lazily (preloaded on idle) by app.js.
// All script text comes from the shared skill code, so the page and the CLI produce identical files.

import {
    BADGE_TIERS, ORIGINAL_MAX, VIBES, assignHours, buildSearchIndex, countByVibe, formatCount, formatHours, hoursSince,
    normalizeSelection, parseRanking, pickFromRanking, pickRandom, resolveSelection, scaleTo, searchCatalog, slugExe,
    splitEvenly, summarize, tierAim, tierFor, toTenths, validateTable
} from "../skills/discord-badge-unlocker/scripts/core.mjs";
import { DEFAULT_OPTIONS, OUTPUTS, loadTemplates, normalizeOptions, renderScripts } from "../skills/discord-badge-unlocker/scripts/templates.mjs";

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
const pos = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
const num0 = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const hrs = h => formatHours(h).replace(/\.0$/, ""); // "1,000", not "1,000.0"
const listNames = (names, max = 3) => names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;

// Hover hints (assets/tips.js reads data-tip). Short ones live inline in the markup below.
const TIP = {
    since: "Caps the hours at the time since this day (00:00 UTC). The scripts warn if a session would start before it. Leave empty to skip.",
    variety: "The original-style engine. While it claims, it also shows each game as your activity. Run only one of the three scripts.",
    gameTime: "The main script's engine under the original window.__gameTimePresence.boost() name. Run only one of the three scripts.",
    main: "Both badges in one run. Paste it in Discord's console (Ctrl+Shift+I)."
};
const FILE = Object.fromEntries(OUTPUTS.map(o => [o.key, o.file]));

// ---------- badge tiers ----------

const BADGES = {
    variety: { label: "Game Variety", short: "Variety", amount: n => `${formatCount(n)} game${n === 1 ? "" : "s"}` },
    time: { label: "Game Time", short: "Time", amount: n => `${hrs(n)}h` }
};
// Each tier's colour, taken from its icon and lightened where needed to read on the dark panel.
const TIER_COLOR = {
    sampler: "#9abbca", dabbler: "#8dbc82", enthusiast: "#58ce6b", ranger: "#39d6d6", explorer: "#4cc6ff",
    adventurer: "#77a0ff", voyager: "#a98bff", maverick: "#ff73ea", polymath: "#ff6b88", universalist: "#ffba54",
    casual: "#9abbca", recreational: "#8dbc82", dedicated: "#58ce6b", committed: "#39d7d7", serious: "#39caff",
    devoted: "#5aa2ff", seasoned: "#a98bff", ironclad: "#ff73ea", unshakeable: "#ff6b88", eternal: "#ffae03"
};
const tierIcon = (badge, tier) => new URL(`badges/${badge}-${tier.key}.svg`, import.meta.url).href;
const TOP = { variety: BADGE_TIERS.variety.length - 1, time: BADGE_TIERS.time.length - 1 };
const minHours = games => Math.ceil(games) / 10; // every game needs at least 0.1h

const isTier = (badge, i) => Number.isInteger(i) && i >= -1 && i <= TOP[badge];

const DEFAULT_STATE = () => ({
    mode: "random",
    have: { games: 0, hours: 0 }, // what Discord already counts; everything sent adds to it
    // goal: the tiers picked in Random, kept while "Already played" changes so the sent amounts follow
    random: { count: tierAim("variety", TOP.variety), hours: tierAim("time", TOP.time), seed: newSeed(), goal: null },
    custom: { name: null, vibe: "popular", top: 100, total: tierAim("time", TOP.time), spread: "weighted", games: [], manual: null },
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
            state.have = { games: Math.floor(num0(saved.have?.games)), hours: toTenths(num0(saved.have?.hours)) / 10 };
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

function build(root, catalog, templates) {
    const state = loadState();
    const index = buildSearchIndex(catalog.games);
    const byId = new Map(catalog.games.map(game => [game.id, game]));
    // Games Discord lists without a Windows executable get a made-up "<name>.exe"; the original Variety script skipped them.
    const noExe = id => { const g = byId.get(id); return !!g && g.exe === slugExe(g.name); };
    let ranking = null;
    let scoreById = new Map();
    let minScore = 1;
    let latest = null;
    let cautions = 0; // Custom warnings that make Copy/Download ask twice

    // Random: one row of tier icons per badge, plus the exact number next to the tier's name.
    const picker = (badge, ref, unit, attrs, tip) => `
  <div class="badge-pick">
    <div class="badge-head">
      <span class="cat">${BADGES[badge].label}</span>
      <span class="badge-now"><b class="tier-name" data-ref="name-${badge}"></b>
        <span class="sent"><span class="have-plus" data-ref="plus-${badge}" hidden></span>
          <label class="mini-field" data-tip="${tip}"><input type="number" ${attrs} data-ref="${ref}" aria-label="${BADGES[badge].label}: new ${unit}"> ${unit}</label></span></span>
    </div>
    <div class="tier-row" role="group" aria-label="${BADGES[badge].label} tier">
      ${BADGE_TIERS[badge].map((tier, i) => `<button type="button" class="tier-btn" data-tier="${badge}" data-i="${i}" aria-pressed="false" aria-label="${tier.name}" style="--tier:${TIER_COLOR[tier.key]}"><img src="${tierIcon(badge, tier)}" alt="" width="32" height="32" draggable="false"></button>`).join("")}
    </div>
  </div>`;

    const D = DEFAULT_OPTIONS;
    const ms = n => `${formatCount(n)}ms`;
    root.innerHTML = `
<section class="have" aria-label="Already played">
  <span class="cat" data-tip="What Discord already counts for your badges. Everything you send adds to it.">Already played</span>
  <label class="have-field" data-ref="haveGamesField"><img data-ref="haveGamesIcon" alt="" width="20" height="20" draggable="false" hidden><input type="number" min="0" step="1" inputmode="numeric" placeholder="0" data-ref="haveGames" aria-label="Games already played"> games</label>
  <label class="have-field" data-ref="haveHoursField"><img data-ref="haveHoursIcon" alt="" width="20" height="20" draggable="false" hidden><input type="number" min="0" step="0.1" inputmode="decimal" placeholder="0" data-ref="haveHours" aria-label="Hours already played"> h</label>
</section>

<div class="seg big" role="group" aria-label="Mode">
  <button type="button" data-mode="random" data-tip="Pick the badge tiers you want. Random games from Discord's catalog get you there, like the original scripts.">Random</button>
  <button type="button" data-mode="custom" data-tip="Choose the games yourself: the top games of a vibe, or search. Then spread the hours.">Custom</button>
</div>

<section class="card" data-pane="random">
  ${picker("variety", "rCount", "games", `min="1" step="1" inputmode="numeric"`, "Or type an exact number of random games")}
  <div class="divider"></div>
  ${picker("time", "rHours", "h", `min="0.1" step="1" inputmode="decimal"`, "Or type exact hours, split evenly across the games")}
  <div class="row">
    <button class="btn" type="button" data-action="max" data-tip="The original script's defaults: ${ORIGINAL_MAX.games} games and ${formatCount(ORIGINAL_MAX.hours)}h">Max</button>
    <button class="btn" type="button" data-action="shuffle" data-tip="Pick a different random set of games">Shuffle</button>
  </div>
  <details class="peek"><summary data-ref="rSummary" data-tip="See which games this pick sends"></summary><ol class="peek-list" data-ref="rList"></ol></details>
</section>

<section class="card" data-pane="custom">
  <h3 class="cat">Hours</h3>
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
        data-tip="Search all ${formatCount(catalog.games.length)} games Discord can detect. ↑ ↓ to pick, Enter to add.">
      <ul class="menu" data-ref="results" hidden></ul>
    </div>
    <div class="presets">
      <button class="btn" type="button" data-action="presets" data-ref="presetsBtn" aria-expanded="false" aria-controls="presets-menu"
        data-tip="Add the most played games of a vibe in one go">Presets<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      <div class="presets-menu" id="presets-menu" data-ref="presetsMenu" role="group" aria-label="Presets" hidden>
        <div class="preset-list" data-ref="vibes"></div>
        <div class="preset-foot">
          <label class="inline-field" data-tip="How many of the vibe's most played games Add puts in your list">Top <input type="number" min="1" step="1" inputmode="numeric" data-ref="cTop" aria-label="How many"></label>
          <button class="btn primary sm" type="button" data-action="add-vibe">Add</button>
        </div>
      </div>
    </div>
  </div>
  <div class="list-head"><span data-ref="cCount"></span><button class="link" type="button" data-action="clear" data-tip="Remove every game from your list">Clear</button></div>
  <ul class="list" data-ref="cList"></ul>
</section>

<details class="advanced">
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
      <label class="opt" data-tip="Build every event but send nothing, for a safe test run">Dry run<span class="switch"><input type="checkbox" data-opt="dryRun"><span></span></span></label>
      <label class="opt" data-tip="Variety script only: keep showing games as your activity after the claim finishes, until stop()">Keep rotating (Variety)<span class="switch"><input type="checkbox" data-opt="variety.keepRotating"><span></span></span></label>
      <label class="opt" data-tip="Games per request in the main and Game Time scripts (default ${D.batchSize})">Batch size<input type="number" min="1" max="100" data-opt="batchSize"></label>
      <label class="opt" data-tip="Wait between requests in the main and Game Time scripts (default ${ms(D.delayMs)})">Delay (ms)<input type="number" min="0" max="60000" data-opt="delayMs"></label>
      <label class="opt" data-tip="Games per request in the Variety script (default ${D.variety.batchSize})">Variety batch size<input type="number" min="1" max="50" data-opt="variety.batchSize"></label>
      <label class="opt" data-tip="Wait between requests in the Variety script (default ${ms(D.variety.delayMs)})">Variety delay (ms)<input type="number" min="0" max="60000" data-opt="variety.delayMs"></label>
      <label class="opt" data-tip="How long the Variety script shows each game as your activity (default ${D.variety.rotateMinutes} min)">Minutes per game<input type="number" min="1" max="1440" data-opt="variety.rotateMinutes"></label>
    </div>
    <div class="divider"></div>
    ${[["variety", "Variety", TIP.variety], ["gameTime", "Game Time", TIP.gameTime]].map(([key, label, tip]) => `
    <div class="script-row"><div data-tip="${tip}"><b>${label}</b><code data-file="${key}"></code></div>
      <div class="actions"><button class="btn sm" type="button" data-copy="${key}">Copy</button><button class="btn sm" type="button" data-download="${key}">Download</button></div></div>`).join("")}
    <details class="peek"><summary data-tip="Read the main script before you run it">Preview</summary><textarea class="preview" readonly spellcheck="false" data-ref="preview" aria-label="Main script"></textarea></details>
  </div>
</details>

<ul class="notes" data-ref="notes"></ul>

<div class="dock">
  <div class="sum"><span data-tip="Games the script sends"><b data-ref="sumGames">0</b> games</span><span>·</span><span data-tip="Hours the script sends, in total"><b data-ref="sumHours">0</b>h</span>
    ${["variety", "time"].map(badge => `<span class="tier" data-ref="pill-${badge}" hidden><img alt="" width="16" height="16" draggable="false" hidden>${BADGES[badge].short}</span>`).join("")}</div>
  <div class="actions">
    <button class="btn" type="button" data-download="main">Download</button>
    <button class="btn primary" type="button" data-copy="main">Copy script</button>
  </div>
  <div class="toast" data-ref="toast" hidden></div>
</div>`;

    const $ = name => root.querySelector(`[data-ref="${name}"]`);
    const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {} };
    const setValue = (input, value) => { if (document.activeElement !== input) input.value = value; }; // never fight the typist

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
        for (const b of root.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
        for (const p of root.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== state.mode;
    }

    // ---------- tier maths: already played + sent ----------
    // Variety counts different games, so new games add to the ones already played. Time adds up hours.
    // The script always sends at least one game with at least 0.1h, so some tiers can no longer be hit:
    // with 19 games played, any new game makes 20 (Explorer), so Ranger is out of reach.

    const played = () => ({ games: Math.floor(num0(state.have.games)), hours: toTenths(num0(state.have.hours)) / 10 });
    const addHours = (a, b) => (toTenths(a) + toTenths(b)) / 10;
    const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;

    // New games to send so played + new lands on Variety tier i (aiming ~10% over its minimum); null if it can't.
    function sendGames(i, have) {
        const most = (BADGE_TIERS.variety[i + 1]?.min ?? Infinity) - 1 - have; // most new games that stay on tier i
        return most < 1 ? null : Math.min(most, Math.max(1, tierAim("variety", i) - have));
    }

    // Hours to send with `games` new games so played + sent lands on Time tier i; null if it can't.
    function sendHours(i, games, have) {
        const tiers = BADGE_TIERS.time;
        const p = toTenths(have);
        const next = tiers[i + 1] ? tiers[i + 1].min * 10 : Infinity;
        const least = Math.max(games, tiers[i].min * 10 - p); // in tenths: every game needs 0.1h
        if (p + least >= next) return null;
        return Math.min(Math.max(tierAim("time", i) * 10 - p, least), next - 1 - p) / 10;
    }

    // The picked tier, or the next one up that can still be hit.
    const fitVariety = (i, have) => { while (i < TOP.variety && sendGames(i, have) == null) i += 1; return i; };
    const fitTime = (i, games, have) => { while (i < TOP.time && sendHours(i, games, have) == null) i += 1; return i; };

    function syncGoal() {
        const r = state.random, have = played();
        r.goal = {
            variety: tierFor("variety", have.games + Math.floor(pos(r.count, 1))),
            time: tierFor("time", addHours(have.hours, pos(r.hours, 0.1)))
        };
    }

    // "Already played" changed: re-work the amounts to send so Random stays on the picked tiers.
    function retarget() {
        const r = state.random, have = played();
        if (r.goal.variety >= 0) r.count = sendGames(fitVariety(r.goal.variety, have.games), have.games);
        const games = Math.floor(pos(r.count, 1));
        if (r.goal.time >= 0) r.hours = sendHours(fitTime(r.goal.time, games, have.hours), games, have.hours);
        else if (pos(r.hours, 0) < minHours(games)) r.hours = minHours(games);
    }

    function renderPickers() {
        const r = state.random, have = played();
        const games = Math.floor(pos(r.count, 1));
        const sent = { variety: games, time: pos(r.hours, 0.1) };
        const totals = { variety: have.games + games, time: addHours(have.hours, sent.time) };
        for (const badge of ["variety", "time"]) {
            const tiers = BADGE_TIERS[badge];
            const at = tierFor(badge, totals[badge]);
            const name = $(`name-${badge}`);
            name.textContent = at >= 0 ? tiers[at].name : "No badge";
            name.style.color = at >= 0 ? TIER_COLOR[tiers[at].key] : "";
            const already = have[badge === "variety" ? "games" : "hours"];
            const plus = $(`plus-${badge}`);
            plus.hidden = !already;
            plus.textContent = `${badge === "variety" ? formatCount(already) : hrs(already)} +`;
            plus.dataset.tip = `${BADGES[badge].amount(already)} already played, plus what you send: ${BADGES[badge].amount(totals[badge])} in all`;
            for (const b of root.querySelectorAll(`[data-tier="${badge}"]`)) {
                const i = Number(b.dataset.i);
                const tier = tiers[i];
                const next = tiers[i + 1];
                b.setAttribute("aria-pressed", String(i === at));
                b.classList.toggle("above", i > at);
                if (badge === "variety") {
                    const n = sendGames(i, have.games);
                    b.disabled = n == null;
                    if (n == null) {
                        b.dataset.tip = have.games >= next.min
                            ? `${tier.name}: ${tier.min}–${next.min - 1} games. You've already played ${formatCount(have.games)}, past it.`
                            : `${tier.name}: ${tier.min}–${next.min - 1} games. You've played ${formatCount(have.games)}, so even one new game takes you past it.`;
                    } else {
                        const total = have.games + n;
                        b.dataset.tip = `${tier.name}: ${tier.min}+ games. Sends ${plural(n, "new game")}` +
                            `${have.games ? ` (${formatCount(have.games)} played + ${formatCount(n)} = ${formatCount(total)})` : ""}, ${formatCount(total - tier.min)} spare in case Discord skips one.`;
                    }
                } else {
                    const h = sendHours(i, games, have.hours);
                    b.disabled = h == null;
                    if (h == null) {
                        b.dataset.tip = have.hours >= next.min
                            ? `${tier.name}: under ${formatCount(next.min)}h. You've already played ${hrs(have.hours)}h, past it.`
                            : `${tier.name}: under ${formatCount(next.min)}h. ${plural(games, "new game")} need at least ${hrs(minHours(games))}h (0.1h each)` +
                              `${have.hours ? ` on top of your ${hrs(have.hours)}h` : ""}, which takes you past it. Pick fewer games first.`;
                    } else {
                        const total = addHours(have.hours, h);
                        b.dataset.tip = `${tier.name}: ${formatCount(tier.min)}+ hours. Sends ${hrs(h)}h` +
                            `${have.hours ? ` (${hrs(have.hours)} played + ${hrs(h)} = ${hrs(total)}h)` : ""}, ${hrs(total - tier.min)}h spare in case Discord skips a game.`;
                    }
                }
            }
        }
    }

    function renderHave() {
        const have = played();
        setValue($("haveGames"), have.games || "");
        setValue($("haveHours"), have.hours || "");
        for (const [badge, key, ref] of [["variety", "games", "Games"], ["time", "hours", "Hours"]]) {
            const at = tierFor(badge, have[key]);
            const tier = BADGE_TIERS[badge][at];
            const img = $(`have${ref}Icon`);
            img.hidden = !tier;
            if (tier && img.dataset.key !== tier.key) { img.src = tierIcon(badge, tier); img.dataset.key = tier.key; }
            $(`have${ref}Field`).dataset.tip = (badge === "variety"
                ? "Games Discord already counts for your Game Variety badge. New games add to it; one you've played before doesn't count again."
                : "Hours Discord already counts for your Game Time badge. The hours you send add to it.")
                + (tier ? ` You're ${tier.name} now.` : "");
        }
    }

    function renderRandom() {
        const r = state.random;
        setValue($("rCount"), r.count);
        setValue($("rHours"), r.hours);
        renderPickers();
        const picked = randomGames();
        const each = picked.length ? Math.round((pos(r.hours, 5000) / picked.length) * 10) / 10 : 0;
        $("rSummary").textContent = `${formatCount(picked.length)} games · ${formatHours(each)}h each`;
        $("rList").innerHTML = picked.slice(0, 500).map(g => `<li data-tip-overflow>${esc(g.name)}</li>`).join("");
        root.querySelector('[data-action="max"]').classList.toggle("primary",
            Number(r.count) === ORIGINAL_MAX.games && Number(r.hours) === ORIGINAL_MAX.hours);
    }

    function renderVibes() {
        const counts = ranking ? countByVibe(ranking) : null;
        const tip = v => !counts ? v.blurb
            : v.key === "popular" ? `${v.blurb}: ${formatCount(counts.popular)} PC games, ranked by hours played`
            : `${v.blurb}. ${formatCount(counts[v.key])} of the most played PC games fit.`;
        $("vibes").innerHTML = VIBES.map(v => `<button type="button" class="preset" data-vibe="${v.key}" aria-pressed="${state.custom.vibe === v.key}" data-tip="${esc(tip(v))}"><span>${esc(v.label)}</span>${counts ? `<small>${formatCount(counts[v.key])}</small>` : ""}</button>`).join("");
    }

    function renderAddTip() {
        const c = state.custom;
        const vibe = VIBES.find(v => v.key === c.vibe) ?? VIBES[0];
        const n = formatCount(Math.floor(pos(c.top, 100)));
        root.querySelector('[data-action="add-vibe"]').dataset.tip = !ranking ? "Loading the most played ranking…"
            : `Add the ${n} most played ${vibe.key === "popular" ? "" : `“${vibe.label}” `}games that aren't in your list yet`;
    }

    // "Game Variety: Explorer, 22 games (12 played + 10 new). 8 more games for Adventurer." for what a list sends.
    function tierLine(badge, sent) {
        const tiers = BADGE_TIERS[badge];
        const { amount } = BADGES[badge];
        const already = played()[badge === "variety" ? "games" : "hours"];
        const value = badge === "variety" ? already + sent : addHours(already, sent);
        const at = tierFor(badge, value);
        const next = tiers[at + 1];
        const now = at >= 0 ? `${BADGES[badge].label}: ${tiers[at].name}` : `${BADGES[badge].label}: no badge yet`;
        const parts = already ? ` (${badge === "variety" ? formatCount(already) : hrs(already)} played + ${badge === "variety" ? formatCount(sent) : hrs(sent)} new)` : "";
        const gap = next ? Math.round((next.min - value) * 10) / 10 : 0;
        const more = !next ? "The top tier."
            : badge === "variety" ? `${plural(gap, "more game")} for ${next.name}.` : `${hrs(gap)}h more for ${next.name}.`;
        return `${now}, ${amount(value)}${parts}. ${more}`;
    }

    function renderCustom() {
        const c = state.custom;
        setValue($("cTop"), c.top);
        for (const b of root.querySelectorAll("[data-vibe]")) b.setAttribute("aria-pressed", String(b.dataset.vibe === c.vibe));
        for (const b of $("spread").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.spread === c.spread));
        const manual = c.spread === "manual";
        const sum = c.games.reduce((t, g) => t + toTenths(g.hours || 0), 0) / 10;
        $("cTotal").disabled = manual;
        setValue($("cTotal"), manual ? sum : c.total);
        $("cTotalField").dataset.tip = manual
            ? "The sum of your hours. Pick Weighted or Even to set a total instead."
            : "Total hours to spread across your games";
        $("cCount").textContent = `${formatCount(c.games.length)} games`;
        $("cCount").dataset.tip = tierLine("variety", c.games.length);
        renderAddTip();
        const setBy = `Set by ${c.spread === "even" ? "Even" : "Weighted"}. Pick Manual to type your own.`;
        root.querySelector('[data-action="clear"]').hidden = !c.games.length;
        $("cList").innerHTML = c.games.map((g, i) => `
<li><span class="name" data-tip-overflow>${esc(g.name ?? byId.get(g.id)?.name ?? g.id)}</span>
${manual ? `<input class="hrs" type="number" min="0.1" step="0.1" value="${esc(g.hours)}" data-hours="${i}" aria-label="Hours" data-tip="Hours for this game, at least 0.1">`
        : `<span class="hrs-val" data-tip="${setBy}">${formatHours(g.hours || 0)}h</span>`}
<button class="icon-btn" type="button" data-remove="${i}" aria-label="Remove" data-tip="Remove">×</button></li>`).join("");
    }

    function renderUseWindowTip() {
        const since = state.trackStart ? hoursSince(state.trackStart) : null;
        $("useWindow").dataset.tip = since > 0
            ? `Set the hours to all ${hrs(Math.floor(since * 10) / 10)}h since ${state.trackStart}`
            : "Set the hours to all the time since the played-since day. Pick a day first.";
    }

    function renderAdvanced() {
        $("trackStart").value = state.trackStart ?? "";
        renderUseWindowTip();
        for (const input of root.querySelectorAll("[data-opt]")) {
            const value = input.dataset.opt.split(".").reduce((o, k) => o?.[k], state.options);
            if (input.type === "checkbox") input.checked = !!value;
            else input.value = value;
        }
    }

    // Custom lists get extra care: warn where a skipped game or a missing executable could cost a tier.
    function customCautions(table, summary) {
        const out = [];
        const have = played();
        const values = { variety: have.games + summary.games, time: addHours(have.hours, summary.totalHours) };
        for (const badge of ["variety", "time"]) {
            const tiers = BADGE_TIERS[badge];
            const at = tierFor(badge, values[badge]);
            if (at < 0 || values[badge] >= tierAim(badge, at)) continue;
            const below = at > 0 ? tiers[at - 1].name : "no badge";
            out.push(badge === "variety"
                ? `${formatCount(values.variety)} games${have.games ? " in all" : ""} is only just ${tiers[at].name}. If Discord skips one, you get ${below}. Add ${tierAim("variety", at) - values.variety} more for some spare.`
                : `${hrs(values.time)}h${have.hours ? " in all" : ""} is only just ${tiers[at].name}. If Discord skips a game, you could get ${below}. Aim for ${hrs(tierAim("time", at))}h in all.`);
        }
        const risky = table.filter(row => noExe(row.id));
        if (risky.length) {
            const sure = { variety: values.variety - risky.length, time: (toTenths(values.time) - risky.reduce((t, r) => t + toTenths(r.hours), 0)) / 10 };
            const drops = ["variety", "time"]
                .filter(badge => tierFor(badge, sure[badge]) < tierFor(badge, values[badge]))
                .map(badge => { const at = tierFor(badge, sure[badge]); return `${BADGES[badge].short} drops to ${at >= 0 ? BADGE_TIERS[badge][at].name : "no badge"}`; });
            if (drops.length) {
                out.push(`${formatCount(risky.length)} of your games have no Windows executable in Discord's catalog: ${listNames(risky.map(r => r.name))}. ` +
                    `The original Variety script skipped games like these. If Discord does too, ${drops.join(" and ")}.`);
            }
        }
        return out;
    }

    function renderPills(summary) {
        const custom = state.mode === "custom";
        const have = played();
        const sent = { variety: summary.games, time: summary.totalHours };
        const values = { variety: have.games + sent.variety, time: addHours(have.hours, sent.time) };
        for (const badge of ["variety", "time"]) {
            const pill = $(`pill-${badge}`);
            pill.hidden = !custom;
            if (!custom) continue;
            const at = tierFor(badge, values[badge]);
            const tier = BADGE_TIERS[badge][at];
            const img = pill.querySelector("img");
            img.hidden = !tier;
            if (tier && img.dataset.key !== tier.key) { img.src = tierIcon(badge, tier); img.dataset.key = tier.key; }
            pill.classList.toggle("none", !tier);
            pill.style.setProperty("--tier", tier ? TIER_COLOR[tier.key] : "");
            pill.dataset.tip = tierLine(badge, sent[badge]);
        }
    }

    function renderOutput() {
        const notes = [];
        let resolved = null;
        try {
            resolved = resolveSelection(catalog.games, currentSelection());
        } catch (error) {
            notes.push({ level: "error", text: error.message });
        }
        if (state.mode === "custom" && spreadError) notes.push({ level: "error", text: spreadError });
        const table = resolved?.table ?? [];
        if (resolved) {
            const name = e => e.name ?? e.id;
            if (resolved.missing.length) notes.push({ level: "error", text: `Not in Discord's catalog: ${resolved.missing.map(name).join(", ")}` });
            if (resolved.ambiguous.length) notes.push({ level: "error", text: `Ambiguous: ${resolved.ambiguous.map(name).join(", ")}` });
            if (resolved.invalid.length) notes.push({ level: "error", text: `Hours must be at least 0.1: ${resolved.invalid.map(name).join(", ")}` });
        }
        const check = validateTable(table, { trackStart: state.trackStart });
        for (const text of check.errors) if (table.length) notes.push({ level: "error", text });
        for (const text of check.warnings) if (/since/.test(text)) notes.push({ level: "warn", text });

        const summary = summarize(table);
        const care = state.mode === "custom" && table.length ? customCautions(table, summary) : [];
        for (const text of care) notes.push({ level: "warn", text });
        cautions = care.length;
        if (state.mode === "custom" && table.length && played().games) {
            notes.push({ level: "info", text: "Game Variety only counts games you haven't played before. Any game here you've already played won't add to it, though its hours still count for Game Time." });
        }

        $("sumGames").textContent = formatCount(summary.games);
        $("sumHours").textContent = formatHours(summary.totalHours);
        renderPills(summary);
        $("notes").innerHTML = notes.map(n => `<li class="${n.level}">${esc(n.text)}</li>`).join("");

        latest = null;
        if (table.length && check.ok && !notes.some(n => n.level === "error")) {
            latest = renderScripts(table, { trackStart: state.trackStart, options: state.options }, templates);
        }
        const blocked = !table.length ? "Add some games first" : "Fix the notes above first";
        for (const key of ["main", "variety", "gameTime"]) {
            for (const b of root.querySelectorAll(`[data-copy="${key}"], [data-download="${key}"]`)) {
                if (b === armed?.el) continue;
                b.disabled = !latest;
                b.dataset.tip = !latest ? blocked
                    : b.dataset.copy ? (key === "main" ? `Copy ${FILE.main}. ${TIP.main}` : `Copy ${FILE[key]}`)
                    : `Save ${FILE[key]}`;
            }
            const file = root.querySelector(`[data-file="${key}"]`);
            if (file) file.textContent = latest ? latest[key].file : "";
        }
        $("preview").value = latest ? latest.main.text : "";
    }

    let outputTimer = null;
    function changed({ custom = false, random = false, now = false } = {}) {
        disarm();
        if (state.mode === "custom" || custom) respread();
        save();
        if (custom) renderCustom();
        if (random) renderRandom();
        clearTimeout(outputTimer);
        outputTimer = setTimeout(renderOutput, now ? 0 : 120);
    }

    let toastTimer = null;
    function toast(text) {
        $("toast").textContent = text;
        $("toast").hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3200);
    }

    // ---------- random: tiers ----------

    function pickTier(badge, i) {
        const r = state.random, have = played();
        if (badge === "variety") {
            const n = sendGames(i, have.games);
            if (n == null) return;
            r.count = n;
            r.goal.variety = i;
            // Keep Game Time on its tier: more games may need more hours (0.1h each).
            const want = r.goal.time >= 0 ? r.goal.time : tierFor("time", addHours(have.hours, pos(r.hours, 0.1)));
            const onTier = tierFor("time", addHours(have.hours, pos(r.hours, 0))) === want && pos(r.hours, 0) >= minHours(n);
            if (!onTier && want >= 0) {
                const j = fitTime(want, n, have.hours);
                r.hours = sendHours(j, n, have.hours);
                if (j !== want) toast(`Game Time moved up to ${BADGE_TIERS.time[j].name}: ${plural(n, "game")} need at least ${hrs(minHours(n))}h.`);
            } else if (pos(r.hours, 0) < minHours(n)) {
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
        menu.classList.toggle("up", up);
    }

    const placeMenus = () => {
        place($("presetsMenu"), $("presetsBtn"));
        place($("results"), $("search"), { stretch: true, maxHeight: 320 });
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
        if (event.target instanceof HTMLDetailsElement && event.target.open) requestAnimationFrame(() => reveal(event.target));
    }, true);

    // ---------- custom: presets dropdown ----------

    function setPresets(open) {
        $("presetsMenu").hidden = !open;
        $("presetsBtn").setAttribute("aria-expanded", String(open));
        if (open) place($("presetsMenu"), $("presetsBtn"));
    }
    document.addEventListener("pointerdown", event => {
        if (!$("presetsMenu").hidden && !event.target.closest?.(".presets")) setPresets(false);
    });
    root.addEventListener("keydown", event => {
        if (event.key === "Escape" && !$("presetsMenu").hidden && event.target.closest?.(".presets")) {
            setPresets(false);
            $("presetsBtn").focus();
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
            c.total = pos($("cTotal").value, c.total);
        }
        c.spread = spread;
        if (spread === "manual" && c.manual) {
            let restored = 0;
            for (const g of c.games) if (pos(c.manual[g.id], 0)) { g.hours = c.manual[g.id]; restored += 1; }
            if (restored) toast(`Brought back your manual hours for ${restored} game${restored === 1 ? "" : "s"}.`);
        }
        changed({ custom: true });
    }

    let activeResult = 0;
    function renderResults() {
        const q = $("search").value;
        if (!q.trim()) { $("results").hidden = true; return; }
        const have = new Set(state.custom.games.map(g => g.id));
        const results = searchCatalog(index, q, { limit: 12, boostIds: scoreById.size ? new Set(scoreById.keys()) : null });
        activeResult = 0;
        $("results").innerHTML = results.length
            ? results.map((g, i) => `<li data-add="${esc(g.id)}" class="${i === 0 ? "active" : ""}"><span>${esc(g.name)}</span>${have.has(g.id) ? `<span class="muted">Added</span>` : ""}</li>`).join("")
            : `<li class="none">No games found</li>`;
        $("results").hidden = false;
        $("results").scrollTop = 0;
        place($("results"), $("search"), { stretch: true, maxHeight: 320 });
    }

    // ---------- events ----------

    root.addEventListener("click", async event => {
        const target = event.target.closest("button, [data-add]");
        if (armed && target !== armed.el) disarm();
        if (!target || !root.contains(target)) {
            if (!event.target.closest(".search")) $("results").hidden = true;
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
            renderCustom();
        } else if (d.spread) {
            setSpread(d.spread);
        } else if (d.add) {
            const game = byId.get(d.add);
            if (game) addGames([game]);
            $("search").value = "";
            $("results").hidden = true;
        } else if (d.remove != null) {
            state.custom.games.splice(Number(d.remove), 1);
            changed({ custom: true });
        } else if (d.copy || d.download) {
            const key = d.copy ?? d.download;
            const out = latest?.[key];
            if (!out) return;
            if (state.mode === "custom" && cautions
                && !confirmed(target, d.copy ? "Copy anyway?" : "Save anyway?", "Check the warnings above first. Click again to go ahead.")) return;
            if (d.copy) { if (await copyText(out.text)) toast("Copied. Paste it in Discord's console (Ctrl+Shift+I)."); }
            else download(out.file, out.text);
        } else if (d.action) {
            await runAction(d.action, target);
        }
        if (!event.target.closest(".search")) $("results").hidden = true;
    });

    async function runAction(action, button) {
        const c = state.custom;
        try {
            if (action === "max") {
                Object.assign(state.random, { count: ORIGINAL_MAX.games, hours: ORIGINAL_MAX.hours });
                syncGoal();
                changed({ random: true, now: true });
            } else if (action === "shuffle") {
                state.random.seed = newSeed();
                changed({ random: true, now: true });
            } else if (action === "presets") {
                setPresets($("presetsMenu").hidden);
            } else if (action === "add-vibe") {
                if (!ranking) return;
                const skipIds = new Set(c.games.map(g => g.id));
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
                const since = state.trackStart ? hoursSince(state.trackStart) : null;
                if (!since || since <= 0) { $("trackStart").focus(); return; }
                const hours = Math.floor(since * 10) / 10;
                if (state.mode === "random") {
                    state.random.hours = hours;
                    syncGoal();
                    changed({ random: true, now: true });
                } else if (c.spread === "manual") {
                    c.games = scaleTo(c.games, hours);
                    changed({ custom: true, now: true });
                } else {
                    c.total = hours;
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
        if (t === $("rCount") || t === $("rHours")) {
            state.random.count = Math.floor(pos($("rCount").value, state.random.count));
            state.random.hours = pos($("rHours").value, state.random.hours);
            syncGoal();
            changed({ random: true });
        } else if (t === $("haveGames") || t === $("haveHours")) {
            state.have.games = Math.floor(num0($("haveGames").value));
            state.have.hours = toTenths(num0($("haveHours").value)) / 10;
            retarget();
            renderHave();
            changed({ random: true, custom: state.mode === "custom", now: true });
        } else if (t === $("cTop")) {
            state.custom.top = Math.floor(pos(t.value, state.custom.top));
            renderAddTip();
            save();
        } else if (t === $("cTotal")) {
            state.custom.total = pos(t.value, state.custom.total);
            respread();
            for (const [i, g] of state.custom.games.entries()) {
                const cell = $("cList").children[i]?.querySelector(".hrs-val");
                if (cell) cell.textContent = `${formatHours(g.hours || 0)}h`;
            }
            changed();
        } else if (t.dataset.hours != null) {
            const entry = state.custom.games[Number(t.dataset.hours)];
            if (entry) entry.hours = Number(t.value);
            $("cTotal").value = state.custom.games.reduce((s, g) => s + toTenths(g.hours || 0), 0) / 10;
            changed();
        } else if (t === $("search")) {
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
        if (t === $("trackStart")) {
            state.trackStart = t.value || null;
            renderUseWindowTip();
            changed({ now: true });
        } else if (t === $("importFile") && t.files?.[0]) {
            try {
                applyImport(JSON.parse(await t.files[0].text()));
            } catch (error) {
                toast(`Couldn't import: ${error.message}`);
            }
            t.value = "";
        } else if (t === $("rCount") || t === $("rHours")) {
            renderRandom(); // show the stored number again if the field was left empty or invalid
        } else if (t === $("haveGames") || t === $("haveHours")) {
            renderHave();
        } else if (t.dataset.opt) {
            renderAdvanced();
        }
    });

    $("search").addEventListener("keydown", event => {
        const items = [...$("results").querySelectorAll("[data-add]")];
        if (event.key === "Escape") {
            $("results").hidden = true;
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
        const hours = games.reduce((t, g) => t + toTenths(g.hours || 0), 0) / 10;
        $("example").dataset.tip = `Replace your list with an example: ${formatCount(games.length)} games, ${hrs(hours)}h`;
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
    renderOutput();
}
