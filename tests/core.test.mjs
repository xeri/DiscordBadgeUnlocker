// Unit tests for the shared logic (core.mjs) and script rendering (templates.mjs). No dependencies.
//   npm test
// The generated scripts themselves are exercised end to end by `npm run verify`.

import test from "node:test";
import assert from "node:assert/strict";
import {
    BADGE_TIERS, TIERS, catalogIndex, countByVibe, countableHours, fitTier, formatCount, formatHours, minHours, normalizeCatalog,
    normalizeSelection, parseCatalog, pickFromRanking, pickRandom, randomPool, resolveSelection, scaleTo, searchCatalog,
    sendGames, sendHours, serializeCatalog, splitEvenly, sumHours, summarize, tierAim, tierFor, validateTable, vibesFor
} from "../skills/discord-badge-unlocker/scripts/core.mjs";
import {
    OUTPUTS, loadTemplates, normalizeFirstHeartbeat, normalizeOptions, renderFirstHeartbeat, renderScripts, zonedTimeToMs
} from "../skills/discord-badge-unlocker/scripts/templates.mjs";
import vm from "node:vm";

const win = name => [{ os: "win32", name: `win64/${name}` }]; // a real exe: not the "<name>.exe" slug
const CATALOG = normalizeCatalog([
    { id: "100001", name: "Valheim", executables: win("valheim.exe") },
    { id: "100002", name: "VALORANT", executables: win("valorant.exe"), aliases: ["Valorant Riot"] },
    { id: "100003", name: "Escape from Tarkov", executables: win("escapefromtarkov.exe") },
    { id: "100004", name: "Val", executables: win("val.exe") },
    { id: "100005", name: "Interval", executables: win("interval.exe") },
    { id: "100006", name: "Doom", executables: win("doom.exe") },
    { id: "100007", name: "Doom", executables: win("doom2016.exe") },
    { id: "100008", name: "No Exe Game" },
    { id: "100009", name: "Linux Only", executables: [{ os: "linux", name: "game" }] }
]);

// ---------- tiers ----------

test("TIERS are the top tier minimums", () => {
    assert.deepEqual(TIERS, { games: 100, hours: 5000 });
});

test("tierFor finds the highest tier reached", () => {
    assert.equal(tierFor("variety", 0), -1);
    assert.equal(tierFor("variety", 1), -1);
    assert.equal(tierFor("variety", 2), 0);
    assert.equal(tierFor("variety", 19), 3);
    assert.equal(tierFor("variety", 20), 4);
    assert.equal(tierFor("variety", 1000), 9);
    assert.equal(tierFor("time", 0.9), -1);
    assert.equal(tierFor("time", 1), 0);
    assert.equal(tierFor("time", 4999.9), 8);
    assert.equal(tierFor("time", 5000), 9);
    assert.equal(tierFor("time", NaN), -1);
});

test("tierAim adds ~10% but stays below the next tier", () => {
    assert.equal(tierAim("variety", 9), 110);
    assert.equal(tierAim("variety", 0), 3); // ceil(2.2)
    assert.equal(tierAim("variety", 3), 17); // ceil(16.5)
    assert.equal(tierAim("time", 9), 5500);
    assert.equal(tierAim("time", 0), 2); // ceil(1.1)
    for (const badge of ["variety", "time"]) {
        BADGE_TIERS[badge].forEach((tier, i) => {
            const aim = tierAim(badge, i);
            assert.ok(aim >= tier.min && aim < (BADGE_TIERS[badge][i + 1]?.min ?? Infinity), `${badge} ${tier.key}`);
        });
    }
});

test("sendGames lands played + new on the tier, or says it can't", () => {
    assert.equal(sendGames(9, 0), 110);
    assert.equal(sendGames(9, 95), 15);
    assert.equal(sendGames(9, 200), 1); // already past it: at least one game
    assert.equal(sendGames(3, 0), 17); // Ranger: 15–19
    assert.equal(sendGames(3, 18), 1);
    assert.equal(sendGames(3, 19), null); // any new game makes 20 (Explorer)
    assert.equal(sendGames(0, 5), null);
});

test("sendHours respects the 0.1h-per-game minimum", () => {
    assert.equal(sendHours(9, 250, 0), 5500);
    assert.equal(sendHours(0, 1, 0), 2);
    assert.equal(sendHours(0, 10, 0), 2);
    assert.equal(sendHours(0, 50, 0), null); // 50 games need 5h: past Casual (1–4.9h)
    assert.equal(sendHours(1, 50, 0), 6); // Recreational: aim ceil(5 × 1.1)
    assert.equal(sendHours(2, 1, 12.5), 9.5); // aim 22h in all
    assert.equal(sendHours(0, 1, 4.9), null); // already at 4.9h: +0.1 makes 5 (Recreational)
});

