// Renders the three console scripts from the two engine templates in ./templates/, each with the
// shared Discord client block (templates/client.js). Output is deterministic: the same table +
// options always give byte-identical text.

import { ORIGINAL_REPO, STREAM_MAX_HOURS, formatCount, formatHours, roundHours, streamEta, sumHours, toTenths, trackStartMs } from "./core.mjs";

export const MACHINE_GUID = "b5a79402-959c-4861-a579-2821dfbb3c2b";
export const CLAIMED_KEY = "__discordBadgeUnlocker_claimed_ids";
export const LEGACY_CLAIMED_KEYS = Object.freeze(["__badgePresenceFixed150_claimed_ids"]);

export const TEMPLATE_FILES = Object.freeze({
    telemetry: "templates/telemetry.js",
    variety: "templates/variety.js",
    firstHeartbeat: "templates/first-heartbeat.js", // Danger Zone test script, rendered by renderFirstHeartbeat()
    stream: "templates/stream.js", // Streaming zone script, rendered by renderStream()
    client: "templates/client.js" // Discord client block, byte-identical in every script
});

export const OUTPUTS = Object.freeze([
    { key: "main", file: "discord-badge-unlocker.js", engine: "telemetry", ns: "__discordBadgeUnlocker", label: "[Badge Unlocker]",
        title: "main script (Game Variety + Game Time badges)" },
    { key: "variety", file: "multi-game-presence.js", engine: "variety", ns: "__multiGamePresence", label: "[Multi Game Presence]",
        title: "Game Variety script with Rich Presence rotation (advanced)" },
    { key: "gameTime", file: "game-time-presence.js", engine: "telemetry", ns: "__gameTimePresence", label: "[Game Time]",
        title: "Game Time script (advanced)" }
]);

export const DEFAULT_OPTIONS = Object.freeze({
    batchSize: 25,
    delayMs: 450,
    dryRun: false,
    variety: Object.freeze({ batchSize: 5, delayMs: 4000, rotateMinutes: 30, keepRotating: false })
});

const int = (value, fallback, min, max) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// Option limits. `uncapped` (the page's Danger Zone) widens them to what the scripts can still run with.
const LIMITS = {
    capped: { batchSize: 100, delayMs: 60000, varietyBatchSize: 50, rotateMinutes: 1440 },
    uncapped: { batchSize: 100000, delayMs: 86400000, varietyBatchSize: 100000, rotateMinutes: 525600 }
};

export function normalizeOptions(input = {}, { uncapped = false } = {}) {
    const o = input && typeof input === "object" ? input : {};
    const v = o.variety && typeof o.variety === "object" ? o.variety : {};
    const d = DEFAULT_OPTIONS;
    const max = uncapped ? LIMITS.uncapped : LIMITS.capped;
    return {
        batchSize: int(o.batchSize, d.batchSize, 1, max.batchSize),
        delayMs: int(o.delayMs, d.delayMs, 0, max.delayMs),
        dryRun: o.dryRun === true,
        variety: {
            batchSize: int(v.batchSize, d.variety.batchSize, 1, max.varietyBatchSize),
            delayMs: int(v.delayMs, d.variety.delayMs, 0, max.delayMs),
            rotateMinutes: int(v.rotateMinutes, d.variety.rotateMinutes, 1, max.rotateMinutes),
            keepRotating: v.keepRotating === true
        }
    };
}

