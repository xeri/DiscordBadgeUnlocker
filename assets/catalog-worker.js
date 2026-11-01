// Module worker: fetches and normalizes Discord's 13 MB detectable-games catalog off the main thread.
// loadCatalog only throws once every source has failed, so app.js doesn't retry such an error itself.
import { loadCatalog } from "../skills/discord-badge-unlocker/scripts/core.mjs";

self.onmessage = async event => {
    try {
        const result = await loadCatalog({ snapshotUrl: event.data?.snapshotUrl ?? null });
        self.postMessage({ ok: true, result });
    } catch (error) {
        self.postMessage({ ok: false, error: error?.message ?? String(error) });
    }
};