test("fitTier moves up to the first reachable tier", () => {
    assert.equal(fitTier("variety", 3, 19), 4);
    assert.equal(fitTier("variety", 3, 0), 3);
    assert.equal(fitTier("variety", 0, 500), 9);
    assert.equal(fitTier("time", 0, 0, 50), 1);
    assert.equal(fitTier("time", 0, 0, 1), 0);
    assert.equal(minHours(250), 25);
});

// ---------- hours ----------

test("splitEvenly gives an exact total, leftover tenths first", () => {
    const out = splitEvenly([{ id: "a" }, { id: "b" }, { id: "c" }], 1);
    assert.deepEqual(out.map(e => e.hours), [0.4, 0.3, 0.3]);
    assert.equal(sumHours(out), 1);
    assert.throws(() => splitEvenly([{}, {}], 0.1), /at least 0.2h/);
    assert.deepEqual(splitEvenly([], 5), []);
});

test("scaleTo keeps proportions, an exact total and ≥ 0.1h each", () => {
    const out = scaleTo([{ hours: 1 }, { hours: 2 }, { hours: 1000 }], 10);
    assert.equal(sumHours(out), 10);
    assert.ok(out.every(e => e.hours >= 0.1));
    assert.ok(out[2].hours > out[1].hours);
    assert.deepEqual(scaleTo([{ hours: 0 }, { hours: 0 }], 1).map(e => e.hours), [0.5, 0.5]);
});

test("formatHours and formatCount are locale-independent", () => {
    assert.equal(formatHours(1234.5), "1,234.5");
    assert.equal(formatHours(5000), "5,000.0");
    assert.equal(formatHours(0.04), "0.0");
    assert.equal(formatHours(-3.2), "-3.2");
    assert.equal(formatCount(25064), "25,064");
    assert.equal(formatCount(999), "999");
});

test("sumHours sums in tenths", () => {
    assert.equal(sumHours([{ hours: 0.1 }, { hours: 0.2 }]), 0.3); // not 0.30000000000000004
    assert.equal(sumHours([{ hours: 1 }, {}, { hours: "" }]), 1);
});

// ---------- catalog, search, selection ----------

test("a real exe that happens to match the made-up name still counts as real", () => {
    const games = normalizeCatalog([
        { id: "1", name: "Geometry Dash", executables: [{ os: "win32", name: "geometrydash.exe" }] },
        { id: "2", name: "Teamfight Tactics", executables: [] }
    ]);
    assert.deepEqual(games.map(g => [g.exe, g.noExe ?? false]), [["geometrydash.exe", false], ["teamfighttactics.exe", true]]);
    assert.deepEqual(randomPool(games).map(g => g.id), ["1"]);
});

test("snapshots keep the noExe flag (v2) and still read v1", () => {
    const games = [
        { id: "1", name: "Geometry Dash", exe: "geometrydash.exe" },
        { id: "2", name: "Teamfight Tactics", exe: "teamfighttactics.exe", noExe: true, aliases: ["TFT"] }
    ];
    const text = serializeCatalog(games, { source: "file", fetchedAt: "2026-11-01T00:00:00.000Z" });
    assert.ok(text.includes('["2","Teamfight Tactics",null,["TFT"]]'));
    assert.deepEqual(parseCatalog(JSON.parse(text)), { games, source: "file", fetchedAt: "2026-11-01T00:00:00.000Z" });
    // v1 stored the made-up name, so it can only guess: a real exe named like it reads as noExe
    const v1 = { v: 1, games: [["1", "Geometry Dash", "geometrydash.exe"], ["3", "Doom", "bin/doom.exe"]] };
    assert.deepEqual(parseCatalog(v1).games.map(g => g.noExe ?? false), [true, false]);
    assert.throws(() => parseCatalog({ v: 3, games: [] }), /Not a DiscordBadgeUnlocker catalog snapshot/);
});

