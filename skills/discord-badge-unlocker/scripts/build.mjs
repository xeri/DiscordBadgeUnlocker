#!/usr/bin/env node
// DiscordBadgeUnlocker CLI. No dependencies; Node 18+.
//
//   node build.mjs fetch-catalog [--out catalog.min.json]
//   node build.mjs slim-catalog --in games.json [--out catalog.min.json]
//   node build.mjs search [--catalog F] "query" [--limit 20]
//   node build.mjs vibes [--ranking F]
//   node build.mjs pick [--vibe popular|competitive|cozy|adventurer|builder|friends] [--top 150]
//        [--mode weighted|even|flat] [--total 5000] [--hours 1.5] [--add selection.json]
//        [--track-start YYYY-MM-DD] [--ranking F] [--out selection.json]
//   node build.mjs build --selection selection.json --out out/ [--catalog F]
//        [--track-start YYYY-MM-DD | --no-track-start] [--batch-size 25] [--delay-ms 450] [--dry-run]
//        [--variety-batch-size 5] [--variety-delay-ms 4000] [--rotate-minutes 30] [--keep-rotating]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
    HOUR_MODES, VIBES, assignHours, buildSearchIndex, countByVibe, formatCount, formatHours, loadCatalog,
    normalizeCatalog, normalizeSelection, parseCatalog, parseRanking, pickFromRanking, resolveSelection,
    searchCatalog, serializeCatalog, summarize, validateTable
} from "./core.mjs";
import { loadTemplates, normalizeOptions, renderGamesMarkdown, renderScripts } from "./templates.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Repo snapshot when the skill lives in the DiscordBadgeUnlocker repo (skills/<name>/scripts/ → repo root).
const REPO_SNAPSHOT = resolve(HERE, "../../../data/catalog.min.json");
const REPO_RANKING = resolve(HERE, "../../../data/rankings/global.json");

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            args._.push(arg);
            continue;
        }
        const [key, inline] = arg.slice(2).split(/=(.*)/s);
        if (inline !== undefined) args[key] = inline;
        else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
        else args[key] = true;
    }
    return args;
}

const log = (...parts) => console.error(...parts);

async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}

// Accepts a snapshot (ours) or a raw Discord games.json / detectable payload.
async function readCatalogFile(path) {
    const data = await readJson(path);
    if (data?.v === 1 && Array.isArray(data.games)) return { ...parseCatalog(data), path };
    return { games: normalizeCatalog(data), source: "file", fetchedAt: null, path };
}

async function getCatalog(args) {
    if (args.catalog && args.catalog !== true) {
        const catalog = await readCatalogFile(args.catalog);
        log(`Catalog: ${formatCount(catalog.games.length)} games from ${args.catalog}`);
        return catalog;
    }
    try {
        const catalog = await loadCatalog();
        log(`Catalog: ${formatCount(catalog.games.length)} games, live from ${catalog.sourceLabel}`);
        return catalog;
    } catch (error) {
        if (!existsSync(REPO_SNAPSHOT)) throw error;
        const catalog = await readCatalogFile(REPO_SNAPSHOT);
        log(`Live catalog failed (${error.message}).`);
        log(`Catalog: ${formatCount(catalog.games.length)} games from the snapshot (${catalog.fetchedAt ?? "unknown date"})`);
        return catalog;
    }
}

async function cmdFetchCatalog(args) {
    const catalog = await loadCatalog();
    const out = args.out && args.out !== true ? args.out : "catalog.min.json";
    await writeFile(out, serializeCatalog(catalog.games, { source: catalog.source, fetchedAt: catalog.fetchedAt }));
    log(`Wrote ${formatCount(catalog.games.length)} games from ${catalog.sourceLabel} to ${out}`);
}

async function cmdSlimCatalog(args) {
    if (!args.in || args.in === true) throw new Error("slim-catalog needs --in <games.json>");
    const games = normalizeCatalog(await readJson(args.in));
    const out = args.out && args.out !== true ? args.out : "catalog.min.json";
    await writeFile(out, serializeCatalog(games, { source: "file", fetchedAt: new Date().toISOString() }));
    log(`Wrote ${formatCount(games.length)} games to ${out}`);
}

async function cmdSearch(args) {
    const query = args._.join(" ");
    if (!query) throw new Error("search needs a query");
    const catalog = await getCatalog(args);
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 20;
    const results = searchCatalog(buildSearchIndex(catalog.games), query, { limit });
    if (!results.length) log(`No games match "${query}".`);
    for (const game of results) {
        const aliases = game.aliases?.length ? `  (aka ${game.aliases.join(", ")})` : "";
        console.log(`${game.id}\t${game.name}\t${game.exe}${aliases}`);
    }
}

async function readRanking(args) {
    const path = args.ranking && args.ranking !== true ? args.ranking : REPO_RANKING;
    return { path, ranking: parseRanking(await readJson(path)) };
}

async function cmdVibes(args) {
    const { path, ranking } = await readRanking(args);
    const counts = countByVibe(ranking);
    log(`${path} (${ranking.updated}, ${formatCount(ranking.games.length)} games)`);
    for (const vibe of VIBES) console.log(`${vibe.key.padEnd(12)} ${String(counts[vibe.key]).padStart(4)}  ${vibe.label}: ${vibe.blurb}`);
}

