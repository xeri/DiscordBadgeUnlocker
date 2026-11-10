// Streaming zone: builds stream-time.js, the console script for Discord's Streaming badge. Needs no catalog.
// The script itself is rendered by templates.mjs (renderStream), the same code the CLI's `stream` command uses.

import { STREAM_MAX_HOURS, STREAM_TIERS, formatCount, streamEta } from "../skills/discord-badge-unlocker/scripts/core.mjs";
import { STREAM_DEFAULTS, STREAM_SCRIPT, loadTemplates, normalizeStream, renderStream } from "../skills/discord-badge-unlocker/scripts/templates.mjs";

const STORE_KEY = "dbu-stream-options-v2"; // the choices this browser changed, nothing more (v1 saved the old Drop default)
const TIER_COLOR = {
    newcomer: "#b9bbbe", fledgling: "#57f287", breakout: "#3ba55d", standout: "#00e5ff", trendsetter: "#00a8fc",
    headliner: "#5865f2", superstar: "#9b59b6", sensation: "#eb459e", visionary: "#ed4245", phenomenon: "#fee75c"
};
const tierIcon = tier => new URL(`./badges/stream-${tier.key}.png`, import.meta.url).href;
const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hrs = h => (Number.isInteger(h) ? formatCount(h) : formatCount(Math.round(h * 10) / 10));

function duration(minutes) {
    if (minutes < 1) return "under a minute";
    if (minutes < 120) return `${minutes} min`;
    const hours = minutes / 60;
    return hours < 48 ? `${hrs(Math.round(hours * 10) / 10)} hours` : `${hrs(Math.round(hours / 2.4) / 10)} days`;
}

function loadOptions() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
        if (saved && typeof saved === "object") return { ...STREAM_DEFAULTS, ...saved };
    } catch (_) {}
    return { ...STREAM_DEFAULTS };
}

function saveOptions(options) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(options)); } catch (_) {}
}

function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (_) {
        const area = Object.assign(document.createElement("textarea"), { value: text });
        document.body.append(area);
        area.select();
        const ok = document.execCommand?.("copy") ?? false;
        area.remove();
        return ok;
    }
}

const switchRow = (ref, label, tip) =>
    `<label class="opt" data-tip="${esc(tip)}">${label}<span class="switch"><input type="checkbox" data-ref="${ref}"><span></span></span></label>`;