// Template text loader: fs in Node, fetch in the browser (both relative to this module). Loads in parallel.
export async function loadTemplates() {
    const isNode = typeof process !== "undefined" && !!process.versions?.node && typeof window === "undefined";
    const readFile = isNode ? (await import("node:fs/promises")).readFile : null;
    const load = async path => {
        const url = new URL(path, import.meta.url);
        if (readFile) return readFile(url, "utf8");
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Template ${path}: HTTP ${response.status}`);
        return response.text();
    };
    const keys = Object.keys(TEMPLATE_FILES);
    const texts = await Promise.all(keys.map(key => load(TEMPLATE_FILES[key])));
    return Object.fromEntries(keys.map((key, i) => [key, texts[i]]));
}

const q = value => JSON.stringify(String(value));
const hoursLiteral = hours => roundHours(hours).toFixed(1);

function trackStartLiteral(trackStart) {
    const ms = trackStartMs(trackStart);
    if (ms == null) return "null";
    const d = new Date(ms);
    return `Date.UTC(${d.getUTCFullYear()}, ${d.getUTCMonth()}, ${d.getUTCDate()})`;
}

// The block between the two "=====" lines is byte-identical in all three scripts.
export function renderTableBlock(table, { trackStart = null } = {}) {
    const total = sumHours(table);
    const rows = table.map(row =>
        `        { id: ${q(row.id)}, name: ${q(row.name)}, exe: ${q(row.exe)}, hours: ${hoursLiteral(row.hours)} }`);
    const windowNote = trackStart
        ? `Every session should start after ${trackStart} 00:00 UTC (TRACK_START_MS).`
        : "No tracking-window check (TRACK_START_MS = null).";
    return `    // ===== Game table (generated; identical in all three scripts) =====
    // ${table.length} games, ${formatHours(total)}h total. ${windowNote}
    const TOTAL_HOURS = ${total};
    const EXPECTED_COUNT = ${table.length};
    const TRACK_START_MS = ${trackStartLiteral(trackStart)};
    const MACHINE_GUID = ${q(MACHINE_GUID)};
    const CLAIMED_KEY = ${q(CLAIMED_KEY)};
    const CLAIMED_MEMORY_KEY = "__discordBadgeUnlocker_claimed";
    const LEGACY_CLAIMED_KEYS = ${JSON.stringify(LEGACY_CLAIMED_KEYS)}; // read only: games sent by older fixed-list scripts
    const LEGACY_MEMORY_KEYS = ["__badgePresenceFixed150_claimed"];
    const GAMES = Object.freeze([
${rows.join(",\n")}
    ].map(game => Object.freeze(game)));

    function validateGames() {
        const ids = new Set(GAMES.map(game => game.id));
        const sum = GAMES.reduce((total, game) => total + game.hours, 0);
        if (GAMES.length !== EXPECTED_COUNT || ids.size !== GAMES.length) {
            throw new Error(\`\${LABEL} Game table must hold \${EXPECTED_COUNT} unique games (has \${GAMES.length}, \${ids.size} unique).\`);
        }
        if (GAMES.some(game => !Number.isFinite(game.hours) || game.hours <= 0 || !game.exe)) {
            throw new Error(\`\${LABEL} Every game needs an exe and positive hours.\`);
        }
        if (Math.abs(sum - TOTAL_HOURS) > 0.05) {
            throw new Error(\`\${LABEL} Game hours add up to \${sum.toFixed(1)}h, expected \${TOTAL_HOURS}h.\`);
        }
    }

    // Claimed history is shared by all three scripts and kept per Discord account, so running any
    // mix of them (or one twice) never sends a game twice. It's saved through getStorage() (in the
    // Discord client block), which keeps it after a reload, and mirrored on window in case that fails.
    function getClaimedSet(userId) {
        const memory = window[CLAIMED_MEMORY_KEY] ?? {};
        const ids = new Set(Array.isArray(memory[userId]) ? memory[userId] : []);
        for (const key of LEGACY_MEMORY_KEYS) {
            if (Array.isArray(window[key])) for (const id of window[key]) ids.add(String(id));
        }
        const storage = getStorage();
        for (const key of [\`\${CLAIMED_KEY}:\${userId}\`, ...LEGACY_CLAIMED_KEYS]) {
            try {
                const saved = JSON.parse(storage?.getItem(key) || "[]");
                if (Array.isArray(saved)) for (const id of saved) ids.add(String(id));
            } catch (_) {}
        }
        return ids;
    }

    function saveClaimedSet(userId, set) {
        const ids = Array.from(set);
        window[CLAIMED_MEMORY_KEY] = { ...(window[CLAIMED_MEMORY_KEY] ?? {}), [userId]: ids };
        try {
            getStorage()?.setItem(\`\${CLAIMED_KEY}:\${userId}\`, JSON.stringify(ids));
        } catch (_) {}
    }

    function resetClaimedSet() {
        delete window[CLAIMED_MEMORY_KEY];
        for (const key of LEGACY_MEMORY_KEYS) delete window[key];
        try {
            const storage = getStorage();
            if (!storage) return;
            const keys = [];
            for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (key && (key.startsWith(\`\${CLAIMED_KEY}:\`) || LEGACY_CLAIMED_KEYS.includes(key))) keys.push(key);
            }
            for (const key of keys) storage.removeItem(key);
        } catch (_) {}
    }
    // ===== End of game table =====`;
}

function renderConfig(output, options) {
    const config = output.engine === "variety"
        ? { ...options.variety, dryRun: options.dryRun } // batchSize, delayMs, rotateMinutes, keepRotating
        : { batchSize: options.batchSize, delayMs: options.delayMs, dryRun: options.dryRun };
    return [
        `const NS = ${q(output.ns)};`,
        `    const LABEL = ${q(output.label)};`,
        "    const CONFIG = Object.freeze({",
        Object.entries(config).map(([key, value]) => `        ${key}: ${value}`).join(",\n"),
        "    });"
    ].join("\n");
}

function renderHeader(output, table, trackStart, options) {
    const ns = `window.${output.ns}`;
    const total = formatHours(sumHours(table));
    const lines = [`Discord Badge Unlocker: ${output.title}`];
    lines.push(`${table.length} games, ${total}h total. ` +
        (trackStart ? `Sessions are meant to start after ${trackStart}.` : "No tracking-window check."));
    if (options.dryRun) lines.push("DRY RUN: builds every event but sends nothing.");
    lines.push("");
    lines.push("Run: Discord desktop > Ctrl+Shift+I > Console > paste > Enter.");
    lines.push("If the console asks, type: allow pasting");
    lines.push("Only the desktop app counts, and only with Settings > \"Use data to personalize");
    lines.push("my Discord experience\" on; the script checks that setting before sending.");
    lines.push("Game Time counts time from 2025-12-08 on.");
    lines.push("Discord drops any play session over 24h, so games over 23h go as back-to-back");
    lines.push("sessions of at most 23h.");
    if (output.engine === "telemetry") {
        lines.push("Sends each game once, with its hours, through Discord's own HTTP client.");
        lines.push("It never reads your token. Games already sent to this account are skipped.");
    } else {
        const rotation = options.variety.keepRotating
            ? `Shows each game as your activity for ${options.variety.rotateMinutes} min, in table order, until stop().`
            : `Shows each game as your activity (${options.variety.rotateMinutes} min each) while claiming, then stops.`;
        lines.push(rotation);
        lines.push("Sends through Discord's own HTTP client. It never reads your token.");
        lines.push("Games already sent to this account are skipped.");
    }
    lines.push("");
    lines.push("Commands:");
    const run = `${ns}.${output.key === "gameTime" ? "boost" : "run"}`;
    const commands = output.engine === "telemetry"
        ? [[`await ${run}()`, "send any games not sent yet"],
            [`await ${run}({ force: true })`, "send even if the setting reads as off"]]
        : [[`await ${ns}.claim()`, "send any games not sent yet"], [`${ns}.next()`, "show the next game"]];
    commands.push([`${ns}.resetClaimed()`, "forget what was sent (the next run resends)"], [`${ns}.stop()`, ""]);
    const width = Math.max(...commands.map(([cmd]) => cmd.length)) + 3;
    for (const [cmd, what] of commands) lines.push(`  ${what ? cmd.padEnd(width) + what : cmd}`);
    lines.push("");
    lines.push("Badges can take 24-48h to update. Run one script; they share their history.");
    lines.push("Based on everyoneexe/discord-game-badge-presence (GPL-3.0):");
    lines.push(ORIGINAL_REPO);
    return ["/*", ...lines.map(line => (line ? ` * ${line}` : " *")), " */"].join("\n");
}

function clientBlock(templates) {
    if (typeof templates?.client !== "string") throw new Error(`Template "client" was not loaded.`);
    return templates.client.trimEnd();
}

// Header, then config and the generated blocks where the template says // @@CONFIG@@.
function fill(template, header, blocks) {
    const parts = template.split("// @@CONFIG@@");
    if (parts.length !== 2 || !parts[0].includes("// @@HEADER@@")) throw new Error("Template markers missing.");
    return parts[0].replace("// @@HEADER@@", header) + blocks.join("\n\n") + parts[1];
}

// table: [{ id, name, exe, hours }] (already resolved and sorted), templates: from loadTemplates().
export function renderScripts(table, { trackStart = null, options = {}, uncapped = false } = {}, templates) {
    const opts = normalizeOptions(options, { uncapped });
    const block = renderTableBlock(table, { trackStart });
    const client = clientBlock(templates);
    const out = {};
    for (const output of OUTPUTS) {
        const template = templates?.[output.engine];
        if (typeof template !== "string") throw new Error(`Template "${output.engine}" was not loaded.`);
        out[output.key] = {
            file: output.file,
            ns: output.ns,
            text: fill(template, renderHeader(output, table, trackStart, opts), [renderConfig(output, opts), block, client])
        };
    }
    return out;
}

const mdCell = value => String(value).replace(/\|/g, "\\|");

export function renderGamesMarkdown(table, { trackStart = null } = {}) {
    const lines = [
        "# Game table",
        "",
        `${table.length} games · ${formatHours(sumHours(table))}h total` +
            (trackStart ? ` · sessions start after ${trackStart}` : ""),
        "",
        "| # | Game | ID | Executable | Hours |",
        "|---:|---|---|---|---:|",
        ...table.map((row, i) => `| ${i + 1} | ${mdCell(row.name)} | ${row.id} | \`${mdCell(row.exe)}\` | ${hoursLiteral(row.hours)} |`)
    ];
    return lines.join("\n") + "\n";
}

// ---------- Danger Zone test: one game's first heartbeat ----------

export const FIRST_HEARTBEAT = Object.freeze({
    file: "first-heartbeat.js", ns: "__firstHeartbeat", label: "[First Heartbeat]"
});

// Backdate is a switch; the clock is "off", "page" or "system" (system always shifts the page clock too).
export const BACKDATE_BLURB = "Stamps the first heartbeat on the date and backtracks it by the hours, the way the main script's hours do.";
export const CLOCKS = Object.freeze([
    { key: "off", label: "Real clock", short: "Real", blurb: "The page clock isn't touched." },
    { key: "page", label: "Shift page clock", short: "Page",
        blurb: "Swaps Discord's in-page clock (Date, Intl.DateTimeFormat and every local-time method) to the date, and to a time zone if you set one, while the session is sent. Then it puts it back." },
    { key: "system", label: "System + page clock", short: "System + page",
        blurb: "You set your computer's date and time first; the script checks it's within 12h, then shifts the page clock onto the exact time as well." }
]);
const CLOCK_KEYS = CLOCKS.map(c => c.key);
const CLOCK_TOLERANCE_MS = 12 * 3600 * 1000;

export function isTimeZone(timeZone) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone });
        return true;
    } catch (_) {
        return false;
    }
}

