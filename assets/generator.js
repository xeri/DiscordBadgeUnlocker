// The generator UI. Loaded lazily (preloaded on idle) by app.js.
// All script text comes from the shared skill code, so the page and the CLI produce identical files.

import {
    TIERS, VIBES, assignHours, buildSearchIndex, countByVibe, formatCount, formatHours, hoursSince,
    normalizeSelection, parseRanking, pickFromRanking, resolveSelection, scaleTo, searchCatalog, setAllHours,
    splitEvenly, summarize, validateTable
} from "../skills/discord-badge-unlocker/scripts/core.mjs";
import { loadTemplates, normalizeOptions, renderScripts } from "../skills/discord-badge-unlocker/scripts/templates.mjs";

const DATA = new URL("../data/", import.meta.url);
const STORE_KEY = "discordBadgeUnlocker:v1";

const fetchJson = url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))));

// Start downloading everything the generator needs as soon as this module is preloaded.
const templatesPromise = loadTemplates();
const rankingPromise = fetchJson(new URL("rankings/global.json", DATA)).then(parseRanking);
const presetPromise = fetchJson(new URL("presets/example.json", DATA));
for (const p of [templatesPromise, rankingPromise, presetPromise]) p.catch(() => {});

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

const DEFAULT_STATE = () => ({
    selection: { version: 1, name: null, trackStart: null, games: [] },
    options: normalizeOptions(),
    defaultHours: 1.5,
    pick: { vibe: "popular", count: 150, mode: "weighted", total: 5000, each: 1.5 },
    tab: "main"
});

