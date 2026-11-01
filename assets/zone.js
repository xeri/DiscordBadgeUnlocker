// Safe zone (blue DBU) and Danger Zone (red DBU), switched from the sidebar (desktop widths; phones have no sidebar).
// Entering the Danger Zone always goes through its gate: tick the box, then hold the button. The zone isn't
// remembered, so every visit starts safe. The generator follows along through the zonechange event.

const HOLD_MS = 1000;
const THEME = { safe: "#2c2d32", danger: "#1f1c1d" };

const gate = document.getElementById("danger-gate");
const accept = gate.querySelector('input[name="accept"]');
const hold = gate.querySelector("[data-danger-hold]");
const icon = document.querySelector('link[rel="icon"]');
const theme = document.querySelector('meta[name="theme-color"]');
const title = document.title;

function setZone(zone) {
    const danger = zone === "danger";
    if (danger) document.body.dataset.zone = "danger";
    else delete document.body.dataset.zone;
    for (const button of document.querySelectorAll("[data-zone-switch]")) {
        button.setAttribute("aria-pressed", String(button.dataset.zoneSwitch === zone));
    }
    icon.href = danger ? "assets/logo-danger.svg" : "assets/logo.svg";
    theme.content = danger ? THEME.danger : THEME.safe;
    document.title = danger ? `Danger Zone · ${title}` : title;
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

document.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest("[data-zone-switch]") : null;
    if (!button) return;
    const inDanger = document.body.dataset.zone === "danger";
    if (button.dataset.zoneSwitch === "danger") { if (!inDanger) openGate(); }
    else if (inDanger) setZone("safe");
});