// "YYYY-MM-DDTHH:MM[:SS]" (a datetime-local value) as ms: in `timeZone`, or this machine's local time without one.
export function zonedTimeToMs(local, timeZone = null) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(local ?? ""));
    if (!m) return NaN;
    const [y, mo, d, h, mi, s] = m.slice(1).map(v => Number(v ?? 0));
    if (!timeZone) return new Date(y, mo - 1, d, h, mi, s).getTime();
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    const offset = t => {
        const o = Object.fromEntries(dtf.formatToParts(t).map(p => [p.type, p.value]));
        return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - Math.floor(t / 1000) * 1000;
    };
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    return guess - offset(guess - offset(guess));
}

// { game: { id, name, exe }, firstMs, hours, untilNow, backdate, clock, timeZone, dryRun }. Throws on bad input.
export function normalizeFirstHeartbeat(input = {}) {
    const game = input.game ?? {};
    if (!/^\d+$/.test(String(game.id ?? "")) || !game.name || !game.exe) throw new Error("Pick a game first.");
    const firstMs = Math.round(Number(input.firstMs));
    if (!Number.isFinite(firstMs) || firstMs <= 0) throw new Error("Set the first heartbeat's date and time.");
    const backdate = input.backdate !== false;
    const clock = CLOCK_KEYS.includes(input.clock) ? input.clock : "off";
    if (!backdate && clock === "off") throw new Error("Turn on Backdate or pick a clock.");
    const timeZone = clock !== "off" && input.timeZone ? String(input.timeZone).trim() : null;
    if (timeZone && !isTimeZone(timeZone)) throw new Error(`"${timeZone}" isn't a time zone. Use an IANA name like America/New_York.`);
    const untilNow = input.untilNow === true && backdate && clock !== "system";
    const hours = toTenths(input.hours) / 10;
    if (!untilNow && !(hours >= 0.1)) throw new Error("Hours must be at least 0.1.");
    return {
        game: { id: String(game.id), name: String(game.name), exe: String(game.exe) },
        firstMs, hours: untilNow ? 0 : hours, untilNow, backdate, clock, timeZone, dryRun: input.dryRun === true
    };
}

