// js/timesheet.js
// Asking for a start time without the browser's prompt(): a small sheet inside
// the app, built the same way as the rest of MindLoop, that rises from the
// bottom on a phone and centres on a wide screen.
//
// askStartTime() resolves with "HH:MM" (a chosen time), "" (the time was
// cleared) or null (the sheet was closed without saving). Only one sheet can
// be open at a time.

let current = null; // close function of the open sheet, if any

export function askStartTime({
  title = "Change start time",
  text = "",
  time = "",
} = {}) {
  return new Promise((resolve) => {
    if (current) current(null);

    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";

    const sheet = document.createElement("div");
    sheet.className = "card sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "sheet-title");

    const heading = document.createElement("h2");
    heading.id = "sheet-title";
    heading.textContent = title;

    const parts = [heading];
    if (text) {
      const task = document.createElement("p");
      task.className = "sheet-task";
      task.textContent = text;
      parts.push(task);
    }

    const label = document.createElement("label");
    label.className = "sheet-label";
    label.htmlFor = "sheet-time";
    label.textContent = "Start time";

    const input = document.createElement("input");
    input.id = "sheet-time";
    input.type = "time";
    input.value = time || "";

    const hint = document.createElement("p");
    hint.className = "hint sheet-hint";
    hint.textContent = "Leave it empty to remove the time.";

    const error = document.createElement("p");
    error.className = "status is-error sheet-error";
    error.setAttribute("role", "alert");

    const actions = document.createElement("div");
    actions.className = "sheet-actions";

    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "Save";

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "plan-btn";
    clear.textContent = "Clear time";
    clear.hidden = !time;

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "plan-btn";
    cancel.textContent = "Cancel";

    function finish(value) {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      current = null;
      resolve(value);
    }

    function onKey(event) {
      if (event.key === "Escape") finish(null);
    }

    save.addEventListener("click", () => {
      const value = input.value.trim();
      if (value && !/^\d{2}:\d{2}$/.test(value)) {
        error.textContent = "Pick a time, or clear it.";
        return;
      }
      finish(value);
    });
    clear.addEventListener("click", () => finish(""));
    cancel.addEventListener("click", () => finish(null));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null); // tap outside to close
    });

    actions.append(save, clear, cancel);
    sheet.append(...parts, label, input, hint, error, actions);
    overlay.append(sheet);
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    current = finish;
    input.focus({ preventScroll: true });
  });
}
