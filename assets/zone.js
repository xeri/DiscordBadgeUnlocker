// Safe zone (blue DBU), Streaming (green) and Danger Zone (red DBU), switched from the sidebar (desktop widths;
// phones have no sidebar, so a small icon in the title bar opens and closes Streaming). Entering the Danger Zone always goes
// through its gate: tick the box, then hold the button. Streaming has no gate. The zone isn't remembered, so every
// visit starts safe. The generator and the Streaming panel follow along through the zonechange event.

const HOLD_MS = 1000;
const THEME = { safe: "#2c2d32", danger: "#1f1c1d", stream: "#1c211e" };
const TITLES = { danger: "Danger Zone", stream: "Streaming" };

const gate = document.getElementById("danger-gate");
const accept = gate.querySelector('input[name="accept"]');
const hold = gate.querySelector("[data-danger-hold]");
const icon = document.querySelector('link[rel="icon"]');
const theme = document.querySelector('meta[name="theme-color"]');
const title = document.title;

function setZone(zone) {
    if (zone === "danger" || zone === "stream") document.body.dataset.zone = zone;
    else delete document.body.dataset.zone;
    for (const button of document.querySelectorAll("[data-zone-switch], [data-zone-toggle]")) {
        button.setAttribute("aria-pressed", String((button.dataset.zoneSwitch ?? button.dataset.zoneToggle) === zone));
    }
    icon.href = zone === "danger" ? "assets/logo-danger.svg" : "assets/logo.svg";
    theme.content = THEME[zone] ?? THEME.safe;
    document.title = TITLES[zone] ? `${TITLES[zone]} · ${title}` : title;
    document.dispatchEvent(new CustomEvent("zonechange", { detail: { zone } }));
}

// ---------- gate: tick the box, then hold to enter ----------

let holdTimer = null;
function startHold() {
    if (hold.disabled || holdTimer) return;
    hold.classList.add("holding");
    holdTimer = setTimeout(() => {
        stopHold();
        gate.close();
        setZone("danger");
    }, HOLD_MS);
}
function stopHold() {
    clearTimeout(holdTimer);
    holdTimer = null;
    hold.classList.remove("holding");
}

function openGate() {
    accept.checked = false;
    hold.disabled = true;
    stopHold();
    gate.showModal();
}

accept.addEventListener("change", () => { hold.disabled = !accept.checked; });
hold.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    hold.setPointerCapture(event.pointerId);
    startHold();
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) hold.addEventListener(type, stopHold);
hold.addEventListener("keydown", event => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) startHold();
});
hold.addEventListener("keyup", event => { if (event.key === " " || event.key === "Enter") stopHold(); });
hold.addEventListener("contextmenu", event => event.preventDefault()); // long-press on touch
gate.querySelector("[data-danger-cancel]").addEventListener("click", () => gate.close());
gate.addEventListener("close", stopHold);

// ---------- switches ----------

// [data-zone-switch]: the sidebar buttons. [data-zone-toggle]: the phone-only title bar icon, which opens its zone
// and, pressed again, goes back to the safe zone.
document.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest("[data-zone-switch], [data-zone-toggle]") : null;
    if (!button) return;
    const current = document.body.dataset.zone ?? "safe";
    const toggle = button.dataset.zoneToggle;
    const target = toggle ? (current === toggle ? "safe" : toggle) : button.dataset.zoneSwitch;
    if (target === current) return;
    if (target === "danger") openGate();
    else setZone(target === "stream" ? "stream" : "safe");
});
