#!/usr/bin/env node
// Runs the three generated scripts inside a mocked Discord client (Node vm) and checks what they send.
//
//   node verify.mjs <out-dir> [--verbose]
//
// <out-dir> is a folder written by `build.mjs build` (the three .js files plus table.json).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { loadTemplates, OUTPUTS, renderScripts } from "./templates.mjs";

const args = process.argv.slice(2);
const dir = args.find(arg => !arg.startsWith("--"));
const verbose = args.includes("--verbose");
if (!dir) {
    console.error("Usage: node verify.mjs <out-dir> [--verbose]");
    process.exit(1);
}

const results = [];
const pass = (name, detail = "") => results.push({ level: "pass", name, detail });
const fail = (name, detail = "") => results.push({ level: "fail", name, detail });
const warn = (name, detail = "") => results.push({ level: "warn", name, detail });
const check = (ok, name, detail) => (ok ? pass(name, detail) : fail(name, detail));

const table = JSON.parse(await readFile(join(dir, "table.json"), "utf8"));
const scripts = {};
for (const output of OUTPUTS) {
    scripts[output.key] = { ...output, text: await readFile(join(dir, output.file), "utf8") };
}
const KEYS = OUTPUTS.map(output => output.key);
const ids = table.games.map(game => game.id);
const expectedMs = Math.round(table.totalHours * 10) * 360000;
const dryRun = table.options?.dryRun === true;
const keepRotating = table.options?.variety?.keepRotating === true;

// ---------- static checks ----------

for (const script of Object.values(scripts)) {
    try {
        new vm.Script(script.text, { filename: script.file });
        pass(`${script.file} parses`);
    } catch (error) {
        fail(`${script.file} parses`, error.message);
    }
    check(!script.text.includes("Math.random"), `${script.file} has no Math.random`);
}

const START = "    // ===== Game table";
const END = "    // ===== End of game table =====";
const blocks = Object.values(scripts).map(script => {
    const a = script.text.indexOf(START);
    const b = script.text.indexOf(END);
    return a >= 0 && b > a ? script.text.slice(a, b + END.length) : null;
});
check(blocks.every(Boolean) && blocks.every(block => block === blocks[0]),
    "Game table block is byte-identical in all three scripts");

if (blocks[0]) {
    const parsed = vm.runInNewContext(`${blocks[0]}\n;({ GAMES, TOTAL_HOURS, EXPECTED_COUNT, TRACK_START_MS })`, { window: {} });
    const same = parsed.GAMES.length === table.games.length && parsed.GAMES.every((game, i) => {
        const row = table.games[i];
        return game.id === row.id && game.name === row.name && game.exe === row.exe && game.hours === row.hours;
    });
    check(same, "Game table matches table.json", `${parsed.GAMES.length} rows`);
    check(parsed.TOTAL_HOURS === table.totalHours && parsed.EXPECTED_COUNT === table.count,
        "TOTAL_HOURS and EXPECTED_COUNT match table.json", `${parsed.TOTAL_HOURS}h, ${parsed.EXPECTED_COUNT} games`);
}

try {
    const rendered = renderScripts(table.games, { trackStart: table.trackStart, options: table.options }, await loadTemplates());
    check(KEYS.every(key => rendered[key].text === scripts[key].text),
        "Re-rendering table.json gives byte-identical scripts");
} catch (error) {
    fail("Re-rendering table.json gives byte-identical scripts", error.message);
}

// ---------- mocked Discord client ----------