test("normalizeCatalog keeps Windows games and dedupes aliases", () => {
    const byId = catalogIndex(CATALOG).byId;
    assert.equal(byId.get("100001").exe, "win64/valheim.exe");
    assert.equal(byId.get("100001").noExe, undefined);
    assert.equal(byId.get("100008").exe, "noexegame.exe"); // no executables: made-up name, like the original Game Time script
    assert.equal(byId.get("100008").noExe, true);
    assert.equal(byId.has("100009"), false); // non-Windows only: skipped
    assert.deepEqual(byId.get("100002").aliases, ["Valorant Riot"]);
});

test("searchCatalog ranks exact > prefix > word start > anywhere", () => {
    const index = catalogIndex(CATALOG).search;
    const ids = (q, opts) => searchCatalog(index, q, opts).map(g => g.id);
    assert.deepEqual(ids("val"), ["100004", "100001", "100002", "100005"]);
    assert.deepEqual(ids("tarkov"), ["100003"]); // word start
    assert.deepEqual(ids("riot"), ["100002"]); // via alias
    assert.deepEqual(ids("  VAL  ", { limit: 1 }), ["100004"]);
    assert.deepEqual(ids("zzz"), []);
    assert.deepEqual(ids(""), []);
    assert.deepEqual(ids("10000"), []); // under 6 digits is text
    assert.deepEqual(ids("100005"), ["100005"]); // numeric id prefix
    // boost breaks ties within a rank (Valheim and VALORANT are both prefix matches)
    assert.deepEqual(ids("val", { boostIds: new Map([["100002", 9]]) }), ["100004", "100002", "100001", "100005"]);
});

test("normalizeSelection validates the file", () => {
    assert.deepEqual(normalizeSelection([{ id: 100001, hours: "2" }]), { version: 1, trackStart: null, games: [{ hours: 2, id: "100001" }] });
    assert.throws(() => normalizeSelection({ version: 2, games: [] }), /Unsupported selection version/);
    assert.throws(() => normalizeSelection({}), /"games" array/);
    assert.throws(() => normalizeSelection({ games: [{ hours: 1 }] }), /needs an id or a name/);
    assert.throws(() => normalizeSelection({ games: [{ id: "abc", hours: 1 }] }), /numeric string/);
    assert.throws(() => normalizeSelection({ trackStart: "1/2/2026", games: [] }), /YYYY-MM-DD/);
});

test("resolveSelection reports problems and sorts by hours (stable)", () => {
    const r = resolveSelection(CATALOG, {
        games: [
            { name: "valheim", hours: 2 },
            { name: "Doom", hours: 1 },
            { id: "999999", hours: 1 },
            { id: "100001", hours: 1 },
            { id: "100003", hours: 0 },
            { id: "100004", hours: 5, exe: "custom/val.exe" },
            { name: "Interval", hours: 2 }
        ]
    });
    assert.deepEqual(r.table.map(row => [row.id, row.hours]), [["100004", 5], ["100001", 2], ["100005", 2]]);
    assert.equal(r.table[0].exe, "custom/val.exe");
    assert.equal(r.table[1].exe, "win64/valheim.exe");
    assert.deepEqual(r.ambiguous.map(a => a.index), [1]);
    assert.deepEqual(r.missing.map(m => m.index), [2]);
    assert.deepEqual(r.duplicates.map(d => d.index), [3]);
    assert.deepEqual(r.invalid.map(v => v.index), [4]);
    assert.equal(r.ok, false);
});

test("summarize and validateTable", () => {
    const table = resolveSelection(CATALOG, { games: [{ id: "100001", hours: 3000 }, { id: "100002", hours: 2500.5 }] }).table;
    assert.deepEqual(summarize(table), { games: 2, totalHours: 5500.5 });
    const now = Date.UTC(2026, 10, 1);
    const check = validateTable(table, { trackStart: "2026-10-01", now });
    assert.equal(check.ok, true);
    assert.deepEqual(check.warnings.map(w => w.kind), ["variety", "time", "window"]);
    assert.match(check.warnings[2].text, /more than the 744\.0h since 2026-10-01/);
    assert.deepEqual(validateTable(table, { trackStart: "2027-01-01", now }).errors, ["Track-start date 2027-01-01 is in the future."]);
    assert.equal(validateTable([]).ok, false);
});

// ---------- ranking, random ----------

