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
        try { await previous.stop(); } catch (_) {}
    }
    window[NS] = { loading: true };

    const MINUTE_MS = 60 * 1000;
    const HOUR_MS = 60 * MINUTE_MS;
    const TICK_MS = MINUTE_MS; // one heartbeat a minute, like Discord's own client
    const TARGET_MS = Math.round(CONFIG.targetHours * HOUR_MS);
    const TURBO_MS = Math.round(CONFIG.turboHoursPerMinute * HOUR_MS);
    // Discord drops a game session over 24h whole, so stream sessions are kept to sessionCapHours too.
    const SESSION_CAP_MS = CONFIG.sessionCapHours == null ? Infinity : Math.round(CONFIG.sessionCapHours * HOUR_MS);
    const MAX_FAILURES = 10;
    const DROP_REMINDER_TICKS = 15;
    const PROGRESS_KEY = "__discordBadgeUnlocker_stream";
    const PROGRESS_MEMORY_KEY = "__discordBadgeUnlocker_streamProgress";

    // Session IDs must stay unique per stream session; they don't change how much is credited.
    const uuid = () => crypto.randomUUID();
    const span = ms => (ms >= HOUR_MS ? `${(ms / HOUR_MS).toFixed(1)}h` : `${Math.round(ms / MINUTE_MS)}m`);

    // Probing Discord's modules makes some of them log warnings; keep the console quiet meanwhile.
    function quietly(fn) {
        const origWarn = console.warn;
        console.warn = () => {};
        try {
            return fn();
        } finally {
            console.warn = origWarn;
        }
    }

    // Discord's ApplicationStreamingStore: who you're streaming to and who's watching.
    function findStreamingStore(requireFn) {
        const candidates = [];
        for (const cached of Object.values(requireFn?.c ?? {})) {
            try {
                for (const value of exportedValues(cached?.exports)) {
                    if (!value || typeof value !== "object" || answersAnything(value)) continue;
                    if (typeof value.getCurrentUserActiveStream !== "function" || typeof value.getViewerIds !== "function") continue;
                    let name = null;
                    try { name = value.getName?.() ?? value.constructor?.displayName ?? null; } catch (_) {}
                    if (name === "ApplicationStreamingStore") return value;
                    candidates.push(value);
                }
            } catch (_) {}
        }
        return candidates[0] ?? null;
    }

    // Progress is kept per account, so pasting the script again (after a reload, say) carries on toward the
    // target instead of starting over. It's mirrored on window in case storage fails.
    function loadProgress(userId) {
        let ms = Number(window[PROGRESS_MEMORY_KEY]?.[userId]) || 0;
        try {
            const saved = JSON.parse(getStorage()?.getItem(`${PROGRESS_KEY}:${userId}`) || "null");
            ms = Math.max(ms, Number(saved?.creditedMs) || 0);
        } catch (_) {}
        return ms;
    }

    function saveProgress(userId, ms) {
        window[PROGRESS_MEMORY_KEY] = { ...(window[PROGRESS_MEMORY_KEY] ?? {}), [userId]: ms };
        try {
            getStorage()?.setItem(`${PROGRESS_KEY}:${userId}`, JSON.stringify({ creditedMs: ms }));
        } catch (_) {}
    }

    let store = null;
    let context = null;
    let session = null; // { guildId, channelId, key, heartbeatSession, launchSignature, trackedMs }
    let sequence = 0;
    let credited = 0;
    let failures = 0;
    let dropped = 0;
    let state = "idle";
    let timer = null;
    let running = false;
    let stopped = false;
    let lastRun = null;
    let lastUserId = null;
    let lastSeen = { live: false, viewers: 0 };
    let finish = () => {};

    // The stream you're live with right now. Only a server voice channel counts as live here.
    function currentStream() {
        let stream = null;
        try {
            stream = store.getCurrentUserActiveStream();
        } catch (_) {}
        if (!stream) return { live: false, call: false, viewers: 0 };
        const guildId = stream.guildId == null ? "" : String(stream.guildId);
        const channelId = stream.channelId == null ? "" : String(stream.channelId);
        if (!/^\d+$/.test(guildId) || !/^\d+$/.test(channelId)) return { live: false, call: true, viewers: 0 };
        let viewers = 0;
        try {
            viewers = (store.getViewerIds(stream) ?? []).length;
        } catch (_) {}
        return { live: true, call: false, guildId, channelId, key: `${guildId}:${channelId}`, viewers };
    }

    // One analytics event in the stream session, with the fields lawerth/discord-streamer's telemetry sends.
    function streamEvent(type, properties) {
        const now = Date.now();
        return {
            type,
            properties: {
                client_track_timestamp: now,
                client_send_timestamp: now,
                client_heartbeat_session_id: session.heartbeatSession,
                launch_signature: session.launchSignature,
                event_sequence_number: ++sequence,
                client_app_state: "focused",
                guild_id: session.guildId,
                channel_id: session.channelId,
                channel_type: 2,
                ...properties
            }
        };
    }

    async function openSession(stream) {
        session = {
            guildId: stream.guildId, channelId: stream.channelId, key: stream.key,
            heartbeatSession: uuid(), launchSignature: uuid(), trackedMs: 0
        };
        const ok = await sendBatch([streamEvent("media_session_joined", {}), streamEvent("video_stream_started", {})],
            context, () => stopped);
        if (!ok) session = null;
        return ok;
    }

    async function closeSession() {
        const open = session;
        if (!open) return;
        const ended = streamEvent("video_stream_ended", { duration_ms: open.trackedMs });
        session = null;
        await sendBatch([ended], context, () => false);
    }

    function setState(next, message, level = "log") {
        if (state === next) return;
        state = next;
        if (message) console[level](`${LABEL} ${message}`);
    }

    function schedule() {
        if (!stopped && running) timer = setTimeout(() => { tick().catch(fail); }, TICK_MS);
    }

    function fail(error) {
        console.warn(`${LABEL} Stopped: ${error?.message ?? error}`);
        end(false);
    }

    async function end(reachedTarget) {
        if (!running) return;
        running = false;
        if (timer) clearTimeout(timer);
        timer = null;
        await closeSession();
        if (reachedTarget) {
            console.log(`${LABEL} Done: ${span(credited)} credited (target ${span(TARGET_MS)}). ` +
                "Badge updates can take 24-48h. You can stop streaming now.");
        }
        finish();
    }

    // Once a minute: check the stream, then send one heartbeat if this minute should count.
    async function tick() {
        timer = null;
        if (stopped || !running) return;
        const now = currentStream();
        lastSeen = now;
        let claim = 0;

        if (!now.live) {
            await closeSession();
            setState(now.call ? "call" : "offline", now.call
                ? "You're live in a call. Go Live in a server voice channel; waiting..."
                : "Waiting: you're not live. Join a server voice channel and Go Live (any window works).");
        } else if (now.viewers > 0) {
            const turbo = CONFIG.turbo === "auto";
            claim = turbo ? TURBO_MS : MINUTE_MS;
            dropped = 0;
            setState(turbo ? "turbo" : "live", turbo
                ? `Live with ${now.viewers} viewer(s): Turbo on, ${span(TURBO_MS)} a minute.`
                : `Live with ${now.viewers} viewer(s): sending 1 minute a minute (Turbo off).`);
        } else if (CONFIG.noViewer === "drop") {
            claim = MINUTE_MS;
            if (state !== "dropped" || ++dropped % DROP_REMINDER_TICKS === 0) {
                console.warn(`${LABEL} ⚠ NOBODY IS WATCHING. Sending 1 minute a minute anyway (no-viewer mode: drop). ` +
                    "Discord isn't known to count stream time without a viewer, so this probably adds nothing. " +
                    "Have someone (an alt works) watch your stream.");
            }
            state = "dropped";
        } else {
            await closeSession();
            setState("paused", "⚠ Paused: nobody is watching. It picks up again when a viewer joins (no-viewer mode: pause).", "warn");
        }

        if (claim > 0) {
            claim = Math.min(claim, TARGET_MS - credited);
            if (session && session.key !== now.key) await closeSession();
            if (session && session.trackedMs + claim > SESSION_CAP_MS) await closeSession();
            if (stopped) return;
            const opened = session ? true : await openSession(now);
            const ok = opened && await sendBatch([streamEvent("video_stream_heartbeat", {
                duration_tracked_ms: claim,
                total_duration_ms: session.trackedMs + claim
            })], context, () => stopped);
            if (ok) {
                session.trackedMs += claim;
                credited += claim;
                failures = 0;
                if (!CONFIG.dryRun) saveProgress(context.userId, credited);
                const tag = CONFIG.dryRun ? "[dry-run] " : "";
                console.log(`${LABEL} ${tag}+${span(claim)}: ${span(credited)} of ${span(TARGET_MS)} ` +
                    `(${Math.min(100, (credited / TARGET_MS) * 100).toFixed(1)}%).`);
            } else if (!stopped && ++failures >= MAX_FAILURES) {
                console.warn(`${LABEL} ${MAX_FAILURES} requests in a row were rejected.`);
                await end(false);
                return;
            }
            if (credited >= TARGET_MS) {
                await end(true);
                return;
            }
        }
        schedule();
    }

    async function start(force) {
        const requireFn = webpackRequire();
        if (!requireFn) throw new Error("Discord's webpack registry was not found.");
        const client = quietly(() => findHttpClient(requireFn));
        if (!client) throw new Error("Discord's internal HTTP client could not be located.");
        store = quietly(() => findStreamingStore(requireFn));
        if (!store) throw new Error("Discord's ApplicationStreamingStore could not be located.");
        context = { ...(await getAuthContext(client)), client };
        lastUserId = context.userId;

        credited = loadProgress(context.userId);
        if (credited >= TARGET_MS) {
            console.log(`${LABEL} ${span(credited)} was already credited for ${context.username}, which reaches the ` +
                `${span(TARGET_MS)} target. Nothing to do. Run window.${NS}.resetProgress() to start over.`);
            return;
        }
        if (!CONFIG.dryRun) {
            const consent = await readConsent(client);
            if (consent.personalization === false && !force) {
                throw new Error("\"Use data to personalize my Discord experience\" is off (User Settings > Data & Privacy), " +
                    "so Discord won't count this. Turn it on, then run this again " +
                    `(or await window.${NS}.run({ force: true }) to send anyway).`);
            }
            if (consent.personalization === null) {
                console.warn(`${LABEL} Couldn't read "Use data to personalize my Discord experience"; make sure it's on.`);
            }
        }
        if (stopped) return;

        const turbo = CONFIG.turbo === "auto";
        const left = TARGET_MS - credited;
        const perMinute = turbo ? TURBO_MS : MINUTE_MS;
        console.log(`${LABEL} Connected as ${context.username} | target ${span(TARGET_MS)}` +
            (credited ? `, ${span(credited)} already credited` : "") + ` | Turbo ${turbo ? `on (${span(TURBO_MS)} a minute)` : "off"}` +
            ` | nobody watching: ${CONFIG.noViewer} | about ${Math.ceil(left / perMinute) - 1} min live with a viewer.`);
        if (CONFIG.noViewer === "drop") {
            console.warn(`${LABEL} ⚠ No-viewer mode is DROP: when nobody watches, it keeps sending 1 minute a minute, ` +
                "which probably counts for nothing. Keep a viewer on your stream.");
        }
        if (turbo) console.warn(`${LABEL} Turbo is untested: try a small target first and check your badge in 24-48h.`);
        if (CONFIG.dryRun) console.warn(`${LABEL} Dry-run mode is ON: nothing will be sent.`);

        running = true;
        const finished = new Promise(resolve => { finish = resolve; });
        await tick();
        return finished;
    }

    function run({ force = false } = {}) {
        if (stopped) return Promise.resolve();
        if (running) {
            console.warn(`${LABEL} Already running.`);
            return lastRun;
        }
        lastRun = start(force === true).then(() => credited / HOUR_MS);
        return lastRun;
    }

    async function stop() {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        const wasRunning = running;
        running = false;
        if (wasRunning) await closeSession();
        finish();
        releaseStorage(lastRun);
        if (window[NS]?.stop === stop) delete window[NS];
        console.log(`${LABEL} Stopped at ${span(credited)} of ${span(TARGET_MS)}.`);
    }

    function resetProgress() {
        delete window[PROGRESS_MEMORY_KEY];
        try {
            const storage = getStorage();
            const keys = [];
            for (let i = 0; i < (storage?.length ?? 0); i++) {
                const key = storage.key(i);
                if (key?.startsWith(`${PROGRESS_KEY}:`)) keys.push(key);
            }
            for (const key of keys) storage.removeItem(key);
        } catch (_) {}
        credited = 0;
        console.log(`${LABEL} Progress reset. The next run starts from 0.`);
    }

    window[NS] = {
        run,
        stop,
        resetProgress,
        get status() {
            return {
                running, state, creditedHours: credited / HOUR_MS, targetHours: CONFIG.targetHours,
                live: lastSeen.live, viewers: lastSeen.viewers, turbo: CONFIG.turbo, noViewer: CONFIG.noViewer,
                sessionHours: session ? session.trackedMs / HOUR_MS : 0
            };
        },
        get creditedHours() { return credited / HOUR_MS; },
        get savedHours() { return lastUserId ? loadProgress(lastUserId) / HOUR_MS : null; },
        get lastRun() { return lastRun; }
    };
    window.addEventListener("pagehide", () => { stop(); }, { once: true });

    console.log(`${LABEL} Ready: ${span(TARGET_MS)} of stream time. Starting in a moment...`);
    console.log(`${LABEL} Status: window.${NS}.status | Stop: window.${NS}.stop()`);

    setTimeout(() => {
        if (stopped) return;
        run().catch(error => console.warn(`${LABEL} Run failed: ${error.message}`));
    }, 1200);
})();
