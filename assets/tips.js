// Hover hints, Discord style: one shared tooltip for every [data-tip] element.
//   data-tip="text"          the hint (update it any time; a visible tip follows along)
//   data-tip-side="right"    open to the right instead of above (flips when there's no room)
//   data-tip-overflow        hint = the element's own text, only while it's cut off by an ellipsis
// Mouse/pen hover shows it after a short delay (instantly while another tip was just open);
// keyboard focus shows it too. Touch taps never do.

const SHOW_DELAY = 400;
const WARM_MS = 600;
const GAP = 8;
const EDGE = 8;

export function initTips(doc = document) {
    const tip = doc.createElement("div");
    tip.className = "tip";
    tip.id = "tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    tip.innerHTML = `<span class="tip-text"></span><span class="tip-arrow" aria-hidden="true"></span>`;
    doc.body.append(tip);
    const text = tip.firstElementChild;
    const arrow = tip.lastElementChild;

    let target = null;
    let pending = null;
    let showTimer = null;
    let warmUntil = 0;
    let keyboard = false;
    let ownedDescribedBy = false;
    let pointer = null;   // last mouse position, so a delayed hint only opens if the mouse is still on it
    let dismissed = null; // closed by Escape or typing: stays closed until the mouse or focus leaves it

    const tipFor = el => {
        if (el.hasAttribute("data-tip-overflow")) return el.scrollWidth > el.clientWidth + 1 ? el.textContent.trim() : "";
        return el.dataset.tip ?? "";
    };

    function place() {
        const r = target.getBoundingClientRect();
        const vw = doc.documentElement.clientWidth;
        const vh = doc.documentElement.clientHeight;
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        let side = target.dataset.tipSide === "right" ? "right" : "top";
        if (side === "right" && r.right + GAP + w > vw - EDGE) side = "top";
        if (side === "top" && r.top - GAP - h < EDGE) side = "bottom";
        let x, y;
        if (side === "right") {
            x = r.right + GAP;
            y = Math.min(Math.max(EDGE, r.top + r.height / 2 - h / 2), vh - EDGE - h);
            arrow.style.left = "";
            arrow.style.top = `${Math.min(Math.max(10, r.top + r.height / 2 - y), h - 10)}px`;
        } else {
            x = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), vw - EDGE - w);
            y = side === "top" ? r.top - GAP - h : r.bottom + GAP;
            arrow.style.top = "";
            arrow.style.left = `${Math.min(Math.max(10, r.left + r.width / 2 - x), w - 10)}px`;
        }
        tip.dataset.side = side;
        tip.style.left = `${Math.round(x)}px`;
        tip.style.top = `${Math.round(y)}px`;
    }

    function show(el) {
        const value = tipFor(el);
        if (!value) return;
        target = el;
        text.textContent = value;
        tip.hidden = false;
        tip.classList.remove("in");
        place();
        void tip.offsetWidth; // restart the entrance animation
        tip.classList.add("in");
        ownedDescribedBy = !el.hasAttribute("aria-describedby");
        if (ownedDescribedBy) el.setAttribute("aria-describedby", tip.id);
        watch.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-tip", "disabled", "hidden"] });
    }

    function close({ warm = true } = {}) {
        if (!target) return;
        if (ownedDescribedBy) target.removeAttribute("aria-describedby");
        target = null;
        tip.hidden = true;
        tip.classList.remove("in");
        warmUntil = warm ? Date.now() + WARM_MS : 0;
        watch.disconnect();
    }

    function hide() {
        clearTimeout(showTimer);
        showTimer = null;
        pending = null;
        close();
    }

    function dismiss() {
        dismissed = target ?? pending ?? dismissed;
        hide();
    }

    const underPointer = el => {
        if (!pointer) return true;
        const hit = doc.elementFromPoint(pointer.x, pointer.y);
        return !!hit && el.contains(hit);
    };

    function schedule(el, byPointer) {
        if (el === target || el === pending || el === dismissed) return;
        if (target) close();
        clearTimeout(showTimer);
        pending = el;
        const delay = Date.now() < warmUntil ? 0 : SHOW_DELAY;
        showTimer = setTimeout(() => {
            showTimer = null;
            pending = null;
            if (el.isConnected && (!byPointer || underPointer(el))) show(el);
        }, delay);
    }

    // Re-renders replace elements and change hints while a tip is open: follow or close.
    const watch = new MutationObserver(() => {
        if (!target) return;
        if (!target.isConnected || target.closest("[hidden]")) { hide(); return; }
        const value = tipFor(target);
        if (!value) { hide(); return; }
        if (value !== text.textContent) text.textContent = value;
        place();
    });

    const tipTarget = node => (node instanceof Element ? node.closest("[data-tip], [data-tip-overflow]") : null);

    const onPointer = event => {
        if (event.pointerType === "touch") return;
        pointer = { x: event.clientX, y: event.clientY };
        const el = tipTarget(event.target);
        if (el) schedule(el, true);
    };
    doc.addEventListener("pointerover", onPointer);
    doc.addEventListener("pointermove", onPointer, { passive: true });
    doc.addEventListener("pointerout", event => {
        if (event.pointerType === "touch") return;
        const el = tipTarget(event.target);
        if (!el || el.contains(event.relatedTarget)) return;
        if (el === dismissed) dismissed = null;
        if (el === target || !target) hide();
    });

    // Keyboard: Tab onto a control shows its hint; clicks and taps don't.
    doc.addEventListener("keydown", event => {
        if (event.key === "Tab") keyboard = true;
        else if (event.key === "Escape") dismiss();
        else if (target && event.target.matches?.("input, textarea") && target.contains(event.target)) dismiss(); // typing
    }, true);
    doc.addEventListener("pointerdown", event => {
        keyboard = false;
        if (event.pointerType === "touch") hide();
    }, true);
    doc.addEventListener("focusin", event => {
        if (!keyboard) return;
        const el = tipTarget(event.target);
        if (el) schedule(el, false);
    });
    doc.addEventListener("focusout", event => {
        const el = tipTarget(event.target);
        if (!el || el.contains(event.relatedTarget)) return;
        if (el === dismissed) dismissed = null;
        if (el === target) hide();
    });

    // Scrolling (the page or any list) closes an open hint without warming up the next one.
    window.addEventListener("scroll", () => close({ warm: false }), { capture: true, passive: true });
    window.addEventListener("resize", hide, { passive: true });
    window.addEventListener("blur", event => { if (event.target === window) hide(); });

    return { hide };
}