export function renderFirstHeartbeat(input, templates) {
    const o = normalizeFirstHeartbeat(input);
    const template = templates?.firstHeartbeat;
    if (typeof template !== "string") throw new Error(`Template "firstHeartbeat" was not loaded.`);
    const out = FIRST_HEARTBEAT;
    const when = new Date(o.firstMs).toISOString().replace(".000Z", "Z");
    const clock = CLOCKS.find(c => c.key === o.clock);
    const length = o.untilNow ? "from then until the moment it runs" : `${formatHours(o.hours)}h long`;
    const methods = [o.backdate && "Backdate", o.clock !== "off" && clock.label].filter(Boolean).join(" + ");
    const lines = [
        "Discord Badge Unlocker: first heartbeat for one game (Danger Zone test)",
        `${o.game.name}: one session, first heartbeat at ${when}, ${length}.`,
        `Method: ${methods}.`
    ];
    if (o.backdate) lines.push(BACKDATE_BLURB);
    if (o.clock !== "off") lines.push(clock.blurb);
    if (o.clock !== "off") {
        lines.push(o.backdate ? "The page clock reads the session's end while it's sent." : "The page clock reads the first heartbeat while it's sent.");
        if (o.timeZone) lines.push(`Page time zone: ${o.timeZone}.`);
    }
    if (o.clock === "system") lines.push("Set the system date first and restart Discord. Far-off dates can break HTTPS (certificates look expired).");
    if (o.dryRun) lines.push("DRY RUN: builds every event but sends nothing.");
    lines.push("", "Run: Discord desktop > Ctrl+Shift+I > Console > paste > Enter.", "If the console asks, type: allow pasting",
        "Each run sends another session and adds its hours. It ignores the main scripts' sent history.",
        "It checks \"Use data to personalize my Discord experience\" is on first.",
        "", "Commands:",
        `  await window.${out.ns}.run()   send the session`,
        `  await window.${out.ns}.run({ force: true })   send even if ${o.clock === "system" ? "the system clock or that setting is" : "that setting reads as"} off`,
        `  window.${out.ns}.stop()`,
        "", "Based on everyoneexe/discord-game-badge-presence (GPL-3.0):", ORIGINAL_REPO);
    const header = ["/*", ...lines.map(line => (line ? ` * ${line}` : " *")), " */"].join("\n");
    const config = [
        `const NS = ${q(out.ns)};`,
        `    const LABEL = ${q(out.label)};`,
        `    const GAME = Object.freeze({ id: ${q(o.game.id)}, name: ${q(o.game.name)}, exe: ${q(o.game.exe)} });`,
        `    const FIRST_MS = ${o.firstMs}; // ${when}`,
        `    const TIME_ZONE = ${o.timeZone ? q(o.timeZone) : "null"}; // page clock time zone; null keeps yours`,
        `    const MACHINE_GUID = ${q(MACHINE_GUID)};`,
        "    const CONFIG = Object.freeze({",
        `        backdate: ${o.backdate},`,
        `        clock: ${q(o.clock)},`,
        `        hours: ${hoursLiteral(o.hours)},`,
        `        untilNow: ${o.untilNow},`,
        `        clockToleranceMs: ${CLOCK_TOLERANCE_MS},`,
        `        dryRun: ${o.dryRun}`,
        "    });"
    ].join("\n");
    return { file: out.file, ns: out.ns, text: fill(template, header, [config, clientBlock(templates)]) };
}

