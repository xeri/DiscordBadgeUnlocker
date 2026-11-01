// @@HEADER@@
(async () => {
    "use strict";

    // @@CONFIG@@

    const CHANGE_MS = CONFIG.rotateMinutes * 60 * 1000; // Rich Presence switches game on this interval, in table order
    const STAGGER_MINUTES = 25;
    const LAUNCH_OFFSET_MS = 300;          // gap between the first heartbeat and launch_game
    const FAKE_PID = 50000;

    const CLIENT_VERSION = "1.0.9253";
    const CLIENT_BUILD_NUMBER = 594031;
    const NATIVE_BUILD_NUMBER = 88414;
    const OS_VERSION = "10.0.26200";
    const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) discord/1.0.9253 Chrome/148.0.7778.280 " +
        "Electron/42.7.1 Safari/537.36";

    if (window[NS]) {
        console.warn(`${LABEL} Already running. To stop: window.${NS}.stop()`);
        return;
    }
    window[NS] = { loading: true };

    // Session IDs must stay unique per session; they do not change which games or hours are sent.
    const uuid = () => crypto.randomUUID();
    const isLinux = /Linux/i.test(navigator.userAgent);
    const basename = value => String(value ?? "").split(/[\\/]/).pop();
    const toBase64 = bytes => {
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    };
    const b64utf8 = value => toBase64(new TextEncoder().encode(value));
    const sha256 = async value => new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    );
    const sumHours = games => games.reduce((total, game) => total + game.hours, 0);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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

    function getWebpackRequire() {
        if (window.Vencord?.Webpack?.wreq?.c) return window.Vencord.Webpack.wreq;
        if (typeof webpackChunkdiscord_app === "undefined") return null;
        let req;
        webpackChunkdiscord_app.push([[Symbol("multi-game-presence")], {}, incoming => {
            if (Object.keys(incoming?.c ?? {}).length > Object.keys(req?.c ?? {}).length) req = incoming;
        }]);
        webpackChunkdiscord_app.pop();
        return req;
    }

    function collectExports(req) {
        return Object.values(req?.c ?? {}).flatMap(module => {
            try {
                const exp = module?.exports;
                if (!exp) return [];
                return [exp, exp.default, ...(typeof exp === "object" ? Object.values(exp) : [])];
            } catch (_) {
                return [];
            }
        }).filter(Boolean);
    }

    function findStore(exports, name) {
        return quietly(() => exports.find(value => {
            try {
                return value && typeof value === "object" &&
                    (value.getName?.() === name || value.__proto__?.constructor?.displayName === name);
            } catch (_) {
                return false;
            }
        }));
    }

    // Discord's translated messages are a Proxy that answers every property name with a function,
    // so they'd pass the Dispatcher check. A real object has nothing under a made-up name.
    function answersAnything(value) {
        try {
            return value[`__${NS}_probe`] !== undefined;
        } catch (_) {
            return true;
        }
    }

    function findDispatcher(exports) {
        return quietly(() => exports.find(value => {
            try {
                return value && !answersAnything(value) && typeof value.dispatch === "function" &&
                    typeof value.subscribe === "function" && value._subscriptions;
            } catch (_) {
                return false;
            }
        }));
    }

    try {
        validateGames();
        const req = getWebpackRequire();
        if (!req?.c) throw new Error("Discord Webpack registry was not found.");
        const exports = collectExports(req);
        const runStore = findStore(exports, "RunningGameStore");
        const dispatcher = findDispatcher(exports);
        if (!runStore || !dispatcher) throw new Error("RunningGameStore/Dispatcher was not found.");
        const authStore = findStore(exports, "AuthenticationStore");
        const userStore = findStore(exports, "UserStore");

        console.log(`${LABEL} Fixed list: ${GAMES.length} games, ${TOTAL_HOURS}h total.`);

        function getToken() {
            try {
                const token = authStore?.getToken?.();
                if (token && typeof token === "string") return token;
            } catch (_) {}
            return quietly(() => {
                for (const exp of exports) {
                    try {
                        if (exp && typeof exp.getToken === "function" && exp.getName?.() === "AuthenticationStore") {
                            const token = exp.getToken();
                            if (token && typeof token === "string") return token;
                        }
                    } catch (_) {}
                }
                return null;
            });
        }

        function getUserId(token) {
            try {
                const uid = userStore?.getCurrentUser?.()?.id || authStore?.getId?.();
                if (uid && /^\d+$/.test(uid)) return String(uid);
            } catch (_) {}
            try {
                const part = String(token ?? "").split(".")[0];
                if (part && part !== "mfa") {
                    const pad = "=".repeat((4 - (part.length % 4)) % 4);
                    const decoded = atob(part + pad);
                    if (/^\d+$/.test(decoded)) return decoded;
                }
            } catch (_) {}
            return "";
        }

        async function generateFingerprint(userId) {
            const out = new Uint8Array(146);
            out[0] = 1;
            out[1] = 3;
            const view = new DataView(out.buffer);
            view.setUint32(2, 45829120, true);
            view.setUint32(6, 0, true);
            view.setUint32(10, 1700000000, true);
            view.setUint32(14, 50000000, true);
            const [header, machine, sections, cert, key] = await Promise.all([
                sha256("header"),
                sha256(MACHINE_GUID + userId),
                sha256("sections"),
                sha256("cert"),
                sha256(userId + "https://discord.com/careers")
            ]);
            out.set(header, 18);
            out.set(machine, 50);
            out.set(sections, 82);
            out.set(cert, 114);
            for (let i = 1; i < out.length; i++) out[i] ^= key[(i - 1) & 31];
            return toBase64(out);
        }

        function buildSuperProps(launchSignature, heartbeatSession, clientLaunchId) {
            return b64utf8(JSON.stringify({
                os: "Windows",
                browser: "Discord Client",
                release_channel: "stable",
                client_version: CLIENT_VERSION,
                os_version: OS_VERSION,
                os_arch: "x64",
                app_arch: "x64",
                system_locale: "en-US",
                has_client_mods: false,
                browser_user_agent: USER_AGENT,
                browser_version: "42.7.1",
                os_sdk_version: "26200",
                client_build_number: CLIENT_BUILD_NUMBER,
                native_build_number: NATIVE_BUILD_NUMBER,
                client_event_source: null,
                client_app_state: "focused",
                client_launch_id: clientLaunchId,
                launch_signature: launchSignature,
                client_heartbeat_session_id: heartbeatSession
            }));
        }

        const launchSignature = uuid();
        const heartbeatSession = uuid();
        const clientLaunchId = uuid();
        const superProps = buildSuperProps(launchSignature, heartbeatSession, clientLaunchId);
        let auth = null;

        async function getAnalyticsToken(token) {
            try {
                const res = await fetch("/api/v9/users/@me?with_analytics_token=true", {
                    headers: {
                        "authorization": token,
                        "x-super-properties": superProps
                    }
                });
                if (!res.ok) return null;
                const data = await res.json();
                return data.analytics_token ?? null;
            } catch (_) {
                return null;
            }
        }

        async function prepareAuth() {
            if (auth) return auth;
            const token = getToken();
            if (!token) throw new Error("Discord token could not be found.");
            const userId = getUserId(token);
            if (!userId) throw new Error("Discord user ID could not be decoded.");
            const analyticsToken = await getAnalyticsToken(token);
            if (!analyticsToken) throw new Error("analytics_token could not be retrieved.");
            const fingerprint = await generateFingerprint(userId);
            auth = { token, userId, analyticsToken, fingerprint, superProps };
            return auth;
        }

        // Discord's /users/@me/consent. "personalization" is "Use data to personalize my Discord
        // experience", which badge progress needs; "usage_statistics" is "Use data to improve Discord".
        async function readConsent(currentAuth) {
            const unknown = { personalization: null, usage: null };
            try {
                const res = await fetch("/api/v9/users/@me/consent", {
                    headers: { "authorization": currentAuth.token, "x-super-properties": currentAuth.superProps }
                });
                if (!res.ok) return unknown;
                const data = await res.json();
                const flag = value => (typeof value === "boolean" ? value : null);
                return { personalization: flag(data?.personalization?.consented), usage: flag(data?.usage_statistics?.consented) };
            } catch (_) {
                return unknown;
            }
        }

        let seq = 0;
        const nextSeq = () => ++seq;

        const buildSessionEvents = (game, fingerprint, gameIndex = 0) => {
            const durationMs = Math.round(game.hours * 3600 * 1000);
            const sessionId = uuid();
            const offsetMs = gameIndex * (STAGGER_MINUTES * 60 * 1000);
            const now = Date.now() - offsetMs;
            const start = Math.max(0, now - durationMs);
            if (TRACK_START_MS !== null && start < TRACK_START_MS) {
                console.warn(`${LABEL} ${game.name} would start before ${new Date(TRACK_START_MS).toISOString().slice(0, 10)} ` +
                    `(${new Date(start).toISOString()}).`);
            }

            const launchProps = {
                client_track_timestamp: start + LAUNCH_OFFSET_MS,
                client_heartbeat_session_id: heartbeatSession,
                event_sequence_number: nextSeq(),
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
                launch_signature: launchSignature,
                client_rtc_state: null,
                client_app_state: "focused",
                client_send_timestamp: start + LAUNCH_OFFSET_MS
            };

            // The first heartbeat opens the session at `start`, the final one closes it at `now` with the full
            // duration. Sequence numbers follow creation order: launch_game, then the two heartbeats.
            const heartbeat = (timestamp, final) => ({
                type: "running_game_heartbeat",
                properties: {
                    client_track_timestamp: timestamp,
                    client_heartbeat_session_id: heartbeatSession,
                    event_sequence_number: nextSeq(),
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
                    launch_signature: launchSignature,
                    client_app_state: "focused",
                    client_send_timestamp: timestamp
                }
            });
            return [heartbeat(start, false), { type: "launch_game", properties: launchProps }, heartbeat(now, true)];
        };

        async function postScienceEvents(events, currentAuth, retry = 0) {
            try {
                const res = await fetch("/api/v9/science", {
                    method: "POST",
                    headers: {
                        "accept": "*/*",
                        "accept-language": "en-US",
                        "authorization": currentAuth.token,
                        "content-type": "application/json",
                        "origin": "https://discord.com",
                        "referer": "https://discord.com/channels/@me",
                        "x-super-properties": currentAuth.superProps
                    },
                    referrer: "https://discord.com/channels/@me",
                    body: JSON.stringify({ token: currentAuth.analyticsToken, events })
                });
                if (res.status === 204 || res.status === 200) return true;
                if (res.status === 429 && retry < 3) {
                    const retryHeader = res.headers.get("retry-after");
                    const waitSec = retryHeader ? parseFloat(retryHeader) : 2.5;
                    console.warn(`${LABEL} Rate limited (429). Retrying in ${waitSec.toFixed(1)}s...`);
                    await wait(Math.max(waitSec * 1000, 2000));
                    return await postScienceEvents(events, currentAuth, retry + 1);
                }
                const text = await res.text().catch(() => "");
                console.warn(`${LABEL} Science request returned ${res.status}` +
                    (text ? `: ${text.slice(0, 200)}` : ""));
                return false;
            } catch (err) {
                if (retry < 2) {
                    await wait(1500);
                    return await postScienceEvents(events, currentAuth, retry + 1);
                }
                throw err;
            }
        }

        const original = {};
        const patchable = [
            "getRunningGames", "getGameForPID", "getVisibleGame", "getVisibleRunningGames",
            "getCandidateGames", "getRunningDiscordApplicationIds"
        ];
        for (const key of patchable) {
            if (typeof runStore[key] === "function") original[key] = runStore[key];
        }
        if (!original.getRunningGames || !original.getGameForPID) {
            throw new Error("Required RunningGameStore methods were not found.");
        }

        const pid = FAKE_PID;
        let index = 0;
        let current = null;
        let timer = null;
        let stopped = false;

        const buildGame = entry => {
            const exeName = basename(entry.exe);
            const exePath = isLinux
                ? `/home/user/.local/share/Steam/steamapps/common/${entry.name}/${exeName}`
                : `C:\\Program Files (x86)\\Steam\\steamapps\\common\\${entry.name}\\${exeName}`;
            return {
                id: entry.id,
                name: entry.name,
                pid,
                pidPath: [pid],
                processName: entry.name,
                start: Date.now(),
                exeName,
                exePath,
                cmdLine: exePath,
                executables: [{ os: isLinux ? "linux" : "win32", name: exeName, is_launcher: false }],
                windowHandle: 0,
                fullscreenType: 0,
                overlay: false,
                sandboxed: false,
                hidden: false,
                isLauncher: false
            };
        };

        const realGames = () => (original.getRunningGames.call(runStore) ?? [])
            .filter(game => game?.pid !== pid);
        runStore.getRunningGames = () => current ? [...realGames(), current] : realGames();
        runStore.getGameForPID = value => value === pid && current
            ? current
            : original.getGameForPID.call(runStore, value);
        if (original.getVisibleGame) {
            runStore.getVisibleGame = () => current ?? original.getVisibleGame.call(runStore);
        }
        // Lists of games: the real ones (minus any stale fake) plus the current fake game.
        for (const key of ["getVisibleRunningGames", "getCandidateGames"]) {
            if (!original[key]) continue;
            runStore[key] = () => current
                ? [...(original[key].call(runStore) ?? []).filter(game => game?.pid !== pid), current]
                : original[key].call(runStore);
        }
        if (original.getRunningDiscordApplicationIds) {
            runStore.getRunningDiscordApplicationIds = () => {
                const ids = (original.getRunningDiscordApplicationIds.call(runStore) ?? [])
                    .filter(id => !current || id !== current.id);
                return current?.id ? [...ids, current.id] : ids;
            };
        }

        const dispatchRemoval = game => {
            if (!game) return;
            dispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", added: [], removed: [game], games: realGames() });
            dispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", socketId: null, pid, activity: null });
        };

        const activate = entry => {
            const previous = current;
            if (previous) dispatchRemoval(previous);
            current = buildGame(entry);
            dispatcher.dispatch({
                type: "RUNNING_GAMES_CHANGE",
                added: [current],
                removed: [],
                games: runStore.getRunningGames()
            });
            dispatcher.dispatch({
                type: "LOCAL_ACTIVITY_UPDATE",
                socketId: null,
                pid,
                activity: {
                    name: current.name,
                    type: 0,
                    application_id: current.id,
                    details: null,
                    state: null,
                    timestamps: { start: current.start },
                    assets: null
                }
            });
            console.log(`${LABEL} ${index + 1}/${GAMES.length}: ${current.name} (App ID: ${current.id})`);
        };

        const scheduleNext = () => {
            timer = setTimeout(() => {
                next();
                scheduleNext();
            }, CHANGE_MS);
            console.log(`${LABEL} Next transition in ${Math.round(CHANGE_MS / 1000)} seconds.`);
        };

        const next = () => {
            index = (index + 1) % GAMES.length;
            activate(GAMES[index]);
        };

        let isClaiming = false;
        const claim = async (count = GAMES.length, delayMs = CONFIG.delayMs, batchSize = CONFIG.batchSize) => {
            if (stopped) return 0;
            if (isClaiming) {
                console.warn(`${LABEL} Claim already running. Please wait for the current batch to complete.`);
                return 0;
            }
            const total = Math.min(count, GAMES.length);
            if (!Number.isFinite(total) || total <= 0) {
                console.warn(`${LABEL} Invalid claim count.`);
                return 0;
            }

            isClaiming = true;
            try {
                const currentAuth = await prepareAuth();
                if (stopped) return 0;
                console.log(`${LABEL} User ID: ${currentAuth.userId}`);
                console.log(`${LABEL} ✓ Stable executable fingerprint ready.`);

                // Only games not yet sent to this account (by any of the three scripts). Already-sent
                // games are never sent again, so the profile total stays at the table's hours.
                const claimedSet = getClaimedSet(currentAuth.userId);
                const targetGames = GAMES.filter(g => !claimedSet.has(g.id)).slice(0, total);
                if (!targetGames.length) {
                    console.log(`${LABEL} All ${GAMES.length} games (${TOTAL_HOURS}h) were already sent. Nothing to do. ` +
                        `Run window.${NS}.resetClaimed() first if you really want to send them again.`);
                    return 0;
                }
                if (!CONFIG.dryRun) {
                    // Without the personalization setting nothing counts, so don't mark games as sent.
                    const consent = await readConsent(currentAuth);
                    if (consent.personalization === false) {
                        throw new Error("\"Use data to personalize my Discord experience\" is off (User Settings > " +
                            "Data & Privacy), so Discord won't count this. Turn it on, then paste this again.");
                    }
                    if (consent.personalization === null) {
                        console.warn(`${LABEL} Couldn't read "Use data to personalize my Discord experience"; make sure it's on.`);
                    }
                    if (consent.usage === false) {
                        console.warn(`${LABEL} "Use data to improve Discord" is off. Discord's help article only needs the ` +
                            "personalization setting, but turn this on too if the badges don't move.");
                    }
                    if (stopped) return 0;
                }
                console.log(`${LABEL} Claiming ${targetGames.length} games ` +
                    `(${sumHours(targetGames).toFixed(1)}h, fixed hours per game, ${batchSize}/batch, ${delayMs}ms delay)...`);
                if (CONFIG.dryRun) console.warn(`${LABEL} Dry-run mode is ON: nothing will be sent.`);

                let claimed = 0;
                let claimedHours = 0;
                for (let i = 0; i < targetGames.length; i += batchSize) {
                    if (stopped) {
                        console.warn(`${LABEL} Claim stopped.`);
                        break;
                    }
                    const chunk = targetGames.slice(i, i + batchSize);
                    const events = chunk.flatMap((game, idx) =>
                        buildSessionEvents(game, currentAuth.fingerprint, i + idx)
                    );
                    let ok = false;
                    try {
                        ok = CONFIG.dryRun ? true : await postScienceEvents(events, currentAuth);
                    } catch (err) {
                        console.warn(`${LABEL} Batch at ${i} failed: ${err.message}`);
                    }
                    if (ok) {
                        claimed += chunk.length;
                        claimedHours += sumHours(chunk);
                        if (!CONFIG.dryRun) {
                            for (const g of chunk) claimedSet.add(g.id);
                            saveClaimedSet(currentAuth.userId, claimedSet);
                        }
                        console.log(`${LABEL} ${CONFIG.dryRun ? "[dry-run] " : ""}Progress: ${claimed}/${targetGames.length} games accepted ` +
                            `(+${sumHours(chunk).toFixed(1)}h, ${claimedHours.toFixed(1)}h this run, ${claimedSet.size}/${GAMES.length} sent overall).`);
                    } else {
                        console.warn(`${LABEL} Batch starting at index ${i} failed.`);
                    }
                    if (i + batchSize < targetGames.length && !stopped) {
                        await wait(delayMs);
                    }
                }
                console.log(`${LABEL} Finished! ${claimed}/${targetGames.length} games accepted ` +
                    `(${claimedHours.toFixed(1)}h). Sent overall: ${claimedSet.size}/${GAMES.length} games.`);
                return claimed;
            } finally {
                isClaiming = false;
            }
        };

        const stop = () => {
            if (stopped) return;
            stopped = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            const previous = current;
            current = null;
            for (const [key, fn] of Object.entries(original)) runStore[key] = fn;
            dispatchRemoval(previous);
            releaseStorage(lastRun);
            delete window[NS];
            console.log(`${LABEL} Stopped and store restored.`);
        };

        const resetClaimed = () => {
            resetClaimedSet();
            console.log(`${LABEL} Claimed history reset. The next claim sends every game again.`);
        };

        let lastRun = null;
        window[NS] = {
            stop,
            next,
            claim,
            resetClaimed,
            get games() { return GAMES.map(game => game.name); },
            get table() { return GAMES.map(game => ({ ...game })); },
            get totalHours() { return TOTAL_HOURS; },
            get current() { return current?.name ?? null; },
            get currentGame() { return current; },
            get claimedCount() { return auth ? getClaimedSet(auth.userId).size : null; },
            get lastRun() { return lastRun; }
        };
        window.addEventListener("pagehide", stop, { once: true });

        activate(GAMES[index]);
        scheduleNext();
        console.log(`${LABEL} ${GAMES.length} games loaded (${TOTAL_HOURS}h total).`);
        console.log(`${LABEL} To stop: window.${NS}.stop()`);
        console.log(`${LABEL} Auto claim: ${GAMES.length}/${GAMES.length} games, ${TOTAL_HOURS}h total.`);
        lastRun = claim()
            .catch(err => {
                console.warn(`${LABEL} Auto claim failed: ${err.message}`);
                return 0;
            })
            .finally(() => {
                // A rotating Rich Presence makes Discord log real play time on top of the table.
                if (!CONFIG.keepRotating && !stopped) {
                    console.log(`${LABEL} Claim finished; stopping the Rich Presence rotation (keepRotating: false).`);
                    stop();
                }
            });
    } catch (err) {
        delete window[NS];
        console.error(LABEL, err);
    }
})();
