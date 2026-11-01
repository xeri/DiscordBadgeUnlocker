// Unit tests for the shared logic (core.mjs) and script rendering (templates.mjs). No dependencies.
//   npm test
// The generated scripts themselves are exercised end to end by `npm run verify`.

import test from "node:test";
import assert from "node:assert/strict";
import {
    BADGE_TIERS, TIERS, catalogIndex, countByVibe, fitTier, formatCount, formatHours, minHours, normalizeCatalog,
    normalizeSelection, parseCatalog, pickFromRanking, pickRandom, randomPool, resolveSelection, scaleTo, searchCatalog,
    sendGames, sendHours, serializeCatalog, splitEvenly, sumHours, summarize, tierAim, tierFor, validateTable, vibesFor
} from "../skills/discord-badge-unlocker/scripts/core.mjs";
import { OUTPUTS, loadTemplates, normalizeOptions, renderScripts } from "../skills/discord-badge-unlocker/scripts/templates.mjs";

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
    assert.deepEqual(vibesFor(["Cozy", "Farming Sim"]), ["cozy", "builder"]);
    assert.deepEqual(pickFromRanking(ranking, { vibe: "cozy" }).map(g => g.id), ["2"]);
    assert.deepEqual(pickFromRanking(ranking, { vibe: "popular", count: 2, skipIds: new Set(["1"]) }).map(g => g.id), ["2", "3"]);
    assert.deepEqual(pickFromRanking(ranking, { vibe: "nope" }), []);
    assert.equal(countByVibe(ranking).popular, 4);
    assert.equal(countByVibe(ranking).friends, 1);
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
