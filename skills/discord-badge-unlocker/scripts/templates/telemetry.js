// @@HEADER@@
(async () => {
    "use strict";

    // @@CONFIG@@

    if (typeof webpackChunkdiscord_app === "undefined") {
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
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const sumHours = games => games.reduce((total, game) => total + game.hours, 0);

    function webpackRequire() {
        const requireFn = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]);
        webpackChunkdiscord_app.pop();
        return requireFn;
    }

    const HTTP_METHODS = ["get", "post", "del"];

    function isHttpClient(candidate) {
        return candidate != null && HTTP_METHODS.every(method => typeof candidate[method] === "function");
    }

    function exportedValues(value) {
        if (!value || (typeof value !== "object" && typeof value !== "function")) return [];
        return [value, value.default, ...Object.values(value)];
    }

    function findHttpClient(requireFn) {
        for (const [id, factory] of Object.entries(requireFn?.m ?? {})) {
            let source = "";
            try {
                source = typeof factory === "function" ? factory.toString() : "";
            } catch (_) {}
            if (!source.includes("HTTPUtils")) continue;
            try {
                const client = exportedValues(requireFn(id)).find(isHttpClient);
                if (client) return client;
            } catch (_) {}
        }
        for (const cached of Object.values(requireFn?.c ?? {})) {
            try {
                const client = exportedValues(cached?.exports).find(isHttpClient);
                if (client) return client;
            } catch (_) {}
        }
        return null;
    }

    async function fingerprintFor(userId) {
        const header = await sha256("pe_header_" + userId);
        const machine = await sha256(MACHINE_GUID + userId);
        const sections = await sha256("pe_section_" + userId);
        const certificate = await sha256("pe_cert_" + userId);
        const mask = await sha256(userId + "https://discord.com/careers");

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

    function sessionEvents(game, fingerprint, state) {
        const durationMs = Math.round(game.hours * 3600 * 1000);
        const sessionId = uuid();
        const now = Date.now();
        const start = Math.max(0, now - durationMs);
        if (TRACK_START_MS !== null && start < TRACK_START_MS) {
            console.warn(`${LABEL} ${game.name} would start before ${new Date(TRACK_START_MS).toISOString().slice(0, 10)} ` +
                `(${new Date(start).toISOString()}).`);
        }

        const launch = {
            client_track_timestamp: now,
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
            client_send_timestamp: now
        };

        const events = [
            {
                type: "running_game_heartbeat",
                properties: {
                    client_track_timestamp: start,
                    client_heartbeat_session_id: state.heartbeat,
                    game_id: game.id,
                    game_name: game.name,
                    game_metadata: null,
                    game_executable: game.exe,
                    game_detection_enabled: true,
                    initial_heartbeat: true,
                    final_heartbeat: false,
                    game_session_id: sessionId,
                    duration_tracked_ms: 0,
                    rtc_connection_id: null,
                    media_session_id: null,
                    launch_signature: state.signature,
                    client_app_state: "focused",
                    client_send_timestamp: start
                }
            },
            { type: "launch_game", properties: launch },
            {
                type: "running_game_heartbeat",
                properties: {
                    client_track_timestamp: now,
                    client_heartbeat_session_id: state.heartbeat,
                    game_id: game.id,
                    game_name: game.name,
                    game_metadata: null,
                    game_executable: game.exe,
                    game_detection_enabled: true,
                    initial_heartbeat: false,
                    final_heartbeat: true,
                    game_session_id: sessionId,
                    duration_tracked_ms: durationMs,
                    rtc_connection_id: null,
                    media_session_id: null,
                    launch_signature: state.signature,
                    client_app_state: "focused",
                    client_send_timestamp: now
                }
            }
        ];

        for (const event of events) {
            event.properties.event_sequence_number = ++state.sequence;
        }
        return { events, hours: durationMs / 3600000 };
    }

    async function getAuthContext(client) {
        if (!client) throw new Error("Discord's internal HTTP client could not be located.");
        const response = await client.get({ url: "/users/@me", query: { with_analytics_token: true } });
        const profile = response?.body ?? {};
        const analyticsToken = profile.analytics_token;
        const userId = profile.id == null ? "" : String(profile.id);
        const username = profile.username || "user";
        if (!analyticsToken) throw new Error("analytics_token is missing from this session.");
        if (!/^\d+$/.test(userId)) throw new Error("Discord user ID could not be resolved.");
        return {
            analyticsToken,
            userId,
            username,
            fingerprint: await fingerprintFor(userId)
        };
    }

    async function sendBatch(events, context) {
        if (CONFIG.dryRun) return true;
        try {
            // The client attaches auth and super-properties headers itself.
            const response = await context.client.post({
                url: "/science",
                body: { token: context.analyticsToken, events }
            });
            if (response?.ok || response?.status === 200 || response?.status === 204) return true;
            if (response?.status === 429) {
                console.warn(`${LABEL} Rate limited; cooling down 5s.`);
                await wait(5000);
            }
            return false;
        } catch (error) {
            const status = error?.status ?? error?.statusCode;
            if (status === 429) {
                console.warn(`${LABEL} Rate limited; cooling down 5s.`);
                await wait(5000);
            }
            return false;
        }
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

    async function send() {
        validateGames();

        const requireFn = webpackRequire();
        if (!requireFn?.c) throw new Error("Discord's webpack registry was not found.");
        const client = findHttpClient(requireFn);
        if (!client) throw new Error("Discord's internal HTTP client could not be located.");
        const context = { ...(await getAuthContext(client)), client };
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

        console.log(`${LABEL} Connected as ${context.username} | sending ${sumHours(selected).toFixed(1)}h ` +
            `across ${selected.length} games (table: ${GAMES.length} games, ${TOTAL_HOURS}h)`);
        if (CONFIG.dryRun) console.warn(`${LABEL} Dry-run mode is ON: nothing will be sent.`);
        if (stopped) return 0;

        let sentGames = 0;
        let sentHours = 0;
        const totalBatches = Math.ceil(selected.length / CONFIG.batchSize);

        for (let offset = 0; offset < selected.length; offset += CONFIG.batchSize) {
            if (stopped) break;
            const chunk = selected.slice(offset, offset + CONFIG.batchSize);
            const allEvents = [];
            let chunkHours = 0;

            for (const game of chunk) {
                const result = sessionEvents(game, context.fingerprint, state);
                allEvents.push(...result.events);
                chunkHours += result.hours;
            }

            const batchNum = Math.floor(offset / CONFIG.batchSize) + 1;
            const accepted = await sendBatch(allEvents, context);

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

            if (offset + CONFIG.batchSize < selected.length && !stopped) {
                await wait(CONFIG.delayMs);
            }
        }

        if (sentGames > 0) {
            console.log(`${LABEL} Done: ${sentGames}/${selected.length} games | ${sentHours.toFixed(1)}h accepted. ` +
                "Badge updates can take 24-48h.");
        }
        return sentHours;
    }

    function run() {
        if (stopped) return Promise.resolve(0);
        if (running) {
            console.warn(`${LABEL} A run is already in progress.`);
            return lastRun;
        }
        running = true;
        lastRun = send().finally(() => { running = false; });
        return lastRun;
    }

    function stop() {
        if (stopped) return;
        stopped = true;
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