test("vibes come from each game's top tags", () => {
    const ranking = {
        kind: "ranking", version: 1, games: [
            { id: "1", tags: ["FPS", "Competitive"] },
            { id: "2", tags: ["Cozy", "Farming Sim"] },
            { id: "3", tags: ["Cute", "Horror"] }, // cozy excludes horror
            { id: "4", tags: ["Online Co-Op", "Horror"] }
        ]
    };
    assert.deepEqual(vibesFor(["Cozy", "Farming Sim"]), ["cozy", "strategy"]);
    assert.deepEqual(pickFromRanking(ranking, { vibe: "cozy" }).map(g => g.id), ["2"]);
    assert.deepEqual(pickFromRanking(ranking, { vibe: "popular", count: 2, skipIds: new Set(["1"]) }).map(g => g.id), ["2", "3"]);
    assert.deepEqual(pickFromRanking(ranking, { vibe: "nope" }), []);
    assert.deepEqual(pickFromRanking(ranking, { vibe: "friends" }).map(g => g.id), ["4"]); // old key for "coop"
    assert.deepEqual(pickFromRanking(ranking, { skipIds: { has: id => id !== "3" } }).map(g => g.id), ["3"]); // any .has()
    assert.equal(countByVibe(ranking).popular, 4);
    assert.equal(countByVibe(ranking).coop, 1);
});

test("pickRandom is seeded and skips games without a real executable", () => {
    const a = pickRandom(CATALOG, { count: 4, seed: 42 });
    assert.deepEqual(a, pickRandom(CATALOG, { count: 4, seed: 42 }));
    assert.equal(new Set(a.map(g => g.id)).size, 4);
    assert.ok(!a.some(g => g.id === "100008"));
    assert.equal(pickRandom(CATALOG, { count: 100, seed: 1 }).length, 7); // the whole pool
});

// ---------- templates ----------

test("normalizeOptions clamps and fills defaults", () => {
    const o = normalizeOptions({ batchSize: 500, delayMs: -5, dryRun: "yes", variety: { rotateMinutes: 2.6, keepRotating: true } });
    assert.deepEqual(o, { batchSize: 100, delayMs: 0, dryRun: false, variety: { batchSize: 5, delayMs: 4000, rotateMinutes: 3, keepRotating: true } });
    assert.deepEqual(normalizeOptions(null), normalizeOptions());
});

test("renderScripts is deterministic and shares one table block", async () => {
    const templates = await loadTemplates();
    const table = resolveSelection(CATALOG, { games: [{ id: "100001", hours: 1.25 }, { id: "100002", hours: 3 }] }).table;
    const a = renderScripts(table, { trackStart: "2026-10-01", options: { dryRun: true } }, templates);
    const b = renderScripts(table, { trackStart: "2026-10-01", options: { dryRun: true } }, templates);
    assert.deepEqual(a, b);
    assert.deepEqual(Object.keys(a), OUTPUTS.map(o => o.key));
    const block = text => text.slice(text.indexOf("    // ===== Game table"), text.indexOf("    // ===== End of game table ====="));
    assert.ok(block(a.main.text).includes("const TOTAL_HOURS = 4.3;"));
    assert.ok(block(a.main.text).includes("TRACK_START_MS = Date.UTC(2026, 9, 1)"));
    for (const key of ["variety", "gameTime"]) assert.equal(block(a[key].text), block(a.main.text));
    assert.ok(a.main.text.includes("dryRun: true"));
    assert.ok(!Object.values(a).some(s => s.text.includes("Math.random")));
});

// ---------- Discord's limits and the Danger Zone ----------

test("Game Time only counts time from 2025-12-08 on", () => {
    const now = Date.UTC(2026, 10, 1);
    assert.equal(countableHours(now), 7872); // 328 days
    const table = [{ id: "1", name: "Long", exe: "a.exe", hours: 8000 }, { id: "2", name: "Short", exe: "b.exe", hours: 24 }];
    const since = validateTable(table, { now }).warnings.filter(w => w.kind === "since");
    assert.equal(since.length, 1);
    assert.match(since[0].text, /^1 games have more than the 7,872\.0h since 2025-12-08/);
});

test("pickRandom can draw from every game, untested ones included", () => {
    const all = pickRandom(CATALOG, { count: 100, seed: 3, all: true });
    assert.equal(all.length, CATALOG.length);
    assert.ok(all.some(g => g.noExe));
});

test("uncapped options keep the scripts' wider limits", () => {
    assert.equal(normalizeOptions({ batchSize: 500 }).batchSize, 100);
    assert.equal(normalizeOptions({ batchSize: 500 }, { uncapped: true }).batchSize, 500);
    assert.equal(normalizeOptions({ variety: { rotateMinutes: 1e9 } }, { uncapped: true }).variety.rotateMinutes, 525600);
});

// ---------- Danger Zone test: first heartbeat ----------