// ---------- Streaming zone: stream time for the Streaming badge ----------

export const STREAM_SCRIPT = Object.freeze({ file: "stream-time.js", ns: "__streamTime", label: "[Stream Time]" });
export const STREAM_REFERENCES = Object.freeze([
    "https://github.com/aboveproof/BadgeFarmer",
    "https://github.com/lawerth/discord-streamer"
]);
export const STREAM_DEFAULTS = Object.freeze({
    hours: 100, turbo: "auto", noViewer: "pause", turboHoursPerMinute: 10, split: true, dryRun: false
});
export const STREAM_SESSION_CAP_HOURS = 23;
const TURBO_RATE = { min: 1, max: 23 }; // hours a heartbeat claims; under a day, like every session

// { hours, turbo: "auto" | "off", noViewer: "pause" | "drop", turboHoursPerMinute, split, dryRun }. Throws on bad hours.
export function normalizeStream(input = {}) {
    const o = input && typeof input === "object" ? input : {};
    const d = STREAM_DEFAULTS;
    const hours = toTenths(o.hours ?? d.hours) / 10;
    if (!(hours >= 0.1)) throw new Error("Hours must be at least 0.1.");
    if (hours > STREAM_MAX_HOURS) throw new Error(`Hours can be at most ${formatCount(STREAM_MAX_HOURS)}, the top tier.`);
    return {
        hours,
        turbo: o.turbo === "off" ? "off" : "auto",
        noViewer: o.noViewer === "drop" ? "drop" : "pause",
        turboHoursPerMinute: int(o.turboHoursPerMinute, d.turboHoursPerMinute, TURBO_RATE.min, TURBO_RATE.max),
        split: o.split !== false,
        dryRun: o.dryRun === true
    };
}

