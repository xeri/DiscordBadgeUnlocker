// @@HEADER@@
(async () => {
    "use strict";

    // @@CONFIG@@

    if (!webpackRequire()) {
        console.error(`${LABEL} Discord desktop client required.`);
        return;
    }

    const previous = window[NS];
    if (previous?.stop) {
        console.warn(`${LABEL} Replacing the previous instance.`);
        try { previous.stop(); } catch (_) {}
    }
    window[NS] = { loading: true };

    // Session IDs must stay unique per session; they do not change which games or hours are sent.
    const uuid = () => crypto.randomUUID();
    const sha256 = async value => new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    );
    const sumHours = games => games.reduce((total, game) => total + game.hours, 0);

    // Discord drops a play session longer than 24h completely, so a longer game goes as back-to-back
    // sessions of at most 23h, SESSION_GAP_MS apart, the last one ending when it's sent.
    const MAX_SESSION_MS = 23 * 3600 * 1000;
    const SESSION_GAP_MS = 10 * 60 * 1000;
    const sessionCount = game => Math.max(1, Math.ceil(Math.round(game.hours * 3600 * 1000) / MAX_SESSION_MS));

    // The game's sessions, oldest first, as { start, durationMs }. Durations add up to its hours exactly.
    function splitSessions(game, end) {
        const totalMs = Math.round(game.hours * 3600 * 1000);
        const count = sessionCount(game);
        const base = Math.floor(totalMs / count);
        const sessions = [];
        for (let k = 0; k < count; k++) {
            const durationMs = base + (k < totalMs - base * count ? 1 : 0);
            sessions.unshift({ start: end - durationMs, durationMs });
            end -= durationMs + SESSION_GAP_MS;
        }
        return sessions;
    }

    // Up to CONFIG.batchSize games per request, and no more events than that many one-session games
    // (3 each) unless a single game needs more. A game's sessions always share a request.
    function makeBatches(games) {
        const limit = CONFIG.batchSize * 3;
        const batches = [];
        let current = [];
        let events = 0;
        for (const game of games) {
            const count = sessionCount(game) * 3;
            if (current.length && (current.length >= CONFIG.batchSize || events + count > limit)) {
                batches.push(current);
                current = [];
                events = 0;
            }
            current.push(game);
            events += count;
        }
        if (current.length) batches.push(current);
        return batches;
    }

    async function fingerprintFor(userId) {
        const [header, machine, sections, certificate, mask] = await Promise.all([
            sha256("pe_header_" + userId),
            sha256(MACHINE_GUID + userId),
            sha256("pe_section_" + userId),
            sha256("pe_cert_" + userId),
            sha256(userId + "https://discord.com/careers")
        ]);

        const binary = new Uint8Array(146);
        const writer = new DataView(binary.buffer);
        binary[0] = 1;
        binary[1] = 1;
        writer.setBigUint64(2, 65432100n, true);
        writer.setUint32(10, 1690000000, true);
        writer.setUint32(14, 0x02500000, true);
        binary.set(header, 18);
        binary.set(machine, 50);
        binary.set(sections, 82);
        binary.set(certificate, 114);

        for (let i = 1; i < binary.length; i++) {
            binary[i] ^= mask[(i - 1) & 31];
        }

        let str = "";
        for (let i = 0; i < binary.length; i++) str += String.fromCharCode(binary[i]);
        return btoa(str);
    }

    // One session: first heartbeat at `start`, launch_game and the final heartbeat at its end.
    function sessionEvents(game, start, durationMs, fingerprint, state) {
        const sessionId = uuid();
        const end = start + durationMs;

        const launch = {
            client_track_timestamp: end,
            client_heartbeat_session_id: state.heartbeat,
            game: game.name,
            game_id: game.id,
            verified: true,
            elevated: false,
            is_launcher: false,
            game_platform: "desktop",
            detection_method: "verified_game",
            is_overlay_enabled: false,
            is_overlay_game_enabled: true,
            is_overlay_game_source: "OOP_DEFAULT_DATABASE",
            fullscreen_type: "UNKNOWN",
            hardware_display_count: 1,
            overlay_method: "Disabled",
            activity_status_enabled: true,
            activity_status_shared_guilds: [],
            current_user_status: "online",
            game_detection_enabled: true,
            executable_path: game.exe,
            voice_channel_id: null,
            voice_channel_type: null,
            voice_channel_bitrate: null,
            voice_channel_guild_id: null,
            hidden_by_distributor: false,
            game_metadata: null,
            executable_fingerprint: fingerprint,
            client_performance_cpu: null,
            client_performance_memory: null,
            cpu_core_count: null,
            accessibility_features: 0,
            rendered_locale: "en-US",
            launch_signature: state.signature,
            client_rtc_state: null,
            client_app_state: "focused",
            client_send_timestamp: end
        };

        // The first heartbeat opens the session at `start`, the final one closes it at `end` with the full duration.
        const heartbeat = (timestamp, final) => ({
            type: "running_game_heartbeat",
            properties: {
                client_track_timestamp: timestamp,
                client_heartbeat_session_id: state.heartbeat,
                game_id: game.id,
                game_name: game.name,
                game_metadata: null,
                game_executable: game.exe,
                game_detection_enabled: true,
                initial_heartbeat: !final,
                final_heartbeat: final,
                game_session_id: sessionId,
                duration_tracked_ms: final ? durationMs : 0,
                rtc_connection_id: null,
                media_session_id: null,
                launch_signature: state.signature,
                client_app_state: "focused",
                client_send_timestamp: timestamp
            }
        });
        const events = [heartbeat(start, false), { type: "launch_game", properties: launch }, heartbeat(end, true)];

        for (const event of events) {
            event.properties.event_sequence_number = ++state.sequence;
        }
        return events;
    }

    // Every session of one game, the last ending now.
    function gameEvents(game, fingerprint, state) {
        const sessions = splitSessions(game, Date.now());
        if (TRACK_START_MS !== null && sessions[0].start < TRACK_START_MS) {
            console.warn(`${LABEL} ${game.name} would start before ${new Date(TRACK_START_MS).toISOString().slice(0, 10)} ` +
                `(${new Date(sessions[0].start).toISOString()}).`);
        }
        const events = sessions.flatMap(session => sessionEvents(game, session.start, session.durationMs, fingerprint, state));
        return { events, hours: sessions.reduce((total, session) => total + session.durationMs, 0) / 3600000 };
    }

    const state = {
        heartbeat: uuid(),
        signature: uuid(),
        sequence: 0
    };

    let credited = 0;
    let running = false;
    let stopped = false;
    let lastUserId = null;
    let lastRun = null;

    async function send(force) {
        validateGames();

        const requireFn = webpackRequire();
        if (!requireFn?.c) throw new Error("Discord's webpack registry was not found.");
        const client = findHttpClient(requireFn);
        if (!client) throw new Error("Discord's internal HTTP client could not be located.");
        const auth = await getAuthContext(client);
        const context = { ...auth, client, fingerprint: await fingerprintFor(auth.userId) };
        lastUserId = context.userId;

        // Fixed table, fixed order. Games already sent to this account (by any of the three
        // scripts) are skipped, so the profile never gets more than TOTAL_HOURS from this table.
        const claimed = getClaimedSet(context.userId);
        const selected = GAMES.filter(game => !claimed.has(game.id));
        if (!selected.length) {
            console.log(`${LABEL} All ${GAMES.length} games (${TOTAL_HOURS}h) were already sent for ${context.username}. ` +
                `Nothing to do. Run window.${NS}.resetClaimed() first if you really want to send them again.`);
            return 0;
        }

        const batches = makeBatches(selected);
        const sessions = selected.reduce((total, game) => total + sessionCount(game), 0);
        console.log(`${LABEL} Connected as ${context.username} | sending ${sumHours(selected).toFixed(1)}h ` +
            `across ${selected.length} games as ${sessions} sessions of at most 23h, in ${batches.length} requests ` +
            `(table: ${GAMES.length} games, ${TOTAL_HOURS}h)`);
        if (CONFIG.dryRun) {
            console.warn(`${LABEL} Dry-run mode is ON: nothing will be sent.`);
        } else {
            // Without the personalization setting nothing counts, so don't mark games as sent.
            const consent = await readConsent(client);
            if (consent.personalization === false && !force) {
                throw new Error("\"Use data to personalize my Discord experience\" is off (User Settings > Data & Privacy), " +
                    "so Discord won't count this. Turn it on, then run this again " +
                    `(or await window.${NS}.run({ force: true }) to send anyway).`);
            }
            if (consent.personalization === null) {
                console.warn(`${LABEL} Couldn't read "Use data to personalize my Discord experience"; make sure it's on.`);
            }
            if (consent.usage === false) {
                console.warn(`${LABEL} "Use data to improve Discord" is off. Discord's help article only needs the ` +
                    "personalization setting, but turn this on too if the badges don't move.");
            }
        }
        if (stopped) return 0;

        let sentGames = 0;
        let sentHours = 0;
        const totalBatches = batches.length;

        for (let b = 0; b < batches.length; b++) {
            if (stopped) break;
            const chunk = batches[b];
            const allEvents = [];
            let chunkHours = 0;

            for (const game of chunk) {
                const result = gameEvents(game, context.fingerprint, state);
                allEvents.push(...result.events);
                chunkHours += result.hours;
            }

            const batchNum = b + 1;
            const accepted = await sendBatch(allEvents, context, () => stopped);

            if (accepted) {
                sentGames += chunk.length;
                sentHours += chunkHours;
                credited += chunkHours;
                if (!CONFIG.dryRun) {
                    for (const game of chunk) claimed.add(game.id);
                    saveClaimedSet(context.userId, claimed);
                }
                const tag = CONFIG.dryRun ? "[dry-run] " : "";
                console.log(`${LABEL} ${tag}Batch ${batchNum}/${totalBatches} accepted (+${chunkHours.toFixed(1)}h, ${sentHours.toFixed(1)}h so far)`);
            } else {
                console.warn(`${LABEL} Batch ${batchNum}/${totalBatches} was rejected.`);
            }

            if (b + 1 < batches.length && !stopped) {
                await wait(CONFIG.delayMs);
            }
        }

        if (sentGames > 0) {
            console.log(`${LABEL} Done: ${sentGames}/${selected.length} games | ${sentHours.toFixed(1)}h accepted. ` +
                "Badge updates can take 24-48h.");
        }
        return sentHours;
    }

    function run({ force = false } = {}) {
        if (stopped) return Promise.resolve(0);
        if (running) {
            console.warn(`${LABEL} A run is already in progress.`);
            return lastRun;
        }
        running = true;
        lastRun = send(force === true).finally(() => { running = false; });
        return lastRun;
    }

    function stop() {
        if (stopped) return;
        stopped = true;
        releaseStorage(lastRun);
        if (window[NS]?.stop === stop) delete window[NS];
        console.log(`${LABEL} Stopped.`);
    }

    function resetClaimed() {
        resetClaimedSet();
        console.log(`${LABEL} Claimed history reset. The next run sends every game again.`);
    }

    window[NS] = {
        run,
        boost: run,
        stop,
        resetClaimed,
        get games() { return GAMES.map(game => game.name); },
        get table() { return GAMES.map(game => ({ ...game })); },
        get totalHours() { return TOTAL_HOURS; },
        get creditedHours() { return credited; },
        get claimedCount() { return lastUserId ? getClaimedSet(lastUserId).size : null; },
        get lastRun() { return lastRun; }
    };
    window.addEventListener("pagehide", stop, { once: true });

    console.log(`${LABEL} Ready: ${GAMES.length} games, ${TOTAL_HOURS}h total. Starting in a moment...`);
    console.log(`${LABEL} Manual: await window.${NS}.run()`);
    console.log(`${LABEL} Stop: window.${NS}.stop()`);

    setTimeout(() => {
        if (stopped) return;
        run().catch(error => console.warn(`${LABEL} Run failed: ${error.message}`));
    }, 1200);
})();
