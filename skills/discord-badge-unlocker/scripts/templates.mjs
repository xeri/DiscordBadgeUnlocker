// Renders the three console scripts from the two engine templates in ./templates/.
// Output is deterministic: the same table + options always give byte-identical text.

import { ORIGINAL_REPO, formatHours, roundHours, sumHours, trackStartMs } from "./core.mjs";

export const MACHINE_GUID = "b5a79402-959c-4861-a579-2821dfbb3c2b";
export const CLAIMED_KEY = "__discordBadgeUnlocker_claimed_ids";
export const LEGACY_CLAIMED_KEYS = Object.freeze(["__badgePresenceFixed150_claimed_ids"]);

export const TEMPLATE_FILES = Object.freeze({
    telemetry: "templates/telemetry.js",
    variety: "templates/variety.js"
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
    // mix of them (or one twice) never sends a game twice. Discord usually hides localStorage from
    // the console, so the history is mirrored on window and may only last until Discord reloads.
    function getStorage() {
        try {
            return window.localStorage ?? null;
        } catch (_) {
            return null;
        }
    }

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
    lines.push("my Discord experience\" on. Game Time counts time from 2025-12-08 on.");
    if (output.engine === "telemetry") {
        lines.push("Sends each game once, with its hours, through Discord's own HTTP client.");
        lines.push("It never reads your token. Games already sent to this account are skipped.");
    } else {
        const rotation = options.variety.keepRotating
            ? `Shows each game as your activity for ${options.variety.rotateMinutes} min, in table order, until stop().`
            : `Shows each game as your activity (${options.variety.rotateMinutes} min each) while claiming, then stops.`;
        lines.push(rotation);
        lines.push("Reads your token in memory to call Discord's API, like the original script;");
        lines.push("it is never stored or sent anywhere else. Games already sent are skipped.");
    }
    lines.push("");
    lines.push("Commands:");
    const commands = output.engine === "telemetry"
        ? [[`await ${ns}.${output.key === "gameTime" ? "boost" : "run"}()`, "send any games not sent yet"]]
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

function fill(template, header, config, block) {
    const parts = template.split("// @@CONFIG@@");
    if (parts.length !== 2 || !parts[0].includes("// @@HEADER@@")) throw new Error("Template markers missing.");
    return parts[0].replace("// @@HEADER@@", header) + config + "\n\n" + block + parts[1];
}

// table: [{ id, name, exe, hours }] (already resolved and sorted), templates: from loadTemplates().
export function renderScripts(table, { trackStart = null, options = {}, uncapped = false } = {}, templates) {
    const opts = normalizeOptions(options, { uncapped });
    const block = renderTableBlock(table, { trackStart });
    const out = {};
    for (const output of OUTPUTS) {
        const template = templates?.[output.engine];
        if (typeof template !== "string") throw new Error(`Template "${output.engine}" was not loaded.`);
        out[output.key] = {
            file: output.file,
            ns: output.ns,
            text: fill(template, renderHeader(output, table, trackStart, opts), renderConfig(output, opts), block)
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