const FH_GAME = { id: "100001", name: "Valheim", exe: "valheim.exe" };
const FH_FIRST = Date.UTC(2019, 2, 5, 19, 30); // 14:30 in New York

test("zonedTimeToMs reads a datetime-local value in a time zone, DST included", () => {
    assert.equal(zonedTimeToMs("2019-03-05T14:30", "America/New_York"), FH_FIRST);
    assert.equal(zonedTimeToMs("2024-03-10T03:30", "America/New_York"), Date.UTC(2024, 2, 10, 7, 30));
    assert.equal(zonedTimeToMs("2019-07-01T09:00", "Asia/Kolkata"), Date.UTC(2019, 6, 1, 3, 30));
    assert.ok(Number.isNaN(zonedTimeToMs("2019-03-05", "UTC")));
});

test("normalizeFirstHeartbeat needs a game, a date and a method", () => {
    assert.throws(() => normalizeFirstHeartbeat({ firstMs: FH_FIRST, hours: 1 }), /Pick a game/);
    assert.throws(() => normalizeFirstHeartbeat({ game: FH_GAME, hours: 1 }), /date and time/);
    assert.throws(() => normalizeFirstHeartbeat({ game: FH_GAME, firstMs: FH_FIRST, hours: 1, backdate: false, clock: "off" }), /Backdate or pick a clock/);
    assert.throws(() => normalizeFirstHeartbeat({ game: FH_GAME, firstMs: FH_FIRST, hours: 1, clock: "page", timeZone: "Mars/Base" }), /isn't a time zone/);
    // Until now needs Backdate and a clock the page knows (not the system's).
    assert.equal(normalizeFirstHeartbeat({ game: FH_GAME, firstMs: FH_FIRST, hours: 1, untilNow: true, clock: "system" }).untilNow, false);
    // The time zone only applies with a shifted clock.
    assert.equal(normalizeFirstHeartbeat({ game: FH_GAME, firstMs: FH_FIRST, hours: 1, timeZone: "UTC" }).timeZone, null);
});

// Runs a rendered first-heartbeat script against a mocked Discord client; `osOffset` moves the "system" clock.
async function runFirstHeartbeat(text, { osOffset = 0 } = {}) {
    const posts = [];
    const logs = [];
    const ctx = { console: { log: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) },
        crypto: globalThis.crypto, TextEncoder, btoa, setTimeout: fn => setImmediate(fn), addEventListener() {} };
    ctx.window = ctx;
    vm.createContext(ctx);
    if (osOffset) vm.runInContext(`(() => { const now = Date.now; Date.now = () => now.call(Date) + ${osOffset}; })()`, ctx);
    const client = {
        get: async () => ({ body: { id: "111111111111111111", username: "tester", analytics_token: "tok" } }),
        post: async req => { posts.push({ events: req.body.events, page: vm.runInContext("[Date.now(), new Date().getTimezoneOffset()]", ctx) }); return { ok: true, status: 204 }; },
        del: async () => ({})
    };
    const requireFn = () => ({ default: client });
    requireFn.m = { 1: () => "HTTPUtils" };
    requireFn.c = {};
    ctx.webpackChunkdiscord_app = { push: ([, , fn]) => fn(requireFn), pop() {} };
    const RealDate = vm.runInContext("Date", ctx);
    vm.runInContext(text, ctx);
    await new Promise(resolve => setTimeout(resolve, 100));
    return { posts, logs, ctx, restored: vm.runInContext("Date", ctx) === RealDate };
}

