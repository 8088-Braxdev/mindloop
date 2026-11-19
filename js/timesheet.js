// js/timesheet.js
// The app's own sheets, used instead of the browser's prompt() and confirm():
// asking for a start time, a short completion note, or a reason for moving a
// priority. They rise from the bottom on a phone and centre on a wide screen.
//
// All three resolve to the person's answer, or null when the sheet is closed
// without one. Only one sheet can be open at a time.

let current = null; // close function of the open sheet, if any

// The on-screen keyboard shrinks the visual viewport, not the layout viewport.
// Fitting the overlay to the visual viewport keeps the centred sheet above the
// keyboard instead of behind it, which is what used to force a scroll.
function fitToVisualViewport(overlay) {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const sheet = overlay.querySelector(".sheet");
  const apply = () => {
    overlay.style.top = `${viewport.offsetTop}px`;
    overlay.style.height = `${viewport.height}px`;
    overlay.style.bottom = "auto";
    if (sheet) {
      sheet.style.maxHeight = `${Math.max(220, viewport.height - 32)}px`;
    }
  };
  apply();
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  return () => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
  };
}

function openSheet({ title, text, body, buttons, onOpen }) {
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
    parts.push(body);

    const actions = document.createElement("div");
    actions.className = "sheet-actions";

    function finish(value) {
      document.removeEventListener("keydown", onKey);
      unfixViewport();
      overlay.remove();
      current = null;
      resolve(value);
    }

    function onKey(event) {
      if (event.key === "Escape") finish(null);
    }

    for (const button of buttons) {
      const node = document.createElement("button");
      node.type = "button";
      node.className = button.className || "plan-btn";
      node.textContent = button.label;
      node.addEventListener("click", () => button.onClick(finish, node));
      actions.append(node);
    }

    parts.push(actions);
    sheet.append(...parts);
    overlay.append(sheet);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null); // tap outside to close
    });

    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    const unfixViewport = fitToVisualViewport(overlay);
    current = finish;
    if (onOpen) onOpen();
  });
}

function note(text, className) {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

/* ---------- Start time ---------- */

export function askStartTime({
  title = "Change start time",
  text = "",
  time = "",
} = {}) {
  const label = document.createElement("label");
  label.className = "sheet-label";
  label.textContent = "Start time";
  label.setAttribute("for", "sheet-time");

  const input = document.createElement("input");
  input.id = "sheet-time";
  input.type = "time";
  input.value = time || "";

  const body = document.createElement("div");
  body.append(
    label,
    input,
    note("Leave it empty to remove the time.", "hint sheet-hint"),
  );
  const error = note("", "status is-error sheet-error");
  error.setAttribute("role", "alert");
  body.append(error);

  return openSheet({
    title,
    text,
    body,
    buttons: [
      {
        label: "Save",
        className: "primary",
        onClick: (finish) => {
          const value = input.value.trim();
          if (value && !/^\d{2}:\d{2}$/.test(value)) {
            error.textContent = "Pick a time, or clear it.";
            return;
          }
          finish(value);
        },
      },
      ...(time
        ? [
            {
              label: "Clear time",
              onClick: (finish) => finish(""),
            },
          ]
        : []),
      { label: "Cancel", onClick: (finish) => finish(null) },
    ],
    onOpen: () => input.focus({ preventScroll: true }),
  });
}

/* ---------- Completion note (spec §4) ---------- */

export function askNote({
  title = "Done. Anything to remember?",
  text = "",
  placeholder = "Optional: how it went",
  maxLength = 200,
} = {}) {
  const label = document.createElement("label");
  label.className = "sheet-label";
  label.setAttribute("for", "sheet-note");
  label.textContent = "Note";

  const input = document.createElement("textarea");
  input.id = "sheet-note";
  input.rows = 3;
  input.maxLength = maxLength;
  input.placeholder = placeholder;

  const body = document.createElement("div");
  body.append(
    label,
    input,
    note(
      "Only you can read this. It is never sent to the AI unless you ask for an insight.",
      "hint sheet-hint",
    ),
  );

  return openSheet({
    title,
    text,
    body,
    buttons: [
      {
        label: "Save note",
        className: "primary",
        onClick: (finish) => finish(input.value.trim()),
      },
      { label: "Skip", onClick: (finish) => finish("") },
    ],
    onOpen: () => input.focus({ preventScroll: true }),
  });
}

/* ---------- Reason for moving a priority (spec §4) ---------- */

export function askReason({ title = "Why move it?", text = "", options = [] }) {
  const list = document.createElement("div");
  list.className = "sheet-options";

  let chosen = null;

  const body = document.createElement("div");
  body.append(list);

  const buttons = options.map((option) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "plan-btn sheet-option";
    node.textContent = option.label;
    node.setAttribute("aria-pressed", "false");
    node.addEventListener("click", () => {
      chosen = option.id;
      list.querySelectorAll(".sheet-option").forEach((other) => {
        other.classList.toggle("is-chosen", other === node);
        other.setAttribute("aria-pressed", String(other === node));
      });
    });
    list.append(node);
    return node;
  });
  if (buttons[0]) buttons[0].classList.add("is-chosen");

  return openSheet({
    title,
    text,
    body,
    buttons: [
      {
        label: "Move it",
        className: "primary",
        onClick: (finish) => finish(chosen || ""),
      },
      { label: "Cancel", onClick: (finish) => finish(null) },
    ],
    onOpen: () => buttons[0]?.focus({ preventScroll: true }),
  });
}
