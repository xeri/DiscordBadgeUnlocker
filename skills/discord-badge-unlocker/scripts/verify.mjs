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
// Discord drops a session over 24h, so the scripts split games into sessions of at most 23h.
const MAX_SESSION_MS = 23 * 3600 * 1000;
const expectedSessions = table.games.reduce((total, game) =>
    total + Math.max(1, Math.ceil(Math.round(game.hours * 3600 * 1000) / MAX_SESSION_MS)), 0);
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

const CLIENT_START = "    // ===== Discord client";
const CLIENT_END = "    // ===== End of Discord client =====";
const clientBlocks = Object.values(scripts).map(script => {
    const a = script.text.indexOf(CLIENT_START);
    const b = script.text.indexOf(CLIENT_END);
    return a >= 0 && b > a ? script.text.slice(a, b + CLIENT_END.length) : null;
});
check(clientBlocks.every(Boolean) && clientBlocks.every(block => block === clientBlocks[0]),
    "Discord client block is byte-identical in all three scripts");

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

// consent: what /users/@me/consent says ("error" fails the request). science(n): the n-th /science
// answer, a status or { status, retryAfter }; status 0 never answers. hideLocalStorage: Discord's
// deleted window.localStorage (the scripts reach it through an iframe). hideHttpUtils: the HTTP client
// can only be found among cached module exports. runtimes: "two" (a client mod's smaller webpack runtime
// answers the chunk push first) or "vencord" (no chunk push, only Vencord's wreq and RestAPI).
function createDiscord({
    userId = "111111111111111111", storage = null, consent = { personalization: true, usage: true },
    science = () => 204, hideLocalStorage = false, hideHttpUtils = false, runtimes = "one"
} = {}) {
    const env = { userId, username: "tester" };
    let scienceCalls = 0;
    let meCalls = 0;
    let tokenReads = 0;
    let fetchCalls = 0;
    const attempts = []; // every /science body, accepted or not
    const frames = { created: 0, removed: 0 };
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

    const consentBody = () => ({
        personalization: { consented: consent.personalization }, usage_statistics: { consented: consent.usage }
    });
    const scienceAnswer = () => {
        const answer = science(scienceCalls++);
        return typeof answer === "number" ? { status: answer } : answer;
    };

    // Discord's own client rejects anything that isn't 2xx.
    const httpClient = {
        async get({ url }) {
            if (url === "/users/@me") {
                meCalls += 1;
                return reply(200, { id: env.userId, username: env.username, analytics_token: `analytics-token-${meCalls}` });
            }
            if (url === "/users/@me/consent") {
                if (consent === "error") throw Object.assign(new Error("HTTP 500"), { status: 500 });
                return reply(200, consentBody());
            }
            return reply(404, null);
        },
        async post({ url, body }) {
            if (url !== "/science") return reply(404, null);
            attempts.push({ token: body.token, events: body.events });
            const { status, retryAfter } = scienceAnswer();
            if (status === 0) throw new Error("socket hang up");
            if (status >= 300) throw Object.assign(new Error(`HTTP ${status}`), { status, body: retryAfter ? { retry_after: retryAfter } : {} });
            posts.push({ via: "http-client", events: body.events });
            return reply(status, null);
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
    const authStore = { getName: () => "AuthenticationStore", getToken: () => { tokenReads += 1; return "mock-token"; }, getId: () => env.userId };
    const userStore = { getName: () => "UserStore", getCurrentUser: () => ({ id: env.userId }) };
    const dispatcher = { _subscriptions: { RUNNING_GAMES_CHANGE: [] }, dispatch: action => dispatched.push(action.type), subscribe() {} };

    // Discord's translated messages: a Proxy that hands back a function for any name and warns about
    // unknown ones. It comes first, so a lookup without a guard picks it.
    const i18n = new Proxy({}, {
        get: (_, key) => {
            if (typeof key !== "string" || key === "then") return undefined;
            sandbox.console.warn(`Requested message ${key} does not have a value in the requested locale`);
            return () => "";
        }
    });

    // Another webpack runtime with only a few modules, like a client mod's.
    const smallRequire = () => undefined;
    smallRequire.m = {};
    smallRequire.c = { 0: { exports: { messages: i18n } } };

    const modules = { 7: { HTTP: httpClient } };
    const requireFn = id => modules[id];
    requireFn.m = hideHttpUtils ? {} : { 7: function () { /* HTTPUtils */ } };
    requireFn.c = {
        0: { exports: { messages: i18n } },
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
        localStorage: hideLocalStorage ? undefined : localStorage,
        document: {
            createElement: () => {
                frames.created += 1;
                return { style: {}, contentWindow: { localStorage }, remove() { frames.removed += 1; } };
            },
            body: { appendChild() {} }
        },
        setTimeout: setTimeoutFake,
        clearTimeout: clearTimeoutFake,
        addEventListener: () => {},
        webpackChunkdiscord_app: {
            push: chunk => {
                if (typeof chunk[2] !== "function") return undefined;
                if (runtimes === "two") chunk[2](smallRequire);
                return chunk[2](requireFn);
            },
            pop: () => {}
        },
        // The scripts send everything through Discord's HTTP client; these answers only catch regressions.
        async fetch(url, init = {}) {
            fetchCalls += 1;
            if (String(url).startsWith("/api/v9/users/@me/consent")) {
                return consent === "error" ? reply(500, null) : reply(200, consentBody());
            }
            if (String(url).startsWith("/api/v9/users/@me")) return reply(200, { id: env.userId, analytics_token: "analytics-token" });
            if (url === "/api/v9/science") {
                const { status, retryAfter } = scienceAnswer();
                if (status === 0) throw new Error("Failed to fetch");
                if (status >= 300) return reply(status, retryAfter ? { retry_after: retryAfter } : { message: "nope" });
                posts.push({ via: "fetch", events: JSON.parse(init.body).events });
                return reply(status, null);
            }
            return reply(404, null);
        }
    };
    sandbox.window = sandbox;
    if (runtimes === "vencord") {
        delete sandbox.webpackChunkdiscord_app;
        requireFn.m = {};
        delete requireFn.c[7];
        sandbox.Vencord = { Webpack: { wreq: requireFn, Common: { RestAPI: httpClient } } };
    }
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

    return { env, sandbox, posts, attempts, logs, dispatched, store, run, runStore, original, pendingLong, frames,
        get scienceCalls() { return scienceCalls; }, get meCalls() { return meCalls; },
        get tokenReads() { return tokenReads; }, get fetchCalls() { return fetchCalls; } };
}

function finals(events) {
    return events.filter(e => e.type === "running_game_heartbeat" && e.properties.final_heartbeat);
}

// Games with at least one session in `events`.
const gamesIn = events => new Set(finals(events).map(e => e.properties.game_id)).size;

function checkFullSend(name, events) {
    const done = finals(events);
    const byGame = new Map();
    for (const e of done) byGame.set(e.properties.game_id, [...(byGame.get(e.properties.game_id) ?? []), e]);
    const sumMs = done.reduce((total, e) => total + e.properties.duration_tracked_ms, 0);
    const sameSet = byGame.size === ids.length && ids.every(id => byGame.has(id));
    const perGame = table.games.every(game =>
        (byGame.get(game.id) ?? []).reduce((total, e) => total + e.properties.duration_tracked_ms, 0) ===
            Math.round(game.hours * 3600 * 1000));
    const launches = events.filter(e => e.type === "launch_game").length;
    check(sameSet && perGame && sumMs === expectedMs && launches === done.length && events.length === done.length * 3,
        `${name}: sends every game once with its hours`,
        `${byGame.size} games, ${(sumMs / 3600000).toFixed(1)}h, ${done.length} sessions, ${events.length} events`);

    // Each session: an initial heartbeat, then a final one its duration later, 23h at most.
    // A game's sessions follow one another without overlapping.
    const initials = new Map(events
        .filter(e => e.type === "running_game_heartbeat" && e.properties.initial_heartbeat)
        .map(e => [e.properties.game_session_id, e]));
    const whole = initials.size === done.length && done.every(e => {
        const first = initials.get(e.properties.game_session_id);
        const ms = e.properties.duration_tracked_ms;
        return first && first.properties.game_id === e.properties.game_id && ms > 0 && ms <= MAX_SESSION_MS &&
            e.properties.client_track_timestamp - first.properties.client_track_timestamp === ms;
    });
    const apart = [...byGame.values()].every(list => {
        const spans = list.map(e => [e.properties.client_track_timestamp - e.properties.duration_tracked_ms, e.properties.client_track_timestamp])
            .sort((a, b) => a[0] - b[0]);
        return spans.every((span, i) => i === 0 || span[0] > spans[i - 1][1]);
    });
    const longest = Math.max(...done.map(e => e.properties.duration_tracked_ms));
    check(whole && apart && done.length === expectedSessions,
        `${name}: every session is 23h or less, a game's sessions don't overlap`,
        `${done.length}/${expectedSessions} sessions, longest ${(longest / 3600000).toFixed(2)}h`);
    return { sumMs, done };
}

// Requests stay as big as before the split: batchSize games and batchSize × 3 events, unless one game
// needs more on its own. A game's sessions all go in the same request.
function checkRequests(script, posts) {
    const size = script.engine === "variety" ? table.options?.variety?.batchSize : table.options?.batchSize;
    const where = new Map();
    let together = true;
    posts.forEach((post, i) => {
        for (const id of new Set(finals(post.events).map(e => e.properties.game_id))) {
            if (where.has(id)) together = false;
            where.set(id, i);
        }
    });
    const sized = posts.every(post => {
        const games = gamesIn(post.events);
        return games <= size && (post.events.length <= size * 3 || games === 1);
    });
    check(Number.isInteger(size) && sized && together,
        `${script.file}: requests hold at most ${size} games and ${size * 3} events, a game's sessions in one`,
        `${posts.length} requests, largest ${Math.max(...posts.map(post => post.events.length))} events`);
}

const VERBOSE_LOGS = [];

// ---------- dynamic checks ----------

if (dryRun) {
    for (const key of KEYS) {
        const discord = createDiscord();
        const events = await discord.run(key);
        check(events.length === 0 && discord.store.size === 0 && discord.fetchCalls === 0 && discord.tokenReads === 0,
            `${scripts[key].file}: dry run sends nothing and saves nothing`);
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
                checkRequests(scripts[first], discord.posts);
                if (table.trackStart) {
                    const startMs = Date.parse(`${table.trackStart}T00:00:00Z`);
                    const early = done.filter(e => e.properties.client_track_timestamp - e.properties.duration_tracked_ms < startMs).length;
                    if (early) warn(`${scripts[first].file}: ${early} sessions start before ${table.trackStart}`);
                    else pass(`${scripts[first].file}: every session starts after ${table.trackStart}`);
                }
            } else if (gamesIn(a) !== ids.length) {
                fail(`${scripts[first].file} → ${scripts[second].file}: first run sent everything`, `${gamesIn(a)} games`);
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
                b.length ? `${gamesIn(b)} games re-sent` : "");
            if (verbose) VERBOSE_LOGS.push([`${first}+${second}`, discord.logs]);
        }
    }

    // Different Discord account in the same client: its own history.
    {
        const discord = createDiscord({ userId: "111111111111111111" });
        await discord.run("main");
        discord.env.userId = "222222222222222222";
        const other = await discord.run("variety");
        check(gamesIn(other) === ids.length, "Another account in the same client still gets every game");
        const again = await discord.run("gameTime");
        check(again.length === 0, "…and its history is kept separately");
    }

    // Games sent by the older fixed-list scripts are skipped.
    {
        const legacy = new Map([["__badgePresenceFixed150_claimed_ids", JSON.stringify(ids.slice(0, 3))]]);
        const discord = createDiscord({ storage: legacy });
        const events = await discord.run("main");
        check(gamesIn(events) === ids.length - Math.min(3, ids.length), "Legacy fixed-list history is respected",
            `${gamesIn(events)}/${ids.length} sent`);
    }

    // The Rich Presence uses the real Dispatcher, not Discord's translation Proxy.
    {
        const discord = createDiscord();
        await discord.run("variety");
        check(discord.dispatched.includes("RUNNING_GAMES_CHANGE") && discord.dispatched.includes("LOCAL_ACTIVITY_UPDATE") &&
            !discord.logs.some(line => /Requested message/.test(line)),
        "multi-game-presence.js: presence goes to the real Dispatcher, not the translation Proxy");
    }

    // Everything goes through Discord's own HTTP client: no fetch, and the token is never read.
    for (const key of KEYS) {
        const discord = createDiscord();
        const events = await discord.run(key);
        check(gamesIn(events) === ids.length && discord.posts.every(post => post.via === "http-client") &&
            discord.fetchCalls === 0 && discord.tokenReads === 0,
        `${scripts[key].file}: sends through Discord's HTTP client, never reads the token`);
    }

    // The HTTP client is found among cached exports, past the translation Proxy.
    for (const key of KEYS) {
        const discord = createDiscord({ hideHttpUtils: true });
        const events = await discord.run(key);
        check(discord.posts.length > 0 && gamesIn(events) === ids.length,
            `${scripts[key].file}: finds Discord's HTTP client past the translation Proxy`);
    }

    // Client mods: a smaller webpack runtime answers the chunk push first, or there's only Vencord.
    for (const [runtimes, how] of [["two", "past a smaller webpack runtime"], ["vencord", "through Vencord's wreq and RestAPI"]]) {
        for (const key of KEYS) {
            const discord = createDiscord({ runtimes });
            const events = await discord.run(key);
            check(gamesIn(events) === ids.length, `${scripts[key].file}: finds Discord's modules ${how}`);
        }
    }

    // A 401/403 gets one fresh analytics token and the same events again.
    for (const key of KEYS) {
        const discord = createDiscord({ science: n => (n === 0 ? 401 : 204) });
        const events = await discord.run(key);
        const done = finals(events);
        const [first, second] = discord.attempts;
        check(gamesIn(events) === ids.length && done.length === expectedSessions &&
            new Set(done.map(e => e.properties.game_session_id)).size === done.length &&
            !!first && !!second && first.token !== second.token && JSON.stringify(first.events) === JSON.stringify(second.events),
        `${scripts[key].file}: after a 401, resends the same events with a fresh analytics token`);
    }
    // A second 401/403 drops only that batch, and it isn't marked as sent, so the next run sends it.
    for (const key of KEYS) {
        const discord = createDiscord({ science: n => (n < 2 ? 403 : 204) });
        const a = new Set(finals(await discord.run(key)).map(e => e.properties.game_id));
        discord.sandbox[scripts[key].ns]?.stop?.();
        const b = new Set(finals(await discord.run(key)).map(e => e.properties.game_id));
        check(a.size > 0 && a.size < ids.length && a.size + b.size === ids.length && [...b].every(id => !a.has(id)),
            `${scripts[key].file}: a second 403 drops that batch only; the next run sends it`, `${a.size} + ${b.size} games`);
    }
    // The refresh never resends under another account.
    {
        let discord = null;
        discord = createDiscord({ science: n => {
            if (n === 0) discord.env.userId = "222222222222222222";
            return n === 0 ? 401 : 204;
        } });
        const events = await discord.run("main");
        check(gamesIn(events) < ids.length && discord.attempts.length > 0 &&
            discord.logs.some(line => /account changed/.test(line)),
        "After a 401, a batch isn't resent if the logged-in account changed");
    }

    // "Use data to personalize my Discord experience" off: nothing is sent or marked as sent.
    for (const key of KEYS) {
        const discord = createDiscord({ consent: { personalization: false, usage: true } });
        const events = await discord.run(key);
        check(events.length === 0 && discord.scienceCalls === 0 && discord.store.size === 0 &&
            discord.logs.some(line => /personalize my Discord experience" is off/.test(line)),
        `${scripts[key].file}: stops before sending when personalization is off`);
    }
    {
        const discord = createDiscord({ consent: { personalization: false, usage: true } });
        await discord.run("main");
        const before = discord.posts.length;
        await discord.sandbox.__discordBadgeUnlocker.run({ force: true });
        check(gamesIn(discord.posts.slice(before).flatMap(post => post.events)) === ids.length, "run({ force: true }) sends anyway");
    }
    for (const key of KEYS) {
        const discord = createDiscord({ consent: "error" });
        const events = await discord.run(key);
        check(gamesIn(events) === ids.length && discord.logs.some(line => /Couldn't read/.test(line)),
            `${scripts[key].file}: setting unreadable: warns, still sends`);
    }

    // Rate limits and requests that get no answer are retried with the same events.
    for (const key of KEYS) {
        const discord = createDiscord({ science: n => (n === 1 || n === 2 ? { status: 429, retryAfter: 1 } : n === 4 ? 0 : 204) });
        const events = await discord.run(key);
        const done = finals(events);
        const sessions = new Set(done.map(e => e.properties.game_session_id)).size;
        check(gamesIn(events) === ids.length && sessions === done.length && done.length === expectedSessions &&
            discord.logs.some(line => /Rate limited/.test(line)),
        `${scripts[key].file}: retries 429s and lost requests, every session once`, `${gamesIn(events)} games, ${done.length} sessions`);
    }

    // Discord hides window.localStorage: the history goes through a hidden iframe and survives a reload.
    {
        const shared = new Map();
        const discord = createDiscord({ storage: shared, hideLocalStorage: true });
        await discord.run("main");
        const saved = JSON.parse(shared.get("__discordBadgeUnlocker_claimed_ids:111111111111111111") ?? "[]");
        discord.sandbox.__discordBadgeUnlocker.stop();
        await new Promise(setImmediate);
        check(saved.length === ids.length && discord.frames.created === 1 && discord.frames.removed === 1,
            "Hidden localStorage: history saved through an iframe, removed on stop()");
        const reloaded = createDiscord({ storage: shared, hideLocalStorage: true });
        const events = await reloaded.run("variety");
        check(events.length === 0, "…and after a reload nothing is sent again");
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
        check(gamesIn(events) === ids.length, "resetClaimed() lets the next run resend everything");
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
