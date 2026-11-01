// The generator UI: Random or Custom, then Advanced. Loaded lazily (preloaded on idle) by app.js.
// All script text comes from the shared skill code, so the page and the CLI produce identical files.

import {
    ORIGINAL_MAX, TIERS, VIBES, assignHours, buildSearchIndex, countByVibe, formatCount, formatHours, hoursSince,
    normalizeSelection, parseRanking, pickFromRanking, pickRandom, resolveSelection, scaleTo, searchCatalog,
    splitEvenly, summarize, toTenths, validateTable
} from "../skills/discord-badge-unlocker/scripts/core.mjs";
import { loadTemplates, normalizeOptions, renderScripts } from "../skills/discord-badge-unlocker/scripts/templates.mjs";

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
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

const DEFAULT_STATE = () => ({
    mode: "random",
    random: { count: 125, hours: 5000, seed: newSeed() },
    custom: { name: null, vibe: "popular", top: 100, total: 5000, spread: "weighted", games: [] },
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
            state.custom.games = normalizeSelection({ games: state.custom.games ?? [] }).games;
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
    let ranking = null;
    let scoreById = new Map();
    let minScore = 1;
    let latest = null;

    root.innerHTML = `
<div class="seg big" role="group" aria-label="Mode">
  <button type="button" data-mode="random">Random</button>
  <button type="button" data-mode="custom">Custom</button>
</div>

<section class="card" data-pane="random">
  <div class="fields">
    <label class="field"><span>Games</span><input type="number" min="1" step="1" inputmode="numeric" data-ref="rCount"></label>
    <label class="field"><span>Hours</span><input type="number" min="0.1" step="1" inputmode="decimal" data-ref="rHours"></label>
  </div>
  <div class="row">
    <button class="btn" type="button" data-action="max">Max</button>
    <button class="btn" type="button" data-action="shuffle">Shuffle</button>
  </div>
  <details class="peek"><summary data-ref="rSummary"></summary><ol class="peek-list" data-ref="rList"></ol></details>
</section>

<section class="card" data-pane="custom">
  <h3 class="cat">Games</h3>
  <div class="chips" data-ref="vibes"></div>
  <div class="row">
    <label class="inline-field">Top <input type="number" min="1" step="1" inputmode="numeric" data-ref="cTop" aria-label="How many"></label>
    <button class="btn" type="button" data-action="add-vibe">Add</button>
    <div class="search grow">
      <input type="search" placeholder="Search games" autocomplete="off" data-ref="search" aria-label="Search games">
      <ul class="menu" data-ref="results" hidden></ul>
    </div>
  </div>
  <div class="list-head"><span data-ref="cCount"></span><button class="link" type="button" data-action="clear">Clear</button></div>
  <ul class="list" data-ref="cList"></ul>
  <h3 class="cat">Hours</h3>
  <div class="row">
    <div class="seg grow" role="group" aria-label="Spread" data-ref="spread">
      <button type="button" data-spread="weighted">Weighted</button>
      <button type="button" data-spread="even">Even</button>
      <button type="button" data-spread="manual">Manual</button>
    </div>
    <label class="inline-field"><input type="number" min="0.1" step="1" inputmode="decimal" data-ref="cTotal" aria-label="Total hours"> h</label>
  </div>
</section>

<details class="card advanced">
  <summary>Advanced</summary>
  <div class="adv">
    <div class="adv-row"><span class="label">Played since</span><input type="date" data-ref="trackStart" aria-label="Played since">
      <button class="btn sm" type="button" data-action="use-window">Use all hours</button></div>
    <div class="adv-row"><span class="label">List</span>
      <button class="btn sm" type="button" data-action="example">Load example</button>
      <button class="btn sm" type="button" data-action="export">Export</button>
      <label class="btn sm">Import<input type="file" accept="application/json,.json" data-ref="importFile" hidden></label></div>
    <div class="divider"></div>
    <div class="opts">
      <label class="opt">Dry run<span class="switch"><input type="checkbox" data-opt="dryRun"><span></span></span></label>
      <label class="opt">Keep rotating (Variety)<span class="switch"><input type="checkbox" data-opt="variety.keepRotating"><span></span></span></label>
      <label class="opt">Batch size<input type="number" min="1" max="100" data-opt="batchSize"></label>
      <label class="opt">Delay (ms)<input type="number" min="0" max="60000" data-opt="delayMs"></label>
      <label class="opt">Variety batch size<input type="number" min="1" max="50" data-opt="variety.batchSize"></label>
      <label class="opt">Variety delay (ms)<input type="number" min="0" max="60000" data-opt="variety.delayMs"></label>
      <label class="opt">Minutes per game<input type="number" min="1" max="1440" data-opt="variety.rotateMinutes"></label>
    </div>
    <div class="divider"></div>
    ${[["variety", "Variety"], ["gameTime", "Game Time"]].map(([key, label]) => `
    <div class="script-row"><div><b>${label}</b><code data-file="${key}"></code></div>
      <div class="actions"><button class="btn sm" type="button" data-copy="${key}">Copy</button><button class="btn sm" type="button" data-download="${key}">Download</button></div></div>`).join("")}
    <details class="peek"><summary>Preview</summary><textarea class="preview" readonly spellcheck="false" data-ref="preview" aria-label="Main script"></textarea></details>
  </div>
</details>

<ul class="notes" data-ref="notes"></ul>

<div class="dock">
  <div class="sum"><span><b data-ref="sumGames">0</b> games</span><span>·</span><span><b data-ref="sumHours">0</b>h</span>
    <span class="tier" data-ref="tierGames">Variety</span><span class="tier" data-ref="tierHours">Time</span></div>
  <div class="actions">
    <button class="btn" type="button" data-download="main">Download</button>
    <button class="btn primary" type="button" data-copy="main">Copy script</button>
  </div>
  <div class="toast" data-ref="toast" hidden></div>
</div>`;

    const $ = name => root.querySelector(`[data-ref="${name}"]`);
    const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {} };

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
        if (randomCache?.key !== key) randomCache = { key, games: pickRandom(catalog.games, { count: pos(count, 125), seed }) };
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

    function renderRandom() {
        const r = state.random;
        $("rCount").value = r.count;
        $("rHours").value = r.hours;
        const picked = randomGames();
        const each = picked.length ? Math.round((pos(r.hours, 5000) / picked.length) * 10) / 10 : 0;
        $("rSummary").textContent = `${formatCount(picked.length)} games · ${formatHours(each)}h each`;
        $("rList").innerHTML = picked.slice(0, 500).map(g => `<li>${esc(g.name)}</li>`).join("");
        root.querySelector('[data-action="max"]').classList.toggle("primary",
            Number(r.count) === ORIGINAL_MAX.games && Number(r.hours) === ORIGINAL_MAX.hours);
    }

    function renderVibes() {
        const counts = ranking ? countByVibe(ranking) : null;
        $("vibes").innerHTML = VIBES.map(v => `<button type="button" class="chip" data-vibe="${v.key}" aria-pressed="${state.custom.vibe === v.key}" title="${esc(v.blurb)}">${esc(v.label)}${counts ? `<small>${counts[v.key]}</small>` : ""}</button>`).join("");
    }

    function renderCustom() {
        const c = state.custom;
        $("cTop").value = c.top;
        for (const b of root.querySelectorAll("[data-vibe]")) b.setAttribute("aria-pressed", String(b.dataset.vibe === c.vibe));
        for (const b of $("spread").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.spread === c.spread));
        const manual = c.spread === "manual";
        const sum = c.games.reduce((t, g) => t + toTenths(g.hours || 0), 0) / 10;
        $("cTotal").disabled = manual;
        $("cTotal").value = manual ? sum : c.total;
        $("cCount").textContent = `${formatCount(c.games.length)} games`;
        root.querySelector('[data-action="clear"]').hidden = !c.games.length;
        $("cList").innerHTML = c.games.map((g, i) => `
<li><span class="name">${esc(g.name ?? byId.get(g.id)?.name ?? g.id)}</span>
${manual ? `<input class="hrs" type="number" min="0.1" step="0.1" value="${esc(g.hours)}" data-hours="${i}" aria-label="Hours">`
        : `<span class="hrs-val">${formatHours(g.hours || 0)}h</span>`}
<button class="icon-btn" type="button" data-remove="${i}" aria-label="Remove">×</button></li>`).join("");
    }

    function renderAdvanced() {
        $("trackStart").value = state.trackStart ?? "";
        for (const input of root.querySelectorAll("[data-opt]")) {
            const value = input.dataset.opt.split(".").reduce((o, k) => o?.[k], state.options);
            if (input.type === "checkbox") input.checked = !!value;
            else input.value = value;
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
        $("sumGames").textContent = formatCount(summary.games);
        $("sumHours").textContent = formatHours(summary.totalHours);
        $("tierGames").classList.toggle("done", summary.games >= TIERS.games);
        $("tierHours").classList.toggle("done", summary.totalHours >= TIERS.hours);
        $("tierGames").title = `Game Variety: ${summary.games}/${TIERS.games} games`;
        $("tierHours").title = `Game Time: ${formatHours(summary.totalHours)}/${formatCount(TIERS.hours)}h`;
        $("notes").innerHTML = notes.map(n => `<li class="${n.level}">${esc(n.text)}</li>`).join("");

        latest = null;
        if (table.length && check.ok && !notes.some(n => n.level === "error")) {
            latest = renderScripts(table, { trackStart: state.trackStart, options: state.options }, templates);
        }
        for (const key of ["main", "variety", "gameTime"]) {
            for (const b of root.querySelectorAll(`[data-copy="${key}"], [data-download="${key}"]`)) b.disabled = !latest;
            const file = root.querySelector(`[data-file="${key}"]`);
            if (file) file.textContent = latest ? latest[key].file : "";
        }
        $("preview").value = latest ? latest.main.text : "";
    }

    let outputTimer = null;
    function changed({ custom = false, random = false, now = false } = {}) {
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

    // ---------- custom: add games ----------

    function addGames(entries) {
        const have = new Set(state.custom.games.map(g => g.id));
        const fresh = entries.filter(g => !have.has(g.id)).map(g => ({ id: g.id, name: g.name, hours: 1.5, ...(g.exe ? { exe: g.exe } : {}) }));
        state.custom.games.push(...fresh);
        state.custom.name = null;
        changed({ custom: true, now: true });
        return fresh.length;
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
    }

    // ---------- events ----------

    root.addEventListener("click", async event => {
        const target = event.target.closest("button, [data-add]");
        if (!target || !root.contains(target)) {
            if (!event.target.closest(".search")) $("results").hidden = true;
            return;
        }
        const d = target.dataset;
        if (d.mode) {
            state.mode = d.mode;
            renderMode();
            changed({ now: true });
        } else if (d.vibe) {
            state.custom.vibe = d.vibe;
            save();
            renderCustom();
        } else if (d.spread) {
            state.custom.spread = d.spread;
            if (d.spread !== "manual") state.custom.total = pos($("cTotal").value, state.custom.total);
            changed({ custom: true });
        } else if (d.add) {
            const game = byId.get(d.add);
            if (game) addGames([game]);
            $("search").value = "";
            $("results").hidden = true;
        } else if (d.remove != null) {
            state.custom.games.splice(Number(d.remove), 1);
            changed({ custom: true });
        } else if (d.copy) {
            const out = latest?.[d.copy];
            if (out && await copyText(out.text)) toast("Copied. Paste it in Discord's console (Ctrl+Shift+I).");
        } else if (d.download) {
            const out = latest?.[d.download];
            if (out) download(out.file, out.text);
        } else if (d.action) {
            await runAction(d.action);
        }
        if (!event.target.closest(".search")) $("results").hidden = true;
    });

    async function runAction(action) {
        const c = state.custom;
        try {
            if (action === "max") {
                Object.assign(state.random, { count: ORIGINAL_MAX.games, hours: ORIGINAL_MAX.hours });
                changed({ random: true, now: true });
            } else if (action === "shuffle") {
                state.random.seed = newSeed();
                changed({ random: true, now: true });
            } else if (action === "add-vibe") {
                if (!ranking) return;
                const skipIds = new Set(c.games.map(g => g.id));
                addGames(pickFromRanking(ranking, { vibe: c.vibe, count: Math.floor(pos(c.top, 100)), skipIds }));
            } else if (action === "clear") {
                c.games = [];
                c.name = null;
                changed({ custom: true, now: true });
            } else if (action === "use-window") {
                const since = state.trackStart ? hoursSince(state.trackStart) : null;
                if (!since || since <= 0) { $("trackStart").focus(); return; }
                const hours = Math.floor(since * 10) / 10;
                if (state.mode === "random") {
                    state.random.hours = hours;
                    changed({ random: true, now: true });
                } else if (c.spread === "manual") {
                    c.games = scaleTo(c.games, hours);
                    changed({ custom: true, now: true });
                } else {
                    c.total = hours;
                    changed({ custom: true, now: true });
                }
            } else if (action === "example") {
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
        Object.assign(state.custom, { name: sel.name ?? null, games: sel.games, spread: "manual" });
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
            changed({ random: true });
        } else if (t === $("cTop")) {
            state.custom.top = Math.floor(pos(t.value, state.custom.top));
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
            changed({ now: true });
        } else if (t === $("importFile") && t.files?.[0]) {
            try {
                applyImport(JSON.parse(await t.files[0].text()));
            } catch (error) {
                toast(`Couldn't import: ${error.message}`);
            }
            t.value = "";
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
        } else if (event.key === "Enter" && items[activeResult]) {
            event.preventDefault();
            items[activeResult].click();
        }
    });

    rankingPromise.then(data => {
        ranking = data;
        scoreById = new Map(ranking.games.map(g => [g.id, g.score]));
        minScore = Math.min(...ranking.games.map(g => g.score)) || 1;
        renderVibes();
        renderCustom();
        changed({ custom: state.mode === "custom" });
    }, () => {});

    renderVibes();
    renderMode();
    renderRandom();
    respread();
    renderCustom();
    renderAdvanced();
    renderOutput();
}
