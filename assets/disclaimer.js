// Full-screen disclaimer, shown every time the page opens. The gate is static markup in index.html,
// so it's up before any script runs; the title bar and shell stay inert until the box is ticked.

const gate = document.getElementById("gate");

if (gate) {
    const form = gate.querySelector("form");
    const accept = form.elements.accept;
    const proceed = form.querySelector('button[type="submit"]');

    const sync = () => { proceed.disabled = !accept.checked; };
    accept.addEventListener("change", sync);
    sync(); // the browser may restore a ticked box on reload

    form.addEventListener("submit", event => {
        event.preventDefault();
        if (!accept.checked) return;
        gate.remove();
        for (const el of document.querySelectorAll(".titlebar, .shell")) el.inert = false;
        document.getElementById("load-generator")?.focus({ preventScroll: true });
    });
}