async function cmdPick(args) {
    const { ranking } = await readRanking(args);
    const vibe = args.vibe && args.vibe !== true ? String(args.vibe) : "popular";
    const meta = VIBES.find(v => v.key === vibe);
    if (!meta) throw new Error(`Unknown vibe "${vibe}". Use one of: ${VIBES.map(v => v.key).join(", ")}`);
    const mode = args.mode && args.mode !== true ? String(args.mode) : "weighted";
    if (!HOUR_MODES.includes(mode)) throw new Error(`--mode must be one of ${HOUR_MODES.join(", ")}`);
    const top = Number(args.top) > 0 ? Math.floor(Number(args.top)) : 150;
    const total = Number(args.total) > 0 ? Number(args.total) : 5000;
    const perGame = Number(args.hours) > 0 ? Number(args.hours) : 1.5;

    const base = args.add && args.add !== true ? normalizeSelection(await readJson(args.add)) : null;
    const skipIds = new Set((base?.games ?? []).map(g => g.id).filter(Boolean));
    const picked = pickFromRanking(ranking, { vibe, count: top, skipIds });
    if (!picked.length) throw new Error("No games match.");
    const games = assignHours(picked, { mode, total, perGame });
    const selection = {
        version: 1,
        name: base?.name ?? `Global top ${picked.length} · ${meta.label}`,
        trackStart: args["track-start"] && args["track-start"] !== true ? String(args["track-start"]) : base?.trackStart ?? null,
        ...(base?.options ? { options: base.options } : {}),
        games: [...(base?.games ?? []), ...games]
    };
    const text = JSON.stringify(selection, null, 2) + "\n";
    if (args.out && args.out !== true) {
        await writeFile(args.out, text);
        log(`Picked ${picked.length} ${meta.label} games (${mode}) → ${args.out} (${selection.games.length} games total)`);
    } else {
        process.stdout.write(text);
    }
}

function optionsFromArgs(base, args) {
    const o = normalizeOptions(base ?? {});
    const num = key => (args[key] !== undefined && args[key] !== true ? Number(args[key]) : undefined);
    if (num("batch-size") !== undefined) o.batchSize = num("batch-size");
    if (num("delay-ms") !== undefined) o.delayMs = num("delay-ms");
    if (args["dry-run"]) o.dryRun = true;
    if (num("variety-batch-size") !== undefined) o.variety.batchSize = num("variety-batch-size");
    if (num("variety-delay-ms") !== undefined) o.variety.delayMs = num("variety-delay-ms");
    if (num("rotate-minutes") !== undefined) o.variety.rotateMinutes = num("rotate-minutes");
    if (args["keep-rotating"]) o.variety.keepRotating = true;
    return normalizeOptions(o);
}

async function cmdBuild(args) {
    if (!args.selection || args.selection === true) throw new Error("build needs --selection <selection.json>");
    const outDir = args.out && args.out !== true ? args.out : "out";
    const selection = await readJson(args.selection);
    const catalog = await getCatalog(args);
    const resolved = resolveSelection(catalog.games, selection);

    for (const m of resolved.missing) log(`  missing:   games[${m.index}] ${m.id ?? ""} ${m.name ?? ""}`.trimEnd());
    for (const a of resolved.ambiguous) log(`  ambiguous: games[${a.index}] "${a.name}" → ${a.ids.join(", ")} (use an id)`);
    for (const d of resolved.duplicates) log(`  duplicate: games[${d.index}] ${d.id} ${d.name}`);
    for (const v of resolved.invalid) log(`  bad hours: games[${v.index}] ${v.name} (${v.hours})`);
    if (!resolved.ok) throw new Error("Fix the selection entries above and build again.");

    let trackStart = resolved.trackStart;
    if (args["track-start"] && args["track-start"] !== true) trackStart = String(args["track-start"]);
    if (args["no-track-start"]) trackStart = null;
    const options = optionsFromArgs(resolved.options, args);

    const check = validateTable(resolved.table, { trackStart });
    for (const warning of check.warnings) log(`  warning: ${warning}`);
    if (!check.ok) {
        for (const error of check.errors) log(`  error: ${error}`);
        throw new Error("The table is not valid.");
    }

    const scripts = renderScripts(resolved.table, { trackStart, options }, await loadTemplates());
    await mkdir(outDir, { recursive: true });
    for (const script of Object.values(scripts)) {
        await writeFile(join(outDir, script.file), script.text);
    }
    await writeFile(join(outDir, "GAMES.md"), renderGamesMarkdown(resolved.table, { trackStart }));
    const summary = summarize(resolved.table);
    await writeFile(join(outDir, "table.json"), JSON.stringify({
        version: 1,
        trackStart,
        options,
        count: summary.games,
        totalHours: summary.totalHours,
        games: resolved.table
    }, null, 2) + "\n");

    log(`Built ${summary.games} games, ${formatHours(summary.totalHours)}h → ${outDir}/`);
    for (const script of Object.values(scripts)) log(`  ${script.file} (${formatCount(script.text.length)} bytes)`);
    log("  GAMES.md, table.json");
}

const COMMANDS = {
    "fetch-catalog": cmdFetchCatalog,
    "slim-catalog": cmdSlimCatalog,
    search: cmdSearch,
    vibes: cmdVibes,
    pick: cmdPick,
    build: cmdBuild
};

const [command, ...rest] = process.argv.slice(2);
const run = COMMANDS[command];
if (!run) {
    log("Usage: node build.mjs <fetch-catalog|slim-catalog|search|vibes|pick|build> [options]");
    log("See the top of this file or SKILL.md for the options.");
    process.exit(command ? 1 : 0);
}
run(parseArgs(rest)).catch(error => {
    log(`Error: ${error.message}`);
    process.exit(1);
});
