// Boot: load Discord's catalog in the background, preload the generator when idle, mount it on click.

const CORE = "../skills/discord-badge-unlocker/scripts/core.mjs";
const SNAPSHOT_URL = new URL("../data/catalog.min.json", import.meta.url).href;

const status = document.getElementById("catalog-status");
const button = document.getElementById("load-generator");
const hint = document.getElementById("preload-hint");
const mountPoint = document.getElementById("generator");

const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function setStatus(state, text) {
    status.dataset.state = state;
    status.querySelector(".text").textContent = text;
}

function loadInWorker() {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(new URL("./catalog-worker.js", import.meta.url), { type: "module" });
        } catch (error) {
            reject(error);
            return;
        }
        worker.onmessage = event => {
            worker.terminate();
            if (event.data?.ok) resolve(event.data.result);
            else reject(new Error(event.data?.error ?? "Catalog worker failed."));
        };
        worker.onerror = event => {
            event.preventDefault?.();
            worker.terminate();
            reject(new Error(event.message || "Catalog worker failed to start."));
        };
        worker.postMessage({ snapshotUrl: SNAPSHOT_URL });
    });
}

async function loadOnMainThread() {
    const { loadCatalog } = await import(CORE);
    return loadCatalog({ snapshotUrl: SNAPSHOT_URL });
}

const catalogPromise = loadInWorker().catch(async workerError => {
    // A worker that ran and reported "all sources failed" won't do better on the main thread.
    if (/Could not load the Discord catalog/.test(workerError?.message ?? "")) throw workerError;
    return loadOnMainThread();
});

catalogPromise.then(
    catalog => {
        const when = catalog.fetchedAt ? catalog.fetchedAt.slice(0, 10) : "unknown date";
        setStatus(catalog.live ? "live" : "snapshot", catalog.live
            ? `${fmt(catalog.games.length)} games · live from ${catalog.sourceLabel}`
            : `${fmt(catalog.games.length)} games · offline snapshot from ${when}`);
    },
    error => {
        setStatus("error", "Catalog unavailable");
        console.error(error);
    }
);

let generatorModule = null;
const preloadGenerator = () => (generatorModule ??= import("./generator.js"));

const idle = window.requestIdleCallback ?? (cb => setTimeout(cb, 400));
idle(() => {
    preloadGenerator().then(
        () => { hint.textContent = "Ready."; },
        () => { hint.textContent = "Loads when you click."; generatorModule = null; }
    );
}, { timeout: 2500 });

button.addEventListener("click", async () => {
    if (!mountPoint.hidden) {
        mountPoint.scrollIntoView({ behavior: "smooth" });
        return;
    }
    button.disabled = true;
    button.textContent = "Loading…";
    try {
        const { mount } = await preloadGenerator();
        mountPoint.hidden = false;
        mount(mountPoint, { catalogPromise });
        button.textContent = "Open generator";
        mountPoint.scrollIntoView({ behavior: "smooth" });
    } catch (error) {
        generatorModule = null;
        button.textContent = "Load generator";
        hint.textContent = `Couldn't load the generator: ${error.message}`;
    } finally {
        button.disabled = false;
    }
});