const markup = () => `
<section class="stream-hero">
  <img src="${tierIcon(STREAM_TIERS.at(-1))}" alt="" width="56" height="56" draggable="false">
  <div><h2>Streaming badge</h2>
    <p>Stream time for Discord's Streaming badge, sent while you're live in a voice channel with someone watching.</p></div>
</section>

<section class="card">
  <div class="badge-pick">
    <div class="badge-head">
      <span class="cat">Hours of stream time</span>
      <span class="badge-now"><b class="tier-name" data-ref="tierName"></b>
        <label class="mini-field" data-tip="Or type exact hours, up to ${formatCount(STREAM_MAX_HOURS)}"><input type="number" min="0.1" max="${STREAM_MAX_HOURS}" step="1" inputmode="decimal" data-ref="hours" aria-label="Hours of stream time"> h</label></span>
    </div>
    <div class="tier-row" role="group" aria-label="Streaming tier">
      ${STREAM_TIERS.map((tier, i) => `<button type="button" class="tier-btn" data-stream-tier="${i}" aria-pressed="false" aria-label="${tier.name}, ${formatCount(tier.min)}h" data-tip="${tier.name}: ${formatCount(tier.min)}h" style="--tier:${TIER_COLOR[tier.key]}"><img src="${tierIcon(tier)}" alt="" width="32" height="32" draggable="false"></button>`).join("")}
    </div>
  </div>
  <p class="stream-note">Try a small target first, like 100h, and check your badge 24–48h later.</p>
</section>

<section class="card">
  <h3 class="cat">Turbo</h3>
  <div class="seg big" role="group" aria-label="Turbo" data-ref="turbo">
    <button type="button" data-turbo="auto" data-tip="While someone watches, every minute claims the Turbo hours (10h by default)">Auto</button>
    <button type="button" data-turbo="off" data-tip="Every minute you're live claims one minute, like a real stream">Off</button>
  </div>
  <p class="stream-eta" data-ref="eta"></p>
  <p class="stream-note warn" data-ref="turboNote">Turbo is untested. BadgeFarmer's author calls it “the only untested attack left”: start small and check the badge before going big.</p>
  <div class="divider"></div>
  <h3 class="cat">When nobody is watching</h3>
  <div class="seg big" role="group" aria-label="When nobody is watching" data-ref="noViewer">
    <button type="button" data-no-viewer="drop" data-tip="Drop to per-minute: keep sending one minute a minute while you're live without a viewer">Drop</button>
    <button type="button" data-no-viewer="pause" data-tip="Send nothing until a viewer is back, then carry on by itself">Pause</button>
  </div>
  <div class="stream-warning" data-ref="dropWarning" role="alert">
    <strong>⚠ Drop sends time nobody watched</strong>
    <p>BadgeFarmer and lawerth/discord-streamer both found that Discord only counts stream time <b>with a viewer</b>. In Drop mode the script keeps sending one minute a minute when nobody watches, so that time probably counts for <b>nothing</b>. Keep someone (an alt works) watching the whole time, or pick Pause.</p>
  </div>
  <p class="stream-note" data-ref="pauseNote">Pause: nothing is sent while nobody watches. It carries on by itself when a viewer is back.</p>
</section>

<details class="advanced">
  <summary data-tip="Turbo speed, session length, dry run and a preview of the script">Advanced</summary>
  <div class="adv">
    <div class="opts">
      <label class="opt" data-tip="Hours each Turbo minute claims, 1 to 23 (each heartbeat stays under a day)">Turbo hours a minute<input type="number" min="1" max="23" step="1" inputmode="numeric" data-ref="rate"></label>
      ${switchRow("split", "Split into sessions of 23h", "Discord drops a game session over 24h whole. On: every 23h of credit closes the stream session and opens a new one.")}
      ${switchRow("dryRun", "Dry run", "Builds every event and logs it, but sends nothing")}
    </div>
    <details class="peek"><summary data-tip="Read the script before you run it">Preview</summary><textarea class="preview" readonly spellcheck="false" data-ref="preview" aria-label="Stream script"></textarea></details>
  </div>
</details>

<section class="card stream-steps">
  <h3 class="cat">How to run it</h3>
  <ol>
    <li>In the <b>Discord desktop app</b>, join a <b>server voice channel</b> and <b>Go Live</b>. Any window or screen works; it doesn't have to be a game.</li>
    <li>Have <b>someone watch</b> your stream. An alt account on another device counts.</li>
    <li>Turn on <b>Settings › Data &amp; Privacy › Use data to personalize my Discord experience</b>. The script checks it.</li>
    <li>Copy the script, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> › <b>Console</b>, type <code>allow pasting</code> if asked, then paste and press Enter.</li>
    <li>Keep Discord open and stay live until the console says <b>Done</b>. Badges update within 24–48h.</li>
  </ol>
  <p class="stream-note">It sends through Discord's own HTTP client and never reads your token. Vencord's NoTrack can stay on. Progress is saved per account, so pasting it again carries on toward the target.</p>
</section>

<ul class="notes" data-ref="notes"></ul>

<div class="dock">
  <div class="sum"><span data-tip="Stream time the script sends"><b data-ref="sumHours">0</b>h stream time</span><span>·</span><span data-ref="sumEta"></span>
    <span class="tier" data-ref="pill" hidden><img alt="" width="16" height="16" draggable="false">Streaming</span></div>
  <div class="actions">
    <button class="btn" type="button" data-stream="download">Download</button>
    <button class="btn primary" type="button" data-stream="copy">Copy script</button>
  </div>
  <div class="toast" data-ref="toast" hidden></div>
</div>`;

