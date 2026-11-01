// Shared, dependency-free logic for the DiscordBadgeUnlocker web generator and the agent CLI.
// Runs unchanged in the browser (ES module) and in Node 18+.

export const ORIGINAL_REPO = "https://github.com/everyoneexe/discord-game-badge-presence";

export const CATALOG_SOURCES = Object.freeze([
    { id: "discord-api", label: "discord.com", url: "https://discord.com/api/v9/applications/detectable" },
    { id: "discord-cdn", label: "Discord CDN", url: "https://cdn.discordapp.com/detectables/games.json" }
]);

// Top tiers from the original repo's README.
export const TIERS = Object.freeze({ games: 100, hours: 5000 });

const HOUR_MS = 3600 * 1000;

// ---------- text ----------

export function normalizeText(value) {
    return String(value ?? "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

const basename = value => String(value ?? "").split(/[\\/]/).pop();

// Executables that are almost never the game itself.
const SKIP_EXE = /launcher|server|dedicated|editor|setup|install|unins|demo|crash|report|anticheat|anti_cheat|easyanticheat|battleye|beservice|redist|dxsetup|benchmark|patcher|updater/i;

// Same fallback name the original game-time script used for apps with no executables.
export function slugExe(name) {
    return `${String(name || "game").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "game"}.exe`;
}

export function pickExe(executables, name) {
    if (!Array.isArray(executables) || executables.length === 0) return slugExe(name);
    const clean = value => String(value).replace(/^>/, "").trim();
    const win = executables.filter(entry => entry?.os === "win32" && typeof entry.name === "string" && clean(entry.name));
    if (!win.length) return null; // non-Windows only: skipped, like the original normalizeGame
    const good = win.find(entry => !entry.is_launcher && !SKIP_EXE.test(basename(clean(entry.name))));
    return clean((good ?? win[0]).name);
}

// ---------- catalog ----------

export function normalizeCatalog(raw) {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.applications) ? raw.applications : null;
    if (!list) throw new Error("Catalog is not a list of applications.");
    const seen = new Set();
    const games = [];
    for (const app of list) {
        const id = app?.id == null ? "" : String(app.id);
        if (!/^\d+$/.test(id) || seen.has(id)) continue;
        const name = String(app?.name ?? "").trim();
        if (!name) continue;
        const exe = pickExe(app.executables, name);
        if (!exe) continue;
        seen.add(id);
        const keys = new Set([normalizeText(name)]);
        const aliases = [];
        for (const alias of Array.isArray(app.aliases) ? app.aliases : []) {
            const text = String(alias ?? "").trim();
            const key = normalizeText(text);
            if (!key || keys.has(key)) continue;
            keys.add(key);
            aliases.push(text);
        }
        games.push(aliases.length ? { id, name, exe, aliases } : { id, name, exe });
    }
    return games;
}

// Compact snapshot: one game per line so git diffs stay readable.
export function serializeCatalog(games, { source = "discord-api", fetchedAt = new Date().toISOString() } = {}) {
    const head = JSON.stringify({ v: 1, source, fetchedAt, count: games.length });
    const rows = games.map(game => JSON.stringify(
        game.aliases?.length ? [game.id, game.name, game.exe, game.aliases] : [game.id, game.name, game.exe]
    ));
    return `${head.slice(0, -1)},"games":[\n${rows.join(",\n")}\n]}\n`;
}

export function parseCatalog(data) {
    if (data?.v !== 1 || !Array.isArray(data.games)) throw new Error("Not a DiscordBadgeUnlocker catalog snapshot.");
    const games = data.games.map(([id, name, exe, aliases]) =>
        aliases?.length ? { id, name, exe, aliases } : { id, name, exe });
    return { games, source: data.source ?? "snapshot", fetchedAt: data.fetchedAt ?? null };
}

async function fetchJson(fetchFn, url, timeoutMs) {
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await fetchFn(url, { signal, credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

// Live Discord API → Discord CDN → snapshot (browser only; the CLI reads its snapshot from disk).
export async function loadCatalog({ fetch: fetchFn = globalThis.fetch, snapshotUrl = null, timeoutMs = 15000 } = {}) {
    const errors = [];
    for (const source of CATALOG_SOURCES) {
        try {
            const games = normalizeCatalog(await fetchJson(fetchFn, source.url, timeoutMs));
            if (games.length < 1000) throw new Error(`only ${games.length} games`);
            return { games, source: source.id, sourceLabel: source.label, live: true, fetchedAt: new Date().toISOString(), errors };
        } catch (error) {
            errors.push(`${source.label}: ${error?.message ?? error}`);
        }
    }
    if (snapshotUrl) {
        try {
            const snapshot = parseCatalog(await fetchJson(fetchFn, snapshotUrl, timeoutMs));
            return { ...snapshot, source: "snapshot", sourceLabel: "offline snapshot", live: false, errors };
        } catch (error) {
            errors.push(`snapshot: ${error?.message ?? error}`);
        }
    }
    throw new Error(`Could not load the Discord catalog (${errors.join("; ")}).`);
}

// ---------- search ----------

export function buildSearchIndex(games) {
    return games.map(game => ({
        game,
        keys: [normalizeText(game.name), ...(game.aliases ?? []).map(normalizeText)].filter(Boolean)
    }));
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function searchCatalog(index, query, { limit = 50, boostIds = null } = {}) {
    const raw = String(query ?? "").trim();
    if (/^\d{6,}$/.test(raw)) {
        return index.filter(entry => entry.game.id.startsWith(raw)).slice(0, limit).map(entry => entry.game);
    }
    const q = normalizeText(raw);
    if (!q) return [];
    const hits = [];
    for (const entry of index) {
        let rank = 9;
        for (const key of entry.keys) {
            const r = key === q ? 0 : key.startsWith(q) ? 1 : (" " + key).includes(" " + q) ? 2 : key.includes(q) ? 3 : 9;
            if (r < rank) rank = r;
            if (rank === 0) break;
        }
        if (rank < 9) hits.push({ game: entry.game, rank, boost: boostIds?.has(entry.game.id) ? 1 : 0 });
    }
    hits.sort((a, b) => a.rank - b.rank || b.boost - a.boost ||
        a.game.name.length - b.game.name.length || compareText(a.game.name, b.game.name) || compareText(a.game.id, b.game.id));
    return hits.slice(0, limit).map(hit => hit.game);
}

// ---------- hours ----------

export const toTenths = hours => Math.round(Number(hours) * 10);
export const roundHours = hours => toTenths(hours) / 10;

// Locale-independent "1,234.5".
export function formatHours(hours) {
    const tenths = toTenths(hours);
    const sign = tenths < 0 ? "-" : "";
    const abs = Math.abs(tenths);
    const whole = String(Math.floor(abs / 10)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${sign}${whole}.${abs % 10}`;
}

export function formatCount(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function trackStartMs(date) {
    if (!date) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    if (!match) throw new Error(`trackStart must be YYYY-MM-DD (got "${date}").`);
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

// Hours between trackStart (00:00 UTC) and now.
export function hoursSince(date, now = Date.now()) {
    const start = trackStartMs(date);
    return start == null ? null : (now - start) / HOUR_MS;
}

export function setAllHours(entries, hours) {
    const value = roundHours(hours);
    if (!(value > 0)) throw new Error("Hours must be at least 0.1.");
    return entries.map(entry => ({ ...entry, hours: value }));
}

// Spread `total` hours evenly; leftover tenths go to the first games. Sum is exact.
export function splitEvenly(entries, total) {
    const n = entries.length;
    const tenths = toTenths(total);
    if (!n) return [];
    if (tenths < n) throw new Error(`Need at least ${formatHours(n / 10)}h to give ${n} games 0.1h each.`);
    const base = Math.floor(tenths / n);
    const extra = tenths - base * n;
    return entries.map((entry, i) => ({ ...entry, hours: (base + (i < extra ? 1 : 0)) / 10 }));
}

// Scale hours proportionally to `total` (largest remainder in 0.1h units, every game keeps ≥ 0.1h).
export function scaleTo(entries, total) {
    const n = entries.length;
    const target = toTenths(total);
    if (!n) return [];
    if (target < n) throw new Error(`Need at least ${formatHours(n / 10)}h to give ${n} games 0.1h each.`);
    const weights = entries.map(entry => Math.max(0, toTenths(entry.hours) || 0));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    if (!weightSum) return splitEvenly(entries, total);
    const parts = weights.map((w, i) => {
        const exact = (w * target) / weightSum;
        return { i, value: Math.floor(exact), frac: exact - Math.floor(exact) };
    });
    let left = target - parts.reduce((a, p) => a + p.value, 0);
    for (const p of [...parts].sort((a, b) => b.frac - a.frac || a.i - b.i)) {
        if (left <= 0) break;
        p.value += 1;
        left -= 1;
    }
    for (const p of parts) if (p.value < 1) p.value = 1;
    let over = parts.reduce((a, p) => a + p.value, 0) - target;
    while (over > 0) {
        const biggest = parts.reduce((best, p) => (p.value > best.value ? p : best));
        biggest.value -= 1;
        over -= 1;
    }
    return entries.map((entry, i) => ({ ...entry, hours: parts[i].value / 10 }));
}

// ---------- selection ----------

// Selection file (shared by the page and the CLI):
// { version: 1, name?, trackStart?: "YYYY-MM-DD" | null, options?: {...}, games: [{ id?, name?, hours, exe? }] }
export function normalizeSelection(input) {
    const data = Array.isArray(input) ? { version: 1, games: input } : input;
    if (!data || typeof data !== "object") throw new Error("Selection must be a JSON object.");
    if (data.version != null && data.version !== 1) throw new Error(`Unsupported selection version ${data.version}.`);
    if (!Array.isArray(data.games)) throw new Error("Selection needs a \"games\" array.");
    const trackStart = data.trackStart ? String(data.trackStart) : null;
    if (trackStart) trackStartMs(trackStart);
    const games = data.games.map((entry, i) => {
        if (!entry || typeof entry !== "object") throw new Error(`games[${i}] is not an object.`);
        const id = entry.id == null ? null : String(entry.id);
        if (id != null && !/^\d+$/.test(id)) throw new Error(`games[${i}].id must be a numeric string.`);
        const name = entry.name == null ? null : String(entry.name);
        if (!id && !name) throw new Error(`games[${i}] needs an id or a name.`);
        const out = { hours: Number(entry.hours) };
        if (id) out.id = id;
        if (name) out.name = name;
        if (entry.exe) out.exe = String(entry.exe);
        return out;
    });
    const out = { version: 1 };
    if (data.name) out.name = String(data.name);
    out.trackStart = trackStart;
    if (data.options && typeof data.options === "object") out.options = data.options;
    out.games = games;
    return out;
}

// Lookup maps are cached per catalog array, so re-resolving on every edit stays cheap.
const indexCache = new WeakMap();
function catalogIndexes(games) {
    let cached = indexCache.get(games);
    if (!cached) {
        const byId = new Map(games.map(game => [game.id, game]));
        const byName = new Map();
        for (const game of games) {
            const key = normalizeText(game.name);
            if (!byName.has(key)) byName.set(key, []);
            byName.get(key).push(game);
        }
        cached = { byId, byName };
        indexCache.set(games, cached);
    }
    return cached;
}

export function resolveSelection(games, selection) {
    const sel = normalizeSelection(selection);
    const { byId, byName } = catalogIndexes(games);
    const table = [];
    const missing = [];
    const ambiguous = [];
    const duplicates = [];
    const invalid = [];
    const seen = new Set();
    sel.games.forEach((entry, i) => {
        let game = null;
        if (entry.id) {
            game = byId.get(entry.id) ?? null;
            if (!game) missing.push({ index: i, id: entry.id, name: entry.name ?? null });
        } else {
            const found = byName.get(normalizeText(entry.name)) ?? [];
            if (found.length === 1) game = found[0];
            else if (found.length > 1) ambiguous.push({ index: i, name: entry.name, ids: found.map(g => `${g.id} (${g.name})`) });
            else missing.push({ index: i, id: null, name: entry.name });
        }
        if (!game) return;
        if (seen.has(game.id)) {
            duplicates.push({ index: i, id: game.id, name: game.name });
            return;
        }
        const hours = roundHours(entry.hours);
        if (!Number.isFinite(hours) || hours <= 0) {
            invalid.push({ index: i, id: game.id, name: game.name, hours: entry.hours });
            return;
        }
        seen.add(game.id);
        table.push({ id: game.id, name: game.name, exe: entry.exe || game.exe, hours });
    });
    const sorted = table
        .map((row, i) => ({ row, i }))
        .sort((a, b) => b.row.hours - a.row.hours || a.i - b.i)
        .map(item => item.row);
    return {
        table: sorted,
        trackStart: sel.trackStart,
        options: sel.options ?? null,
        missing,
        ambiguous,
        duplicates,
        invalid,
        ok: !missing.length && !ambiguous.length && !duplicates.length && !invalid.length
    };
}

// ---------- validation / summary ----------

export function summarize(table) {
    const tenths = table.reduce((sum, row) => sum + toTenths(row.hours), 0);
    const totalHours = tenths / 10;
    return {
        games: table.length,
        totalHours,
        gamesProgress: Math.min(1, table.length / TIERS.games),
        hoursProgress: Math.min(1, totalHours / TIERS.hours)
    };
}

export function validateTable(table, { trackStart = null, now = Date.now() } = {}) {
    const errors = [];
    const warnings = [];
    if (!table.length) errors.push("Add at least one game.");
    const ids = new Set();
    for (const row of table) {
        if (!/^\d+$/.test(String(row.id))) errors.push(`${row.name}: invalid id.`);
        if (ids.has(row.id)) errors.push(`${row.name} is in the table twice.`);
        ids.add(row.id);
        if (!Number.isFinite(row.hours) || toTenths(row.hours) < 1) errors.push(`${row.name}: hours must be at least 0.1.`);
        if (!row.exe) errors.push(`${row.name}: missing executable name.`);
    }
    const { games, totalHours } = summarize(table);
    if (games && games < TIERS.games) {
        warnings.push(`${games} games: the Game Variety badge's top tier needs ${TIERS.games}+.`);
    }
    if (totalHours > TIERS.hours) {
        warnings.push(`${formatHours(totalHours)}h is past the ${formatCount(TIERS.hours)}h Game Time ceiling; extra hours don't raise the badge.`);
    }
    if (trackStart) {
        const available = hoursSince(trackStart, now);
        if (available <= 0) errors.push(`Track-start date ${trackStart} is in the future.`);
        else if (totalHours > available) {
            warnings.push(`${formatHours(totalHours)}h is more than the ${formatHours(Math.floor(available * 10) / 10)}h since ${trackStart}.`);
        }
    }
    return { errors, warnings, ok: errors.length === 0 };
}

// ---------- global ranking + vibes ----------

// Vibes are player types, derived from each game's top Steam user tags at runtime.
// A game fits a vibe when one of its top VIBE_TAG_DEPTH tags is in `tags` and none is in `not`.
// To change a vibe, edit its lists here; the ranking data doesn't need rebuilding.
export const VIBE_TAG_DEPTH = 10;
export const VIBES = Object.freeze([
    { key: "popular", label: "Popular", blurb: "The most played games of any kind", tags: null },
    { key: "competitive", label: "Competitive", blurb: "Ranked shooters, MOBAs, battle royales, fighters",
        tags: ["Competitive", "eSports", "PvP", "MOBA", "Battle Royale", "Tactical Shooter", "Hero Shooter", "Extraction Shooter", "Fighting", "Auto Battler"] },
    { key: "cozy", label: "Cozy & cute", blurb: "Anime, gacha, cute and cozy games, colorful indies",
        tags: ["Cute", "Anime", "Cozy", "Wholesome", "Cartoony", "Gacha", "Colorful", "Hand-drawn", "Pixel Graphics"],
        not: ["Horror", "Gore", "Psychological Horror"] },
    { key: "adventurer", label: "Adventurer", blurb: "RPGs, open worlds, MMOs, story games",
        tags: ["RPG", "Action RPG", "JRPG", "CRPG", "MMORPG", "Open World", "Story Rich", "Souls-like"] },
    { key: "builder", label: "Builder", blurb: "Strategy, sims, sandbox and survival-crafting",
        tags: ["Grand Strategy", "RTS", "4X", "Turn-Based Strategy", "City Builder", "Colony Sim", "Automation", "Base Building",
            "Sandbox", "Crafting", "Open World Survival Craft", "Building", "Management", "Resource Management", "Automobile Sim", "Farming Sim", "Life Sim"] },
    { key: "friends", label: "With friends", blurb: "Co-op, party games and horror nights",
        tags: ["Online Co-Op", "Co-op", "Co-op Campaign", "Party Game", "Social Deduction"],
        not: ["Competitive", "eSports", "MOBA", "Battle Royale", "Tactical Shooter"] }
]);

export function vibesFor(tags) {
    const top = new Set((tags ?? []).slice(0, VIBE_TAG_DEPTH));
    return VIBES.filter(vibe => vibe.tags && vibe.tags.some(tag => top.has(tag)) && !(vibe.not ?? []).some(tag => top.has(tag)))
        .map(vibe => vibe.key);
}

export function parseRanking(data) {
    if (data?.kind !== "ranking" || data.version !== 1 || !Array.isArray(data.games)) throw new Error("Not a ranking file.");
    return data;
}

// The top `count` games for a vibe ("popular" = no filter), skipping ids already chosen.
export function pickFromRanking(ranking, { vibe = "popular", count = 150, skipIds = null } = {}) {
    const fits = vibe === "popular" ? () => true : game => vibesFor(game.tags).includes(vibe);
    return ranking.games.filter(game => fits(game) && !skipIds?.has(game.id)).slice(0, Math.max(0, count));
}

export function countByVibe(ranking) {
    const counts = Object.fromEntries(VIBES.map(vibe => [vibe.key, 0]));
    counts.popular = ranking.games.length;
    for (const game of ranking.games) for (const key of vibesFor(game.tags)) counts[key] += 1;
    return counts;
}

// Hours for picked games: "weighted" (by √popularity, scaled to total), "even" (total split evenly) or "flat" (perGame each).
export const HOUR_MODES = Object.freeze(["weighted", "even", "flat"]);

export function assignHours(games, { mode = "weighted", total = 5000, perGame = 1.5 } = {}) {
    const base = games.map(game => ({
        id: game.id,
        name: game.name,
        exe: game.exe,
        hours: mode === "weighted" ? Math.sqrt(Math.max(Number(game.score) || 0, 0.01)) : 1
    }));
    if (!base.length) return [];
    if (mode === "flat") return setAllHours(base, perGame);
    if (mode === "even") return splitEvenly(base, total);
    return scaleTo(base, total);
}
