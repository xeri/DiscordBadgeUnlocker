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

    function webpackRequire() {
        const requireFn = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]);
        webpackChunkdiscord_app.pop();
        return requireFn;
    }

    // Discord's translated messages are a Proxy that answers every property name with a function,
    // so they'd pass the HTTP client check. A real object has nothing under a made-up name.
    function answersAnything(value) {
        try {
            return value[`__${NS}_probe`] !== undefined;
        } catch (_) {
            return true;
        }
    }

    const HTTP_METHODS = ["get", "post", "del"];

    function isHttpClient(candidate) {
        return candidate != null && !answersAnything(candidate) &&
            HTTP_METHODS.every(method => typeof candidate[method] === "function");
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

    async function getAuthContext(client) {
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

    // Seconds Discord asks to wait after a 429, from the body (retry_after) or the Retry-After header.
    function retryAfterOf(response) {
        const fromBody = Number(response?.body?.retry_after);
        if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
        let raw = null;
        try {
            const headers = response?.headers;
            raw = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
        } catch (_) {}
        const seconds = parseFloat(raw);
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    }

    // Retries rate limits (up to 3 times, waiting as long as Discord asks) and requests that got no
    // answer (twice), resending the same events with the same session IDs.
    async function sendBatch(events, context) {
        if (CONFIG.dryRun) return true;
        let limited = 0;
        let lost = 0;
        for (;;) {
            let status;
            let retryAfter = null;
            try {
                // The client attaches auth and super-properties headers itself.
                const response = await context.client.post({
                    url: "/science",
                    body: { token: context.analyticsToken, events }
                });
                if (response?.ok || response?.status === 200 || response?.status === 204) return true;
                status = response?.status;
                retryAfter = retryAfterOf(response);
            } catch (error) {
                status = error?.status ?? error?.statusCode ?? 0;
                retryAfter = retryAfterOf(error);
            }
            if (status === 429 && limited < 3) {
                limited += 1;
                const seconds = Math.min(60, Math.max(2, retryAfter ?? 2.5));
                console.warn(`${LABEL} Rate limited (429). Retrying in ${seconds.toFixed(1)}s...`);
                await wait(seconds * 1000);
            } else if (status === 0 && lost < 2) {
                lost += 1;
                console.warn(`${LABEL} No answer from Discord. Retrying in 1.5s...`);
                await wait(1500);
            } else {
                if (status) console.warn(`${LABEL} /science returned ${status}.`);
                return false;
            }
            if (stopped) return false;
        }
    }

    // Discord's /users/@me/consent. "personalization" is "Use data to personalize my Discord experience",
    // which badge progress needs; "usage_statistics" is "Use data to improve Discord". null: unknown.
    async function readConsent(client) {
        try {
            const response = await client.get({ url: "/users/@me/consent" });
            const flag = value => (typeof value === "boolean" ? value : null);
            return {
                personalization: flag(response?.body?.personalization?.consented),
                usage: flag(response?.body?.usage_statistics?.consented)
            };
        } catch (_) {
            return { personalization: null, usage: null };
        }
    }

    // ---------- clock ----------
    // The page clock shift swaps the page's Date and Intl.DateTimeFormat for versions that read the target
    // time (plus whatever time passes) and, with TIME_ZONE set, behave as if the computer were in that zone:
    // Date(), new Date(), Date.now/parse, local getters and setters, getTimezoneOffset, toString,
    // toDateString, toTimeString, toLocale*String and Intl.DateTimeFormat (format, formatToParts,
    // formatRange, resolvedOptions). Discord's own code sees it too while the session is sent; then
    // everything is put back exactly as it was.
    const RealDate = Date;
    const RealDTF = Intl.DateTimeFormat;
    const realNow = () => RealDate.now();
    const proto = RealDate.prototype;
    const ORIGINAL = {};
    for (const key of Object.getOwnPropertyNames(proto)) ORIGINAL[key] = proto[key];
    const getTime = d => ORIGINAL.getTime.call(d);
    const iso = ms => ORIGINAL.toISOString.call(new RealDate(ms)).replace(".000Z", "Z");

    // UTC ms from calendar fields, normalising overflow (month 13, day 0...) like Date does; years 0-99 kept as-is.
    function utcMs(f) {
        const values = [f.y, f.mo, f.d, f.h, f.mi, f.s, f.ms].map(Number);
        if (values.some(v => !Number.isFinite(v))) return NaN;
        const t = new RealDate(0);
        ORIGINAL.setUTCFullYear.call(t, values[0], values[1], values[2]);
        ORIGINAL.setUTCHours.call(t, values[3], values[4], values[5], values[6]);
        return getTime(t);
    }

    function zoneTools(timeZone) {
        const parts = new RealDTF("en-US", {
            timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
            hour: "numeric", minute: "numeric", second: "numeric"
        });
        const names = new RealDTF("en-US", { timeZone, timeZoneName: "long" });
        let cache = { ms: NaN, f: null };
        const fields = ms => {
            if (cache.ms === ms) return { ...cache.f };
            const o = {};
            for (const p of parts.formatToParts(ms)) o[p.type] = p.value;
            const f = { y: +o.year, mo: +o.month - 1, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, ms: ((ms % 1000) + 1000) % 1000 };
            if (o.era === "BC" || o.era === "B") f.y = 1 - f.y;
            cache = { ms, f };
            return { ...f };
        };
        const offsetMin = ms => Math.round((utcMs(fields(ms)) - ms) / 60000); // minutes east of UTC
        const toUtc = f => {
            const guess = utcMs(f);
            if (!Number.isFinite(guess)) return NaN;
            const first = guess - offsetMin(guess) * 60000;
            return guess - offsetMin(first) * 60000;
        };
        const zoneName = ms => names.formatToParts(ms).find(p => p.type === "timeZoneName")?.value ?? timeZone;
        return { fields, offsetMin, toUtc, zoneName };
    }

    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");

    function shiftClock(targetMs, timeZone) {
        const offset = targetMs - realNow();
        const fakeNow = () => realNow() + offset;
        const zone = timeZone ? zoneTools(timeZone) : null;
        const patched = {};

        // Strings and fields in the spoofed zone (only used when TIME_ZONE is set).
        const dateString = t => {
            const f = zone.fields(t);
            const y = f.y < 0 ? `-${pad(f.y, 6)}` : pad(f.y, 4);
            return `${DAYS[new RealDate(utcMs({ ...f, h: 0, mi: 0, s: 0, ms: 0 })).getUTCDay()]} ${MONTHS[f.mo]} ${pad(f.d)} ${y}`;
        };
        const timeString = t => {
            const f = zone.fields(t);
            const off = zone.offsetMin(t);
            return `${pad(f.h)}:${pad(f.mi)}:${pad(f.s)} GMT${off < 0 ? "-" : "+"}${pad(Math.trunc(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)} (${zone.zoneName(t)})`;
        };
        const fullString = t => (Number.isNaN(t) ? "Invalid Date" : `${dateString(t)} ${timeString(t)}`);

        // Strings with no zone designator (other than date-only ISO) are local time, so re-read them in the zone.
        const explicitZone = s => /(?:Z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|UT)\b[^)]*)\s*(?:\(.*\))?$/i.test(s) ||
            /^[+-]?\d{4,6}(?:-\d{2}(?:-\d{2})?)?$/.test(s);
        const fakeParse = value => {
            const real = RealDate.parse(value);
            const s = String(value).trim();
            if (!zone || Number.isNaN(real) || explicitZone(s)) return real;
            const d = new RealDate(real); // parsed in the real zone: take its local fields, place them in the fake zone
            return zone.toUtc({
                y: ORIGINAL.getFullYear.call(d), mo: ORIGINAL.getMonth.call(d), d: ORIGINAL.getDate.call(d),
                h: ORIGINAL.getHours.call(d), mi: ORIGINAL.getMinutes.call(d), s: ORIGINAL.getSeconds.call(d), ms: ORIGINAL.getMilliseconds.call(d)
            });
        };
        const fromParts = args => {
            let y = Number(args[0]);
            if (Number.isInteger(y) && y >= 0 && y <= 99) y += 1900;
            const f = { y, mo: args[1], d: args[2] ?? 1, h: args[3] ?? 0, mi: args[4] ?? 0, s: args[5] ?? 0, ms: args[6] ?? 0 };
            return zone ? zone.toUtc(f) : getTime(new RealDate(...args));
        };

        function Date(...args) {
            if (!new.target) return zone ? fullString(fakeNow()) : ORIGINAL.toString.call(new RealDate(fakeNow()));
            let ms;
            if (args.length === 0) ms = fakeNow();
            else if (args.length === 1) {
                const v = args[0];
                const prim = v instanceof RealDate ? getTime(v) : typeof v === "object" && v !== null ? v.valueOf() : v;
                ms = typeof prim === "string" ? fakeParse(prim) : getTime(new RealDate(prim));
            } else ms = fromParts(args);
            return Reflect.construct(RealDate, [ms], new.target);
        }
        Object.defineProperty(Date, "length", { value: 7 });
        Object.setPrototypeOf(Date, RealDate);
        Date.prototype = proto;
        Date.now = fakeNow;
        Date.parse = fakeParse;
        Date.UTC = RealDate.UTC;

        if (zone) {
            const local = (fn, nan = NaN) => function (...args) {
                const t = getTime(this);
                return Number.isNaN(t) ? nan : fn(t, args);
            };
            const field = key => local(t => zone.fields(t)[key]);
            Object.assign(patched, {
                getFullYear: field("y"), getMonth: field("mo"), getDate: field("d"),
                getHours: field("h"), getMinutes: field("mi"), getSeconds: field("s"),
                getDay: local(t => new RealDate(utcMs({ ...zone.fields(t), h: 0, mi: 0, s: 0, ms: 0 })).getUTCDay()),
                getYear: local(t => zone.fields(t).y - 1900),
                getTimezoneOffset: local(t => -zone.offsetMin(t)),
                toString: function () { return fullString(getTime(this)); },
                toDateString: local(dateString, "Invalid Date"),
                toTimeString: local(timeString, "Invalid Date")
            });
            // setX(...): change local fields in the zone, convert back to a time value.
            const setter = (keys, fullYear = false) => function (...args) {
                let t = getTime(this);
                if (Number.isNaN(t)) {
                    if (!fullYear) return NaN;
                    t = zone.toUtc({ y: 1970, mo: 0, d: 1, h: 0, mi: 0, s: 0, ms: 0 });
                }
                const f = zone.fields(t);
                keys.forEach((key, i) => { if (i === 0 || args.length > i) f[key] = Number(args[i]); });
                const next = zone.toUtc(f);
                ORIGINAL.setTime.call(this, next);
                return getTime(this);
            };
            Object.assign(patched, {
                setFullYear: setter(["y", "mo", "d"], true), setMonth: setter(["mo", "d"]), setDate: setter(["d"]),
                setHours: setter(["h", "mi", "s", "ms"]), setMinutes: setter(["mi", "s", "ms"]), setSeconds: setter(["s", "ms"]),
                setMilliseconds: setter(["ms"])
            });
            for (const key of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
                patched[key] = function (locales, options) {
                    const opts = options == null ? { timeZone } : options.timeZone === undefined ? { ...options, timeZone } : options;
                    return ORIGINAL[key].call(this, locales, opts);
                };
            }
        }

        // Intl.DateTimeFormat: defaults to the zone, and format()/formatToParts() with no date use the shifted now.
        function DateTimeFormat(locales, options) {
            const opts = zone && (options == null || options.timeZone === undefined) ? { ...(options ?? {}), timeZone } : options;
            const dtf = new RealDTF(locales, opts);
            const realFormat = dtf.format;
            const realParts = RealDTF.prototype.formatToParts;
            Object.defineProperty(dtf, "format", { configurable: true, get: () => d => realFormat(d === undefined ? fakeNow() : d) });
            Object.defineProperty(dtf, "formatToParts", { configurable: true, writable: true, value: d => realParts.call(dtf, d === undefined ? fakeNow() : d) });
            return dtf;
        }
        Object.defineProperty(DateTimeFormat, "length", { value: 0 });
        DateTimeFormat.prototype = RealDTF.prototype;
        DateTimeFormat.supportedLocalesOf = RealDTF.supportedLocalesOf;

        for (const [key, fn] of Object.entries(patched)) {
            Object.defineProperty(proto, key, { value: fn, writable: true, configurable: true, enumerable: false });
        }
        Object.defineProperty(proto, "constructor", { value: Date, writable: true, configurable: true, enumerable: false });
        globalThis.Date = Date;
        Intl.DateTimeFormat = DateTimeFormat;

        return function restore() {
            for (const key of [...Object.keys(patched), "constructor"]) {
                Object.defineProperty(proto, key, { value: ORIGINAL[key], writable: true, configurable: true, enumerable: false });
            }
            globalThis.Date = RealDate;
            Intl.DateTimeFormat = RealDTF;
        };
    }

    // ---------- session ----------

    // One session: first heartbeat at `start`, launch_game with it, final heartbeat `durationMs` later.
    function sessionEvents(start, durationMs, fingerprint, state) {
        const end = start + durationMs;
        const sessionId = uuid();
        const heartbeat = (at, first, tracked) => ({
            type: "running_game_heartbeat",
            properties: {
                client_track_timestamp: at,
                client_heartbeat_session_id: state.heartbeat,
                game_id: GAME.id,
                game_name: GAME.name,
                game_metadata: null,
                game_executable: GAME.exe,
                game_detection_enabled: true,
                initial_heartbeat: first,
                final_heartbeat: !first,
                game_session_id: sessionId,
                duration_tracked_ms: tracked,
                rtc_connection_id: null,
                media_session_id: null,
                launch_signature: state.signature,
                client_app_state: "focused",
                client_send_timestamp: at
            }
        });
        const launch = {
            type: "launch_game",
            properties: {
                client_track_timestamp: start,
                client_heartbeat_session_id: state.heartbeat,
                game: GAME.name,
                game_id: GAME.id,
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
                executable_path: GAME.exe,
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
                client_send_timestamp: start
            }
        };
        const events = [heartbeat(start, true, 0), launch, heartbeat(end, false, durationMs)];
        for (const event of events) event.properties.event_sequence_number = ++state.sequence;
        return events;
    }

    // How long the session runs, and what the page clock should read while it's sent (null: real clock).
    // Backdate + a clock: the clock sits at the session's end and the start is backtracked by the hours,
    // like the main script. A clock alone: the clock sits at the first heartbeat.
    function plan(force) {
        const now = realNow();
        const durationMs = CONFIG.untilNow ? now - FIRST_MS : Math.round(CONFIG.hours * 3600000);
        const clockAt = CONFIG.clock === "off" ? null : CONFIG.backdate ? FIRST_MS + durationMs : FIRST_MS;
        if (CONFIG.clock === "system") {
            // `now` is your computer's clock here, so it should already be close to clockAt.
            if (Math.abs(now - clockAt) > CONFIG.clockToleranceMs && !force) {
                throw new Error(`System clock reads ${iso(now)}, but this run needs about ${iso(clockAt)}. ` +
                    "Set your computer's date and time, restart Discord, then paste this again " +
                    `(or window.${NS}.run({ force: true }) to go anyway; the page clock still lands on ${iso(clockAt)}).`);
            }
            return { durationMs, clockAt };
        }
        if (FIRST_MS >= now) throw new Error(`${iso(FIRST_MS)} is in the future.`);
        if (FIRST_MS + durationMs > now) {
            throw new Error(`${iso(FIRST_MS)} + ${CONFIG.hours}h ends in the future (${iso(FIRST_MS + durationMs)}). Pick fewer hours or an earlier date.`);
        }
        return { durationMs, clockAt };
    }

    const state = { heartbeat: uuid(), signature: uuid(), sequence: 0 };
    let running = false;
    let stopped = false;
    let lastRun = null;

    async function send(force) {
        const requireFn = webpackRequire();
        if (!requireFn?.c) throw new Error("Discord's webpack registry was not found.");
        const client = findHttpClient(requireFn);
        if (!client) throw new Error("Discord's internal HTTP client could not be located.");
        const context = { ...(await getAuthContext(client)), client };
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
        const { durationMs, clockAt } = plan(force);
        const hours = durationMs / 3600000;
        const methods = [CONFIG.backdate && "backdate", CONFIG.clock === "page" && "page clock",
            CONFIG.clock === "system" && "system + page clock"].filter(Boolean).join(" + ");

        console.log(`${LABEL} Connected as ${context.username} | ${GAME.name}: ${hours.toFixed(1)}h, ${methods}` +
            (clockAt === null ? "" : `, page clock at ${iso(clockAt)}${TIME_ZONE ? ` (${TIME_ZONE})` : ""}`));
        if (CONFIG.dryRun) console.warn(`${LABEL} Dry-run mode is ON: nothing will be sent.`);
        if (stopped) return null;

        let restore = null;
        let accepted = false;
        let start = FIRST_MS;
        try {
            if (clockAt !== null) {
                restore = shiftClock(clockAt, TIME_ZONE);
                const at = Date.now(); // the shifted clock
                start = CONFIG.backdate ? at - durationMs : at;
            }
            accepted = await sendBatch(sessionEvents(start, durationMs, context.fingerprint, state), context);
        } finally {
            restore?.();
        }

        const tag = CONFIG.dryRun ? "[dry-run] " : "";
        if (accepted) {
            console.log(`${LABEL} ${tag}Accepted: ${GAME.name} from ${iso(start)} to ${iso(start + durationMs)} (+${hours.toFixed(1)}h). ` +
                "Each run sends another session.");
        } else {
            console.warn(`${LABEL} The session was rejected.`);
        }
        return accepted ? { start, durationMs, hours } : null;
    }

    function run({ force = false } = {}) {
        if (stopped) return Promise.resolve(null);
        if (running) {
            console.warn(`${LABEL} A run is already in progress.`);
            return lastRun;
        }
        running = true;
        lastRun = send(force).finally(() => { running = false; });
        return lastRun;
    }

    function stop() {
        if (stopped) return;
        stopped = true;
        if (window[NS]?.stop === stop) delete window[NS];
        console.log(`${LABEL} Stopped.`);
    }

    window[NS] = {
        run,
        stop,
        get game() { return { ...GAME }; },
        get firstHeartbeat() { return iso(FIRST_MS); },
        get methods() { return { backdate: CONFIG.backdate, clock: CONFIG.clock, timeZone: TIME_ZONE }; },
        shiftClock, // shiftClock(ms, timeZone?) returns restore(); for testing the clock by hand
        get lastRun() { return lastRun; }
    };
    window.addEventListener("pagehide", stop, { once: true });

    console.log(`${LABEL} Ready: ${GAME.name}, first heartbeat ${iso(FIRST_MS)}. Starting in a moment...`);
    console.log(`${LABEL} Manual: await window.${NS}.run()`);
    console.log(`${LABEL} Stop: window.${NS}.stop()`);

    setTimeout(() => {
        if (stopped) return;
        run().catch(error => console.warn(`${LABEL} Run failed: ${error.message}`));
    }, 1200);
})();