function createDiscord({ userId = "111111111111111111", storage = null } = {}) {
    const env = { userId, username: "tester" };
    const posts = [];
    const logs = [];
    const dispatched = [];
    const live = new Map();
    const pendingLong = new Map();
    let timerId = 0;

    const store = storage ?? new Map();
    const localStorage = {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(key, String(value)); },
        removeItem: key => { store.delete(key); },
        key: i => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; }
    };

    // Short delays (batch gaps, auto-start) run right away; long ones (the presence rotation) never fire.
    const setTimeoutFake = (fn, ms = 0, ...rest) => {
        const id = ++timerId;
        if (ms > 60000) {
            pendingLong.set(id, fn);
        } else {
            live.set(id, setImmediate(() => { live.delete(id); fn(...rest); }));
        }
        return id;
    };
    const clearTimeoutFake = id => {
        pendingLong.delete(id);
        const handle = live.get(id);
        if (handle) clearImmediate(handle);
        live.delete(id);
    };

    const reply = (status, json) => ({
        ok: status >= 200 && status < 300,
        status,
        body: json,
        headers: { get: () => null },
        json: async () => json,
        text: async () => (json == null ? "" : JSON.stringify(json))
    });

    const httpClient = {
        async get({ url }) {
            if (url === "/users/@me") return reply(200, { id: env.userId, username: env.username, analytics_token: "analytics-token" });
            return reply(404, null);
        },
        async post({ url, body }) {
            if (url !== "/science") return reply(404, null);
            posts.push({ via: "http-client", events: body.events });
            return reply(204, null);
        },
        async del() { return reply(204, null); }
    };

    const runStore = {
        getName: () => "RunningGameStore",
        getRunningGames: () => [],
        getGameForPID: () => null,
        getVisibleGame: () => null
    };
    const original = { getRunningGames: runStore.getRunningGames, getGameForPID: runStore.getGameForPID };
    const authStore = { getName: () => "AuthenticationStore", getToken: () => "mock-token", getId: () => env.userId };
    const userStore = { getName: () => "UserStore", getCurrentUser: () => ({ id: env.userId }) };
    const dispatcher = { _subscriptions: { RUNNING_GAMES_CHANGE: [] }, dispatch: action => dispatched.push(action.type), subscribe() {} };

    const modules = { 7: { HTTP: httpClient } };
    const requireFn = id => modules[id];
    requireFn.m = { 7: function () { /* HTTPUtils */ } };
    requireFn.c = {
        1: { exports: { default: runStore } },
        2: { exports: authStore },
        3: { exports: { Z: userStore } },
        4: { exports: dispatcher },
        7: { exports: modules[7] }
    };

    const sandbox = {
        console: {
            log: (...a) => logs.push(a.join(" ")),
            warn: (...a) => logs.push("WARN " + a.join(" ")),
            error: (...a) => logs.push("ERROR " + a.join(" "))
        },
        crypto: globalThis.crypto,
        TextEncoder,
        btoa,
        atob,
        navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) discord/1.0.9253" },
        localStorage,
        setTimeout: setTimeoutFake,
        clearTimeout: clearTimeoutFake,
        addEventListener: () => {},
        webpackChunkdiscord_app: {
            push: chunk => (typeof chunk[2] === "function" ? chunk[2](requireFn) : undefined),
            pop: () => {}
        },
        async fetch(url, init = {}) {
            if (String(url).startsWith("/api/v9/users/@me")) return reply(200, { id: env.userId, analytics_token: "analytics-token" });
            if (url === "/api/v9/science") {
                posts.push({ via: "fetch", events: JSON.parse(init.body).events });
                return reply(204, null);
            }
            return reply(404, null);
        }
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);

    async function run(key) {
        const script = scripts[key];
        const before = posts.length;
        await vm.runInContext(script.text, context, { filename: script.file });
        for (let i = 0; i < 2000 && !sandbox[script.ns]?.lastRun; i++) await new Promise(setImmediate);
        const lastRun = sandbox[script.ns]?.lastRun;
        if (lastRun) await lastRun.catch(() => {});
        for (let i = 0; i < 5; i++) await new Promise(setImmediate);
        return posts.slice(before).flatMap(post => post.events);
    }

    return { env, sandbox, posts, logs, dispatched, store, run, runStore, original, pendingLong };
}

function finals(events) {
    return events.filter(e => e.type === "running_game_heartbeat" && e.properties.final_heartbeat);
}

function checkFullSend(name, events) {
    const done = finals(events);
    const sentIds = done.map(e => e.properties.game_id);
    const sumMs = done.reduce((total, e) => total + e.properties.duration_tracked_ms, 0);
    const unique = new Set(sentIds);
    const sameSet = unique.size === ids.length && sentIds.length === ids.length && ids.every(id => unique.has(id));
    const perGame = table.games.every(game => {
        const event = done.find(e => e.properties.game_id === game.id);
        return event && event.properties.duration_tracked_ms === Math.round(game.hours * 3600 * 1000);
    });
    const launches = events.filter(e => e.type === "launch_game").length;
    check(sameSet && perGame && sumMs === expectedMs && launches === ids.length && events.length === ids.length * 3,
        `${name}: sends every game once with its hours`,
        `${sentIds.length} games, ${(sumMs / 3600000).toFixed(1)}h, ${events.length} events`);
    return { sumMs, done };
}

