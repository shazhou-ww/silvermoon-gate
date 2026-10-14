const scenario = location.pathname.split("/").pop();
function reportHeight() {
  window.parent.postMessage(
    {
      type: "gate:height",
      height: Math.ceil(document.body.getBoundingClientRect().height),
      scenario,
    },
    "*",
  );
}
new ResizeObserver(reportHeight).observe(document.body);
window.addEventListener("load", reportHeight);
window.addEventListener("resize", reportHeight);
window.addEventListener("message", (event) => {
  if (event.source === window.parent && event.data?.type === "gate:measure")
    reportHeight();
});
document.querySelectorAll("[data-reveal]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.getElementById(button.dataset.reveal);
    target.hidden = false;
    button.setAttribute("aria-expanded", "true");
    target.querySelector("[tabindex], input, button")?.focus();
    reportHeight();
  });
});
document.querySelectorAll("[data-cancel]").forEach((button) => {
  button.addEventListener("click", () => {
    const id = button.dataset.cancel;
    document.getElementById(id).hidden = true;
    const trigger = document.querySelector(`[data-reveal="${id}"]`);
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
    reportHeight();
  });
});
