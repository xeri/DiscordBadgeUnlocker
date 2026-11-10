    // ===== Discord client (generated; identical in all scripts) =====
    // How the scripts reach Discord: its webpack registry and its own HTTP client, which adds the
    // auth and super-properties headers itself, so no script reads the token.
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    function registrySize(requireFn) {
        try {
            return Object.keys(requireFn?.c ?? {}).length;
        } catch (_) {
            return 0;
        }
    }

    // Discord's webpack require, from Vencord or a chunk push. Client mods can run more than one
    // webpack runtime, so keep the one with the most modules.
    function webpackRequire() {
        let found = null;
        try {
            const wreq = window.Vencord?.Webpack?.wreq;
            if (wreq?.c) found = wreq;
        } catch (_) {}
        try {
            if (typeof webpackChunkdiscord_app !== "undefined") {
                webpackChunkdiscord_app.push([[Symbol(NS)], {}, requireFn => {
                    if (requireFn?.c && (!found || registrySize(requireFn) > registrySize(found))) found = requireFn;
                }]);
                webpackChunkdiscord_app.pop();
            }
        } catch (_) {}
        return found?.c ? found : null;
    }

    // Discord's translated messages are a Proxy that answers every property name with a function,
    // so they'd pass the HTTP client and Dispatcher checks. A real object has nothing under a made-up name.
    function answersAnything(value) {
        try {
            return value[`__${NS}_probe`] !== undefined;
        } catch (_) {
            return true;
        }
    }

    function isHttpClient(candidate) {
        return candidate != null && !answersAnything(candidate) &&
            typeof candidate.get === "function" && typeof candidate.post === "function" &&
            (typeof candidate.del === "function" || typeof candidate.delete === "function");
    }

    function exportedValues(value) {
        if (!value || (typeof value !== "object" && typeof value !== "function")) return [];
        return [value, value.default, ...Object.values(value)];
    }

    // Vencord's RestAPI if it's there, then the module whose source mentions HTTPUtils, then any cached export.
    function findHttpClient(requireFn) {
        try {
            const rest = window.Vencord?.Webpack?.Common?.RestAPI;
            if (isHttpClient(rest)) return rest;
        } catch (_) {}
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

    // The analytics token /science wants, and who's logged in.
    async function getAuthContext(client) {
        const response = await client.get({ url: "/users/@me", query: { with_analytics_token: true } });
        const profile = response?.body ?? {};
        const analyticsToken = profile.analytics_token;
        const userId = profile.id == null ? "" : String(profile.id);
        const username = profile.username || "user";
        if (!analyticsToken) throw new Error("analytics_token is missing from this session.");
        if (!/^\d+$/.test(userId)) throw new Error("Discord user ID could not be resolved.");
        return { analyticsToken, userId, username };
    }

    // Seconds Discord asks to wait after a 429, from the body (retry_after) or the Retry-After header.
    function retryAfterOf(response) {
        const candidates = [
            response?.body?.retry_after, response?.body?.retryAfter, response?.retry_after,
            response?.retryAfter, response?.data?.retry_after, response?.data?.retryAfter
        ];
        for (const value of candidates) {
            const seconds = Number(value);
            if (value != null && Number.isFinite(seconds) && seconds > 0) return seconds;
        }
        let raw = null;
        try {
            const headers = response?.headers;
            raw = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
        } catch (_) {}
        const seconds = parseFloat(raw);
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    }

    // Posts one request to /science. Retries rate limits (up to 3 times, waiting as long as Discord asks),
    // requests that got no answer (twice) and one 401/403 with a fresh analytics token for the same account.
    // Every retry resends the same events with the same session IDs.
    async function sendBatch(events, context, isStopped = () => false) {
        if (CONFIG.dryRun) return true;
        let limited = 0;
        let lost = 0;
        let refreshed = false;
        for (;;) {
            let status;
            let retryAfter = null;
            try {
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
            } else if ((status === 401 || status === 403) && !refreshed) {
                refreshed = true;
                console.warn(`${LABEL} /science returned ${status}. Getting a fresh analytics token and retrying...`);
                try {
                    const fresh = await getAuthContext(context.client);
                    if (fresh.userId !== context.userId) {
                        console.warn(`${LABEL} The logged-in account changed, so this batch isn't resent.`);
                        return false;
                    }
                    context.analyticsToken = fresh.analyticsToken;
                } catch (error) {
                    console.warn(`${LABEL} Couldn't get a fresh analytics token: ${error.message}`);
                    return false;
                }
            } else {
                if (status) console.warn(`${LABEL} /science returned ${status}.`);
                return false;
            }
            if (isStopped()) return false;
        }
    }

    // Discord hides window.localStorage from the console, so it's reached through a hidden same-origin
    // iframe. What's saved there survives a reload.
    let storageFrame = null;

    function getStorage() {
        try {
            if (window.localStorage) return window.localStorage;
        } catch (_) {}
        try {
            if (!storageFrame) {
                storageFrame = document.createElement("iframe");
                storageFrame.style.display = "none";
                document.body.appendChild(storageFrame);
            }
            return storageFrame.contentWindow?.localStorage ?? null;
        } catch (_) {
            return null;
        }
    }

    // Removes the iframe once pending (a run that may still be saving its result) settles.
    function releaseStorage(pending) {
        Promise.resolve(pending).catch(() => {}).finally(() => {
            try { storageFrame?.remove(); } catch (_) {}
            storageFrame = null;
        });
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
    // ===== End of Discord client =====