const VERBOSE_LOGS = [];

// ---------- dynamic checks ----------

if (dryRun) {
    for (const key of KEYS) {
        const discord = createDiscord();
        const events = await discord.run(key);
        check(events.length === 0 && discord.store.size === 0, `${scripts[key].file}: dry run sends nothing and saves nothing`);
        if (verbose) VERBOSE_LOGS.push([key, discord.logs]);
    }
} else {
    // Each script alone, then every script after it (including itself): the second run must send nothing.
    for (const first of KEYS) {
        for (const second of KEYS) {
            const discord = createDiscord();
            const a = await discord.run(first);
            if (second === first) {
                const { done } = checkFullSend(scripts[first].file, a);
                if (table.trackStart) {
                    const startMs = Date.parse(`${table.trackStart}T00:00:00Z`);
                    const early = done.filter(e => e.properties.client_track_timestamp - e.properties.duration_tracked_ms < startMs).length;
                    if (early) warn(`${scripts[first].file}: ${early} sessions start before ${table.trackStart}`);
                    else pass(`${scripts[first].file}: every session starts after ${table.trackStart}`);
                }
            } else if (finals(a).length !== ids.length) {
                fail(`${scripts[first].file} → ${scripts[second].file}: first run sent everything`, `${finals(a).length} games`);
            }
            if (first === "variety" && second === first) {
                const instance = discord.sandbox.__multiGamePresence;
                if (keepRotating) {
                    check(!!instance && discord.runStore.getRunningGames !== discord.original.getRunningGames,
                        "multi-game-presence.js: keeps rotating after the claim (keepRotating)");
                    instance?.stop();
                } else {
                    check(!instance && discord.runStore.getRunningGames === discord.original.getRunningGames &&
                        discord.runStore.getGameForPID === discord.original.getGameForPID && discord.pendingLong.size === 0,
                    "multi-game-presence.js: stops the rotation and restores the store after the claim");
                }
            }
            const b = await discord.run(second);
            check(b.length === 0, `${scripts[first].file} then ${scripts[second].file}: second run sends nothing`,
                b.length ? `${finals(b).length} games re-sent` : "");
            if (verbose) VERBOSE_LOGS.push([`${first}+${second}`, discord.logs]);
        }
    }

    // Different Discord account in the same client: its own history.
    {
        const discord = createDiscord({ userId: "111111111111111111" });
        await discord.run("main");
        discord.env.userId = "222222222222222222";
        const other = await discord.run("variety");
        check(finals(other).length === ids.length, "Another account in the same client still gets every game");
        const again = await discord.run("gameTime");
        check(again.length === 0, "…and its history is kept separately");
    }

    // Games sent by the older fixed-list scripts are skipped.
    {
        const legacy = new Map([["__badgePresenceFixed150_claimed_ids", JSON.stringify(ids.slice(0, 3))]]);
        const discord = createDiscord({ storage: legacy });
        const events = await discord.run("main");
        check(finals(events).length === ids.length - Math.min(3, ids.length), "Legacy fixed-list history is respected",
            `${finals(events).length}/${ids.length} sent`);
    }

    // resetClaimed() makes the next run send everything again.
    {
        const discord = createDiscord();
        await discord.run("main");
        const api = discord.sandbox.__discordBadgeUnlocker;
        api.resetClaimed();
        const before = discord.posts.length;
        await api.run();
        const events = discord.posts.slice(before).flatMap(post => post.events);
        check(finals(events).length === ids.length, "resetClaimed() lets the next run resend everything");
    }
}

// ---------- report ----------

const marks = { pass: "✓", warn: "!", fail: "✗" };
for (const r of results) console.log(`${marks[r.level]} ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
if (verbose) for (const [name, logs] of VERBOSE_LOGS) console.log(`\n--- ${name} ---\n${logs.join("\n")}`);
const failed = results.filter(r => r.level === "fail").length;
console.log(`\n${results.length - failed}/${results.length} checks passed` +
    ` (${table.count} games, ${table.totalHours}h${dryRun ? ", dry run" : ""}).`);
process.exit(failed ? 1 : 0);