export function renderStream(input, templates) {
    const o = normalizeStream(input);
    const template = templates?.stream;
    if (typeof template !== "string") throw new Error(`Template "stream" was not loaded.`);
    const out = STREAM_SCRIPT;
    const ns = `window.${out.ns}`;
    const turbo = o.turbo === "auto";
    const { liveMinutes } = streamEta({ hours: o.hours, turbo: o.turbo, turboHoursPerMinute: o.turboHoursPerMinute });
    const hrs = h => (Number.isInteger(h) ? formatCount(h) : formatHours(h));
    const eta = liveMinutes < 120 ? `${liveMinutes} minutes` : `${hrs(Math.round(liveMinutes / 6) / 10)} hours`;
    const lines = [
        "Discord Badge Unlocker: stream time (Streaming badge)",
        `Target: ${hrs(o.hours)}h. Turbo: ${turbo ? `on, ${o.turboHoursPerMinute}h a minute` : "off, 1 minute a minute"}. ` +
            `Nobody watching: ${o.noViewer}.`,
        `About ${eta} live with a viewer.`,
        "",
        "Before you paste:",
        "  1. Join a server voice channel and Go Live. Any window or screen works; no game needed.",
        "  2. Have someone watch the stream (an alt account counts). Hours only count with a viewer.",
        "  3. Turn on Settings > \"Use data to personalize my Discord experience\"; the script checks it.",
        "Run: Discord desktop > Ctrl+Shift+I > Console > paste > Enter.",
        "If the console asks, type: allow pasting",
        "Keep Discord open and stay live until it says Done.",
        ""
    ];
    if (o.noViewer === "drop") {
        lines.push("WARNING: no-viewer mode is DROP. With nobody watching it keeps sending 1 minute a",
            "minute anyway. Discord isn't known to count stream time without a viewer, so that",
            "part probably adds nothing.");
    } else {
        lines.push("No-viewer mode is pause: nothing is sent while nobody watches.");
    }
    if (turbo) lines.push("Turbo is untested (BadgeFarmer's author says so): try a small target first.");
    lines.push(o.split ? `Sessions are split at ${STREAM_SESSION_CAP_HOURS}h, like game sessions (Discord drops those over 24h).`
        : "Sessions are never split (one session per stream).");
    if (o.dryRun) lines.push("DRY RUN: builds every event but sends nothing.");
    lines.push("Sends through Discord's own HTTP client. It never reads your token.",
        "Vencord's NoTrack can stay on: this posts to /science directly.",
        "Progress is saved per account, so pasting it again carries on toward the target.",
        "", "Commands:");
    const commands = [
        [`await ${ns}.run()`, "start (it starts by itself)"],
        [`await ${ns}.run({ force: true })`, "send even if that setting reads as off"],
        [`${ns}.status`, "progress, live, viewers"],
        [`${ns}.resetProgress()`, "start over from 0"],
        [`${ns}.stop()`, ""]
    ];
    const width = Math.max(...commands.map(([cmd]) => cmd.length)) + 3;
    for (const [cmd, what] of commands) lines.push(`  ${what ? cmd.padEnd(width) + what : cmd}`);
    lines.push("", "Badges can take 24-48h to update.", "Based on aboveproof/BadgeFarmer and lawerth/discord-streamer (MIT):",
        ...STREAM_REFERENCES);
    const header = ["/*", ...lines.map(line => (line ? ` * ${line}` : " *")), " */"].join("\n");
    const config = [
        `const NS = ${q(out.ns)};`,
        `    const LABEL = ${q(out.label)};`,
        "    const CONFIG = Object.freeze({",
        `        targetHours: ${hoursLiteral(o.hours)},`,
        `        turbo: ${q(o.turbo)},`,
        `        noViewer: ${q(o.noViewer)},`,
        `        turboHoursPerMinute: ${o.turboHoursPerMinute},`,
        `        sessionCapHours: ${o.split ? STREAM_SESSION_CAP_HOURS : "null"},`,
        `        dryRun: ${o.dryRun}`,
        "    });"
    ].join("\n");
    return { file: out.file, ns: out.ns, text: fill(template, header, [config, clientBlock(templates)]) };
}