test("every first-heartbeat method sends the same session; clocks are put back", async () => {
    const templates = await loadTemplates();
    const end = FH_FIRST + 2 * 3600000;
    const cases = [
        [{ backdate: true, clock: "off" }, null],
        [{ backdate: false, clock: "page", timeZone: "America/New_York" }, FH_FIRST],
        [{ backdate: true, clock: "page", timeZone: "America/New_York" }, end],
        [{ backdate: false, clock: "system" }, FH_FIRST, FH_FIRST + 60000],
        [{ backdate: true, clock: "system" }, end, end - 300000]
    ];
    for (const [opts, pageAt, osAt] of cases) {
        const { text } = renderFirstHeartbeat({ game: FH_GAME, firstMs: FH_FIRST, hours: 2, ...opts }, templates);
        new vm.Script(text);
        assert.ok(!text.includes("Math.random"));
        const run = await runFirstHeartbeat(text, { osOffset: osAt ? osAt - Date.now() : 0 });
        const name = JSON.stringify(opts);
        assert.equal(run.posts.length, 1, name);
        const [first, launch, last] = run.posts[0].events;
        assert.deepEqual([first.type, launch.type, last.type], ["running_game_heartbeat", "launch_game", "running_game_heartbeat"], name);
        // The system clock sends at whatever the computer reads, so allow its drift; the page clock lands exactly.
        const slack = 5000;
        assert.ok(Math.abs(first.properties.client_track_timestamp - FH_FIRST) < slack, name);
        assert.equal(first.properties.initial_heartbeat, true);
        assert.equal(last.properties.duration_tracked_ms, 7200000);
        assert.equal(last.properties.client_track_timestamp - first.properties.client_track_timestamp, 7200000, name);
        const [pageNow, tzo] = run.posts[0].page;
        if (pageAt === null) assert.ok(Math.abs(pageNow - Date.now()) < slack, name);
        else assert.ok(Math.abs(pageNow - pageAt) < slack, name);
        if (opts.timeZone) assert.equal(tzo, 300, name); // New York in March, inside the send
        assert.ok(run.restored, name);
    }
});

test("the system clock refuses a clock that's off unless forced", async () => {
    const templates = await loadTemplates();
    const { text } = renderFirstHeartbeat({ game: FH_GAME, firstMs: FH_FIRST, hours: 2, backdate: false, clock: "system" }, templates);
    const run = await runFirstHeartbeat(text);
    assert.equal(run.posts.length, 0);
    assert.ok(run.logs.some(line => /System clock reads/.test(line)));
    await run.ctx.window.__firstHeartbeat.run({ force: true });
    assert.equal(run.posts.length, 1);
});

test("the page clock shift fakes local time in a time zone, then restores it", async () => {
    const templates = await loadTemplates();
    const { text } = renderFirstHeartbeat({ game: FH_GAME, firstMs: FH_FIRST, hours: 2, backdate: false, clock: "page", timeZone: "America/New_York" }, templates);
    const { ctx } = await runFirstHeartbeat(text);
    const before = vm.runInContext("[Date, Intl.DateTimeFormat, Date.prototype.getHours, Date.prototype.toString]", ctx);
    const r = vm.runInContext(`(() => {
        const restore = window.__firstHeartbeat.shiftClock(${FH_FIRST}, "America/New_York");
        try {
            const d = new Date();
            const s = new Date(${FH_FIRST});
            s.setHours(23, 15);
            return {
                string: d.toString().replace(/:\\d\\d GMT/, ":SS GMT"),
                call: Date().slice(0, 21),
                fields: [d.getFullYear(), d.getMonth(), d.getDate(), d.getDay(), d.getHours(), d.getMinutes()].join(","),
                tzo: [d.getTimezoneOffset(), new Date(Date.UTC(2019, 6, 1)).getTimezoneOffset()].join(","),
                parse: [Date.parse("2019-03-05T10:00"), Date.parse("2019-03-05"), Date.parse("2019-03-05T10:00Z"), new Date(2019, 2, 5, 10).getTime()].join(","),
                setHours: s.toISOString(),
                locale: new Date(${FH_FIRST}).toLocaleTimeString("en-US").replace(/\\u202f/g, " "),
                zone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
                format: new Intl.DateTimeFormat("en-US").format(),
                same: (d instanceof Date) && d.constructor === Date
            };
        } finally { restore(); }
    })()`, ctx);
    assert.equal(r.string, "Tue Mar 05 2019 14:30:SS GMT-0500 (Eastern Standard Time)");
    assert.equal(r.call, "Tue Mar 05 2019 14:30");
    assert.equal(r.fields, "2019,2,5,2,14,30");
    assert.equal(r.tzo, "300,240");
    assert.equal(r.parse, [Date.UTC(2019, 2, 5, 15), Date.UTC(2019, 2, 5), Date.UTC(2019, 2, 5, 10), Date.UTC(2019, 2, 5, 15)].join(","));
    assert.equal(r.setHours, "2019-03-06T04:15:00.000Z");
    assert.equal(r.locale, "2:30:00 PM");
    assert.equal(r.zone, "America/New_York");
    assert.equal(r.format, "3/5/2019");
    assert.ok(r.same);
    const after = vm.runInContext("[Date, Intl.DateTimeFormat, Date.prototype.getHours, Date.prototype.toString]", ctx);
    assert.ok(before.every((v, i) => v === after[i]));
});