export async function mount(root) {
    root.innerHTML = `<div class="wait"><span class="spinner"></span>Loading…</div>`;
    let templates;
    try {
        templates = await loadTemplates();
    } catch (error) {
        root.innerHTML = `<div class="wait">${esc(error.message)}</div>`;
        return;
    }
    root.innerHTML = `<div class="gen stream-gen">${markup()}</div>`;
    const ref = Object.fromEntries([...root.querySelectorAll("[data-ref]")].map(el => [el.dataset.ref, el]));
    const options = loadOptions();
    let latest = null;
    let toastTimer = null;

    ref.hours.value = options.hours;
    ref.rate.value = options.turboHoursPerMinute;
    ref.split.checked = options.split !== false;
    ref.dryRun.checked = options.dryRun === true;

    function toast(text, ms = 3200) {
        ref.toast.textContent = text;
        ref.toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { ref.toast.hidden = true; }, ms);
    }

    function render() {
        for (const b of root.querySelectorAll("[data-turbo]")) b.setAttribute("aria-pressed", String(b.dataset.turbo === options.turbo));
        for (const b of root.querySelectorAll("[data-no-viewer]")) b.setAttribute("aria-pressed", String(b.dataset.noViewer === options.noViewer));
        const drop = options.noViewer === "drop";
        ref.dropWarning.hidden = !drop;
        ref.pauseNote.hidden = drop;
        ref.turboNote.hidden = options.turbo === "off";

        const notes = [];
        latest = null;
        let o = null;
        try {
            o = normalizeStream(options);
            latest = renderStream(o, templates);
        } catch (error) {
            notes.push({ level: "error", text: error.message });
        }

        const hours = o?.hours ?? 0;
        const at = STREAM_TIERS.findLastIndex(tier => hours >= tier.min);
        root.querySelectorAll("[data-stream-tier]").forEach((b, i) => {
            b.setAttribute("aria-pressed", String(i === at));
            b.classList.toggle("above", i > at);
        });
        ref.tierName.textContent = at >= 0 ? STREAM_TIERS[at].name : "Below Newcomer";
        ref.tierName.style.color = at >= 0 ? TIER_COLOR[STREAM_TIERS[at].key] : "";
        ref.pill.hidden = at < 0;
        if (at >= 0) {
            const img = ref.pill.querySelector("img");
            img.src = tierIcon(STREAM_TIERS[at]);
            ref.pill.style.setProperty("--tier", TIER_COLOR[STREAM_TIERS[at].key]);
            ref.pill.lastChild.textContent = STREAM_TIERS[at].name;
        }

        if (o) {
            const { liveMinutes } = streamEta({ hours: o.hours, turbo: o.turbo, turboHoursPerMinute: o.turboHoursPerMinute });
            ref.eta.innerHTML = o.turbo === "auto"
                ? `<b>About ${esc(duration(liveMinutes))}</b> live with a viewer: ${o.turboHoursPerMinute}h a minute.`
                : `<b>About ${esc(duration(liveMinutes))}</b> live with a viewer: one minute a minute, like a real stream.`;
            ref.sumHours.textContent = hrs(o.hours);
            ref.sumEta.textContent = `about ${duration(liveMinutes)} live`;
            if (o.hours >= 100 && o.turbo === "auto") notes.push({ level: "info", text: "First time? Run a small target (like 100h), check the badge after 24–48h, then go bigger. Progress carries over." });
            if (o.dryRun) notes.push({ level: "warn", text: "Dry run is on: the script logs every event but sends nothing." });
            if (!o.split) notes.push({ level: "warn", text: "One stream session will carry every hour. Discord drops game sessions over 24h whole, and may do the same here." });
        } else {
            ref.eta.textContent = "";
            ref.sumHours.textContent = "0";
            ref.sumEta.textContent = "";
        }
        ref.notes.innerHTML = notes.map(n => `<li class="${n.level}">${esc(n.text)}</li>`).join("");
        ref.preview.value = latest?.text ?? "";
        for (const b of root.querySelectorAll("[data-stream]")) b.disabled = !latest;
    }

    root.addEventListener("click", async event => {
        const target = event.target instanceof Element ? event.target.closest("button") : null;
        if (!target || !root.contains(target)) return;
        const d = target.dataset;
        if (d.streamTier != null) {
            options.hours = STREAM_TIERS[Number(d.streamTier)].min;
            ref.hours.value = options.hours;
        } else if (d.turbo) {
            options.turbo = d.turbo;
        } else if (d.noViewer) {
            options.noViewer = d.noViewer;
        } else if (d.stream && latest) {
            if (d.stream === "copy") {
                if (await copyText(latest.text)) toast("Copied. Go Live with a viewer, then paste it into Discord desktop's console (Ctrl+Shift+I).", 9000);
            } else {
                download(latest.file, latest.text);
                toast(`Saved ${STREAM_SCRIPT.file}. Go Live with a viewer, then paste its contents into Discord desktop's console.`, 9000);
            }
            return;
        } else {
            return;
        }
        saveOptions(options);
        render();
    });

    root.addEventListener("input", event => {
        const el = event.target;
        if (el === ref.hours) options.hours = el.value === "" ? NaN : Number(el.value);
        else if (el === ref.rate) options.turboHoursPerMinute = Number(el.value) || STREAM_DEFAULTS.turboHoursPerMinute;
        else if (el === ref.split) options.split = el.checked;
        else if (el === ref.dryRun) options.dryRun = el.checked;
        else return;
        saveOptions(options);
        render();
    });

    render();
}
