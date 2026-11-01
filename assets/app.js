// Boot: load Discord's catalog in the background, preload the generator when idle, mount it on click.

import { initTips } from "./tips.js";

initTips();

const CORE = "../skills/discord-badge-unlocker/scripts/core.mjs";
const SNAPSHOT_URL = new URL("../data/catalog.min.json", import.meta.url).href;

const status = document.getElementById("catalog-status");
const start = document.getElementById("start");
const button = document.getElementById("load-generator");
const mountPoint = document.getElementById("generator");

const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function setStatus(state, text, tip = "") {
    status.dataset.state = state;
    status.dataset.tip = tip;
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
    // A worker that ran and found every source down won't do better on the main thread.
    if (/Could not load the Discord catalog/.test(workerError?.message ?? "")) throw workerError;
    return loadOnMainThread();
});

catalogPromise.then(
    catalog => {
        const when = catalog.fetchedAt ? catalog.fetchedAt.slice(0, 10) : "unknown date";
        if (catalog.live) setStatus("live", `${fmt(catalog.games.length)} games`, `Every game Discord can detect, live from ${catalog.sourceLabel}`);
        else setStatus("snapshot", `${fmt(catalog.games.length)} games · offline`, `Discord didn't answer, so this is the offline snapshot from ${when}`);
    },
    error => {
        setStatus("error", "Catalog unavailable", error.message);
        console.error(error);
    }
);

let generatorModule = null;
const preloadGenerator = () => (generatorModule ??= import("./generator.js"));

const idle = window.requestIdleCallback ?? (cb => setTimeout(cb, 400));
idle(() => { preloadGenerator().catch(() => { generatorModule = null; }); }, { timeout: 2500 });

button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Loading…";
    try {
        const { mount } = await preloadGenerator();
        start.hidden = true;
        mountPoint.hidden = false;
        mount(mountPoint, { catalogPromise });
    } catch (error) {
        generatorModule = null;
        button.disabled = false;
        button.textContent = "Load generator";
        console.error(error);
    }
});