function loadState() {
    const state = DEFAULT_STATE();
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
        if (saved) {
            state.selection = normalizeSelection(saved.selection ?? state.selection);
            state.options = normalizeOptions(saved.options);
            state.defaultHours = num(saved.defaultHours, state.defaultHours);
            state.pick = { ...state.pick, ...(saved.pick ?? {}) };
            if (["main", "variety", "gameTime", "options"].includes(saved.tab)) state.tab = saved.tab;
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

async function copyText(text, fallbackEl) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (_) {
        fallbackEl?.select();
        return document.execCommand?.("copy") ?? false;
    }
}

const STEPS = {
    main: [
        "Open the Discord desktop app, press <b>Ctrl+Shift+I</b> and pick the <b>Console</b> tab.",
        "If it asks, type <code>allow pasting</code> and press Enter.",
        "Paste the script and press Enter. It sends every game once, then it's done.",
        "Badges can take 24–48h to update. Don't re-run it in the meantime."
    ],
    variety: [
        "The original-style Game Variety engine: it shows each game as your activity while it claims, then stops (unless <b>Keep rotating</b> is on).",
        "It reads your token in memory to call Discord's API, like the original script. Same paste steps as Main."
    ],
    gameTime: [
        "The same engine as Main under the original <code>window.__gameTimePresence</code> name (<code>boost()</code>). Same paste steps as Main."
    ]
};

export function mount(root, { catalogPromise }) {
    root.innerHTML = `<div class="card"><div class="wait"><span class="spinner"></span>Waiting for Discord's catalog…</div></div>`;
    Promise.all([catalogPromise, templatesPromise]).then(
        ([catalog, templates]) => build(root, catalog, templates),
        error => {
            root.innerHTML = `<div class="card"><h2>Couldn't start the generator</h2><p class="muted">${esc(error.message)}</p></div>`;
        }
    );
}

function build(root, catalog, templates) {
    const state = loadState();
    const index = buildSearchIndex(catalog.games);
    const byId = new Map(catalog.games.map(game => [game.id, game]));
    let ranking = null;
    let boostIds = null;
    let latest = null; // { scripts, table, summary }

    root.innerHTML = `
<div class="card">
  <h2>Quick pick <span class="muted" data-ref="rankMeta">Loading the global ranking…</span></h2>
  <div class="vibes" data-ref="vibes"></div>
  <div class="row">
    <label class="inline">Top <input type="number" min="1" step="1" data-ref="pickCount"></label>
    <span class="muted small" data-ref="pickAvail"></span>
  </div>
  <div class="row" style="margin-top:10px">
    <div class="seg" data-ref="pickMode" role="group" aria-label="How to set hours">
      <button type="button" data-mode="weighted" title="More popular games get more hours (by the square root of popularity)">Weighted</button>
      <button type="button" data-mode="even">Even split</button>
      <button type="button" data-mode="flat">Same each</button>
    </div>
    <label class="inline" data-ref="pickTotalWrap"><input type="number" min="0.1" step="0.1" data-ref="pickTotal"> h total</label>
    <label class="inline" data-ref="pickEachWrap"><input type="number" min="0.1" step="0.1" data-ref="pickEach"> h each</label>
  </div>
  <div class="row" style="margin-top:12px">
    <button class="btn primary" type="button" data-action="pick-replace">Replace list</button>
    <button class="btn" type="button" data-action="pick-add">Add to list</button>
    <span class="muted small">or</span>
    <button class="btn ghost" type="button" data-action="preset">Example list (120 games)</button>
  </div>
  <p class="preview" data-ref="pickPreview"></p>
</div>

<div class="card">
  <h2>Search <span class="muted">${esc(formatCount(catalog.games.length))} games in Discord's catalog</span></h2>
  <div class="row">
    <input type="search" placeholder="Search by name, alias or ID…" data-ref="search" style="flex:1 1 260px" autocomplete="off" aria-label="Search games">
    <label class="inline">Adds at <input type="number" min="0.1" step="0.1" data-ref="defaultHours"> h</label>
  </div>
  <ul class="results" data-ref="results"></ul>
</div>

<div class="card">
  <h2>Your list <span class="muted" data-ref="listName"></span></h2>
  <div class="totals">
    <div class="stat"><span class="muted small">Games · Game Variety</span><b data-ref="statGames">0</b>
      <div class="bar" data-ref="barGames"><i></i></div><span class="muted small" data-ref="noteGames"></span></div>
    <div class="stat"><span class="muted small">Hours · Game Time</span><b data-ref="statHours">0</b>
      <div class="bar" data-ref="barHours"><i></i></div><span class="muted small" data-ref="noteHours"></span></div>
  </div>
  <ul class="notes" data-ref="notes"></ul>
  <div class="tools">
    <span class="group"><button class="btn small" type="button" data-action="set-all">Set all to</button><input type="number" min="0.1" step="0.1" value="1.5" data-ref="toolSetAll" aria-label="Hours per game"> h</span>
    <span class="group"><button class="btn small" type="button" data-action="split">Split</button><input type="number" min="0.1" step="0.1" value="5000" data-ref="toolSplit" aria-label="Total hours to split"> h evenly</span>
    <span class="group"><button class="btn small" type="button" data-action="scale">Scale to</button><input type="number" min="0.1" step="0.1" value="5000" data-ref="toolScale" aria-label="Total hours to scale to"> h</span>
    <span class="group"><label class="inline">Played since <input type="date" data-ref="trackStart"></label>
      <button class="btn small ghost" type="button" data-action="fill-window" title="Scale the list to every hour since that date">Fill window</button></span>
  </div>
  <div class="row between" style="margin-bottom:10px">
    <div class="row">
      <button class="btn small" type="button" data-action="export">Export JSON</button>
      <label class="btn small">Import JSON<input type="file" accept="application/json,.json" data-ref="importFile" hidden></label>
    </div>
    <button class="btn small danger" type="button" data-action="clear">Clear list</button>
  </div>
  <div class="list-wrap"><table class="list">
    <thead><tr><th>#</th><th>Game</th><th>Hours</th><th><span class="sr">Remove</span></th></tr></thead>
    <tbody data-ref="listBody"></tbody>
  </table></div>
</div>

<div class="card">
  <h2>Scripts</h2>
  <div class="tabs" role="tablist" data-ref="tabs">
    <button type="button" role="tab" data-tab="main">Main · both badges</button>
    <span class="sep">Advanced</span>
    <button type="button" role="tab" data-tab="variety">Variety</button>
    <button type="button" role="tab" data-tab="gameTime">Game Time</button>
    <button type="button" role="tab" data-tab="options">Options</button>
  </div>
  ${["main", "variety", "gameTime"].map(key => `
  <div class="pane" data-pane="${key}" role="tabpanel">
    ${key !== "main" ? `<p class="muted small">Every script sends the same table, so run just one. They share their history, so mixing them never double-counts.</p>` : ""}
    <ol class="steps">${STEPS[key].map(step => `<li>${step}</li>`).join("")}</ol>
    <div class="row between" style="margin-bottom:8px">
      <span class="mono small" data-file="${key}"></span>
      <span class="row"><span class="toast" data-toast="${key}"></span>
        <button class="btn small" type="button" data-copy="${key}">Copy</button>
        <button class="btn small primary" type="button" data-download="${key}">Download</button></span>
    </div>
    <textarea class="out" readonly spellcheck="false" data-out="${key}" aria-label="Generated script"></textarea>
  </div>`).join("")}
  <div class="pane" data-pane="options" role="tabpanel">
    <div class="opts">
      <fieldset><legend>Main + Game Time</legend>
        <label>Games per batch <input type="number" min="1" max="100" data-opt="batchSize"></label>
        <label>Delay between batches (ms) <input type="number" min="0" max="60000" data-opt="delayMs"></label>
      </fieldset>
      <fieldset><legend>Variety</legend>
        <label>Games per batch <input type="number" min="1" max="50" data-opt="variety.batchSize"></label>
        <label>Delay between batches (ms) <input type="number" min="0" max="60000" data-opt="variety.delayMs"></label>
        <label>Minutes per game shown <input type="number" min="1" max="1440" data-opt="variety.rotateMinutes"></label>
        <label>Keep rotating after the claim <input type="checkbox" data-opt="variety.keepRotating"></label>
      </fieldset>
      <fieldset><legend>All scripts</legend>
        <label>Dry run (send nothing) <input type="checkbox" data-opt="dryRun"></label>
        <p class="muted small" style="margin:0">Keep rotating makes Discord log real play time on top of the table. Leave it off unless you want that.</p>
      </fieldset>
    </div>
  </div>
</div>`;

    const $ = name => root.querySelector(`[data-ref="${name}"]`);
    const save = () => {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
    };

    // ---------- quick pick ----------

    function renderVibes() {
        const counts = ranking ? countByVibe(ranking) : null;
        $("vibes").innerHTML = VIBES.map(vibe => `
<button type="button" class="vibe" data-vibe="${vibe.key}" aria-pressed="${state.pick.vibe === vibe.key}">
  <strong>${esc(vibe.label)}${counts ? ` <span class="muted" style="display:inline">${counts[vibe.key]}</span>` : ""}</strong>
  <span>${esc(vibe.blurb)}</span>
</button>`).join("");
    }

    function currentPick({ add = false } = {}) {
        if (!ranking) return [];
        const skipIds = add ? new Set(state.selection.games.map(g => g.id).filter(Boolean)) : null;
        return pickFromRanking(ranking, { vibe: state.pick.vibe, count: Math.floor(num(state.pick.count, 150)), skipIds });
    }

    function renderPick() {
        $("pickCount").value = state.pick.count;
        $("pickTotal").value = state.pick.total;
        $("pickEach").value = state.pick.each;
        for (const b of $("pickMode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === state.pick.mode));
        $("pickTotalWrap").hidden = state.pick.mode === "flat";
        $("pickEachWrap").hidden = state.pick.mode !== "flat";
        for (const b of $("vibes").querySelectorAll(".vibe")) b.setAttribute("aria-pressed", String(b.dataset.vibe === state.pick.vibe));
        if (!ranking) return;
        const available = countByVibe(ranking)[state.pick.vibe];
        $("pickCount").max = available;
        $("pickAvail").textContent = `of ${available} ranked games`;
        const picked = currentPick();
        const names = picked.slice(0, 8).map(g => g.name).join(", ");
        $("pickPreview").textContent = picked.length
            ? `${names}${picked.length > 8 ? ` … and ${picked.length - 8} more` : ""}`
            : "No games match.";
    }

    function applyPick(add) {
        const picked = currentPick({ add });
        if (!picked.length) return;
        let games;
        try {
            games = assignHours(picked, { mode: state.pick.mode, total: num(state.pick.total, 5000), perGame: num(state.pick.each, 1.5) });
        } catch (error) {
            alert(error.message);
            return;
        }
        const entries = games.map(g => ({ id: g.id, name: g.name, hours: g.hours, exe: g.exe }));
        const vibe = VIBES.find(v => v.key === state.pick.vibe);
        if (add) {
            state.selection.games.push(...entries);
        } else {
            state.selection = { ...state.selection, name: `Global top ${entries.length} · ${vibe.label}`, games: entries };
        }
        changed({ list: true });
    }

    rankingPromise.then(data => {
        ranking = data;
        boostIds = new Set(ranking.games.slice(0, 300).map(g => g.id));
        $("rankMeta").textContent = `${ranking.games.length} most-played PC games · updated ${ranking.updated}`;
        renderVibes();
        renderPick();
    }, error => {
        $("rankMeta").textContent = `Ranking unavailable (${error.message})`;
    });

    // ---------- search ----------

    let searchTimer = null;
    function renderResults() {
        const q = $("search").value;
        const results = q.trim() ? searchCatalog(index, q, { limit: 20, boostIds }) : [];
        const chosen = new Set(state.selection.games.map(g => g.id));
        $("results").innerHTML = results.map(game => `
<li><span class="name">${esc(game.name)}<span class="id">${esc(game.id)}</span></span>
${chosen.has(game.id) ? `<span class="added">Added</span>` : `<button class="btn small" type="button" data-add="${esc(game.id)}">Add</button>`}</li>`).join("")
            || (q.trim() ? `<li class="muted">No games match.</li>` : "");
    }

    function addGame(id) {
        const game = byId.get(id);
        if (!game || state.selection.games.some(g => g.id === id)) return;
        state.selection.games.push({ id: game.id, name: game.name, hours: num(state.defaultHours, 1.5) });
        changed({ list: true });
    }

    // ---------- list ----------

    function renderList() {
        const games = state.selection.games;
        $("listName").textContent = state.selection.name ?? "";
        $("trackStart").value = state.selection.trackStart ?? "";
        $("listBody").innerHTML = games.length
            ? games.map((g, i) => `
<tr><td class="num">${i + 1}</td>
<td class="game">${esc(g.name ?? byId.get(g.id)?.name ?? g.id)}<span class="id">${esc(g.id ?? "by name")}</span></td>
<td class="hrs"><input type="number" min="0.1" step="0.1" value="${esc(g.hours)}" data-hours="${i}" aria-label="Hours"></td>
<td class="del"><button class="btn small ghost danger" type="button" data-remove="${i}" aria-label="Remove">✕</button></td></tr>`).join("")
            : `<tr><td colspan="4" class="empty">No games yet. Use Quick pick, the example list, or search.</td></tr>`;
    }

    function renderTotals(summary, notes) {
        $("statGames").textContent = formatCount(summary.games);
        $("statHours").textContent = `${formatHours(summary.totalHours)}h`;
        $("barGames").firstElementChild.style.width = `${summary.gamesProgress * 100}%`;
        $("barHours").firstElementChild.style.width = `${summary.hoursProgress * 100}%`;
        $("barGames").classList.toggle("full", summary.gamesProgress >= 1);
        $("barHours").classList.toggle("full", summary.hoursProgress >= 1);
        $("noteGames").textContent = summary.games >= TIERS.games
            ? `Top tier reached (${TIERS.games}+)` : `${TIERS.games - summary.games} more for the top tier`;
        $("noteHours").textContent = summary.totalHours >= TIERS.hours
            ? `Top tier reached (${formatCount(TIERS.hours)}h)` : `${formatHours(TIERS.hours - summary.totalHours)}h to the top tier`;
        const since = state.selection.trackStart ? hoursSince(state.selection.trackStart) : null;
        if (since != null && since > 0) $("noteHours").textContent += ` · ${formatHours(Math.floor(since * 10) / 10)}h since ${state.selection.trackStart}`;
        $("notes").innerHTML = notes.map(n => `<li class="${n.level}">${esc(n.text)}</li>`).join("");
    }

    // ---------- outputs ----------

    function renderOutputs() {
        const resolved = resolveSelection(catalog.games, state.selection);
        const notes = [];
        const describe = e => e.name ?? e.id;
        if (resolved.missing.length) notes.push({ level: "error", text: `Not in the catalog (remove or fix): ${resolved.missing.map(describe).join(", ")}` });
        if (resolved.ambiguous.length) notes.push({ level: "error", text: `More than one game has this name: ${resolved.ambiguous.map(describe).join(", ")}` });
        if (resolved.duplicates.length) notes.push({ level: "warn", text: `Listed twice (only the first counts): ${resolved.duplicates.map(describe).join(", ")}` });
        if (resolved.invalid.length) notes.push({ level: "error", text: `Hours must be at least 0.1: ${resolved.invalid.map(describe).join(", ")}` });
        const check = validateTable(resolved.table, { trackStart: resolved.trackStart });
        for (const text of check.errors) notes.push({ level: "error", text });
        for (const text of check.warnings) notes.push({ level: "warn", text });
        const summary = summarize(resolved.table);
        renderTotals(summary, state.selection.games.length ? notes : []);

        latest = null;
        const ok = resolved.table.length > 0 && check.ok && !resolved.invalid.length;
        if (ok) {
            try {
                latest = { scripts: renderScripts(resolved.table, { trackStart: resolved.trackStart, options: state.options }, templates), summary };
            } catch (error) {
                notes.push({ level: "error", text: error.message });
            }
        }
        for (const key of ["main", "variety", "gameTime"]) {
            const out = latest?.scripts[key];
            root.querySelector(`[data-out="${key}"]`).value = out ? out.text : "// Add games to your list to build the script.";
            root.querySelector(`[data-file="${key}"]`).textContent = out ? `${out.file} · ${formatCount(out.text.length)} bytes` : "";
            root.querySelector(`[data-copy="${key}"]`).disabled = !out;
            root.querySelector(`[data-download="${key}"]`).disabled = !out;
        }
    }

    let outputTimer = null;
    function changed({ list = false } = {}) {
        save();
        if (list) {
            renderList();
            renderResults();
            renderPick();
        }
        clearTimeout(outputTimer);
        outputTimer = setTimeout(renderOutputs, list ? 0 : 150);
    }

    function renderTabs() {
        for (const b of $("tabs").querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
        for (const p of root.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== state.tab;
    }

    function renderOptions() {
        for (const input of root.querySelectorAll("[data-opt]")) {
            const path = input.dataset.opt.split(".");
            const value = path.reduce((o, k) => o?.[k], state.options);
            if (input.type === "checkbox") input.checked = !!value;
            else input.value = value;
        }
    }

    // ---------- events ----------

    root.addEventListener("click", async event => {
        const target = event.target.closest("button, [data-vibe]");
        if (!target || !root.contains(target)) return;
        const { action, vibe, mode, add, remove, tab, copy } = target.dataset;
        if (vibe) {
            state.pick.vibe = vibe;
            save();
            renderPick();
        } else if (mode) {
            state.pick.mode = mode;
            save();
            renderPick();
        } else if (add) {
            addGame(add);
        } else if (remove != null) {
            state.selection.games.splice(Number(remove), 1);
            changed({ list: true });
        } else if (tab) {
            state.tab = tab;
            save();
            renderTabs();
        } else if (copy) {
            const out = latest?.scripts[copy];
            if (!out) return;
            const ok = await copyText(out.text, root.querySelector(`[data-out="${copy}"]`));
            const toast = root.querySelector(`[data-toast="${copy}"]`);
            toast.textContent = ok ? "Copied" : "Select the text and copy it";
            setTimeout(() => { toast.textContent = ""; }, 1800);
        } else if (target.dataset.download) {
            const out = latest?.scripts[target.dataset.download];
            if (out) download(out.file, out.text);
        } else if (action) {
            await runAction(action);
        }
    });

    async function runAction(action) {
        const games = state.selection.games;
        try {
            if (action === "pick-replace") applyPick(false);
            else if (action === "pick-add") applyPick(true);
            else if (action === "preset") {
                state.selection = normalizeSelection(await presetPromise);
                changed({ list: true });
            } else if (action === "clear") {
                if (games.length > 10 && !confirm(`Remove all ${games.length} games from your list?`)) return;
                state.selection = { ...state.selection, name: null, games: [] };
                changed({ list: true });
            } else if (action === "set-all") {
                state.selection.games = setAllHours(games, $("toolSetAll").value);
                changed({ list: true });
            } else if (action === "split") {
                state.selection.games = splitEvenly(games, $("toolSplit").value);
                changed({ list: true });
            } else if (action === "scale") {
                state.selection.games = scaleTo(games, $("toolScale").value);
                changed({ list: true });
            } else if (action === "fill-window") {
                const since = state.selection.trackStart ? hoursSince(state.selection.trackStart) : null;
                if (!since || since <= 0) {
                    alert("Pick a past \"Played since\" date first.");
                    return;
                }
                state.selection.games = scaleTo(games, Math.floor(since * 10) / 10);
                changed({ list: true });
            } else if (action === "export") {
                const { version, name, trackStart } = state.selection;
                const file = { version, ...(name ? { name } : {}), trackStart, options: state.options, games: state.selection.games };
                download("selection.json", JSON.stringify(file, null, 2) + "\n", "application/json");
            }
        } catch (error) {
            alert(error.message);
        }
    }

    root.addEventListener("input", event => {
        const t = event.target;
        if (t.dataset.hours != null) {
            const entry = state.selection.games[Number(t.dataset.hours)];
            if (entry) entry.hours = Number(t.value);
            changed();
        } else if (t === $("search")) {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(renderResults, 60);
        } else if (t === $("pickCount") || t === $("pickTotal") || t === $("pickEach")) {
            state.pick.count = Math.floor(num($("pickCount").value, state.pick.count));
            state.pick.total = num($("pickTotal").value, state.pick.total);
            state.pick.each = num($("pickEach").value, state.pick.each);
            save();
            if (t === $("pickCount")) renderPick();
        } else if (t === $("defaultHours")) {
            state.defaultHours = num(t.value, state.defaultHours);
            save();
        } else if (t.dataset.opt) {
            const path = t.dataset.opt.split(".");
            const draft = structuredClone(state.options);
            const holder = path.length > 1 ? draft[path[0]] : draft;
            holder[path.at(-1)] = t.type === "checkbox" ? t.checked : Number(t.value);
            state.options = normalizeOptions(draft);
            changed();
        }
    });

    root.addEventListener("change", async event => {
        const t = event.target;
        if (t === $("trackStart")) {
            state.selection.trackStart = t.value || null;
            changed();
        } else if (t === $("importFile") && t.files?.[0]) {
            try {
                const data = JSON.parse(await t.files[0].text());
                state.selection = normalizeSelection(data);
                if (data.options) {
                    state.options = normalizeOptions(data.options);
                    renderOptions();
                }
                changed({ list: true });
            } catch (error) {
                alert(`Couldn't import: ${error.message}`);
            }
            t.value = "";
        } else if (t.dataset.opt) {
            renderOptions();
        }
    });

    $("search").addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        const first = root.querySelector("[data-add]");
        if (first) {
            addGame(first.dataset.add);
            event.preventDefault();
        }
    });

    $("defaultHours").value = state.defaultHours;
    renderVibes();
    renderPick();
    renderList();
    renderOptions();
    renderTabs();
    renderOutputs();
}
