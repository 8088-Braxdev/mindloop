// js/rescue.js
// Rescue Mode — "I'm stuck" (spec §6).
//
// When a person is stuck on a priority, this asks what is in the way, then
// helps break the priority into ONE small action that takes about 2-5
// minutes. Afterwards it asks what happened.
//
// Rules from the spec, honoured exactly:
// - Opening Rescue Mode NEVER marks a task complete or done.
// - The person can edit or reject the suggested step.
// - Only outcomes the person confirms are recorded.
// - No shame: tired, distracted, no motivation are normal human states.
//
// Fully self-contained: it builds its own card in the Today view, finds plan
// items by their rendered order, and refreshes the UI through ui.js's
// existing visibilitychange handler. index.html and ui.js do not change.

import { markPriority, reschedulePriority, getEntriesLocal } from "./storage.js";
import { getCardPlan, toDateKey } from "./logic.js";

/* ---------- Blockers (spec §6 list) ---------- */

const BLOCKERS = [
  { id: "tired", label: "Tired" },
  { id: "distracted", label: "Distracted" },
  { id: "too-big", label: "Task feels too big" },
  { id: "how-to-start", label: "Not sure how to start" },
  { id: "no-motivation", label: "No motivation" },
  { id: "unexpected", label: "Something unexpected happened" },
  { id: "other", label: "Other / prefer not to say" },
];

/* ---------- Small-step templates ---------- */

// Each suggestion is ONE action that takes about 2-5 minutes, tied to the
// blocker the person picked. The person can always edit or reject it.
function smallStep(blocker, task) {
  switch (blocker) {
    case "too-big":
      return `Open it and write down just the first line of "${task}" — nothing else.`;
    case "how-to-start":
      return `Spend 3 minutes listing the tiny steps inside "${task}", then do only the first one.`;
    case "distracted":
      return `Put the phone face-down for 5 minutes and open only "${task}".`;
    case "tired":
      return `Do the smallest version of "${task}" for 3 minutes, sitting where you are.`;
    case "no-motivation":
      return `Tell yourself: only 3 minutes of "${task}", then you can stop. Start now.`;
    case "unexpected":
      return `Take a breath, then spend 3 minutes writing what changed about "${task}".`;
    default:
      return `Pick the tiniest piece of "${task}" and do it for 3 minutes.`;
  }
}

/* ---------- Card building ---------- */

let card = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function ensureCard() {
  const today = document.getElementById("view-today");
  if (!today) return null;
  if (!card || !card.isConnected) {
    card = today.querySelector("#rescue-card");
    if (!card) {
      card = el("div");
      card.id = "rescue-card";
      card.className = "card";
      card.hidden = true;
      today.prepend(card);
    }
  }
  return card;
}

function closeRescue() {
  if (card) card.hidden = true;
}

// ui.js refreshes everything on visibilitychange. A synthetic dispatch with
// document.hidden === false runs that same refresh — the cleanest way for a
// self-contained module to update the plan card without importing ui.js.
function refreshUI() {
  document.dispatchEvent(new Event("visibilitychange"));
}

/* ---------- Steps of the flow ---------- */

// Step 1: what is in the way?
function askBlocker(item, sourceDate) {
  const c = ensureCard();
  if (!c) return;
  c.replaceChildren(
    el("h2", "rescue-title", "What is in the way?"),
    el("p", "rescue-note", "No wrong answers. This helps you, not a judge."),
  );

  const list = el("div", "rescue-blockers");
  for (const b of BLOCKERS) {
    const btn = el("button", "plan-btn rescue-blocker", b.label);
    btn.type = "button";
    btn.addEventListener("click", () => askStep(item, sourceDate, b.id));
    list.append(btn);
  }
  c.append(list, cancelRow());
  c.hidden = false;
  c.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Step 2: one small action, editable.
function askStep(item, sourceDate, blocker) {
  const c = ensureCard();
  if (!c) return;
  const suggestion = smallStep(blocker, item.text);

  c.replaceChildren(
    el("h2", "rescue-title", "One small step"),
    el("p", "rescue-note", "About 2-5 minutes. Edit it if it does not fit you."),
  );

  const input = el("input");
  input.type = "text";
  input.maxLength = 200;
  input.value = suggestion;
  input.setAttribute("aria-label", "Your small step");

  const go = el("button", "plan-btn", "That's my step");
  go.type = "button";

  const reject = el("button", "plan-btn", "None of these — I'll do it my way");
  reject.type = "button";
  reject.addEventListener("click", () => {
    // Rejecting is allowed; the person just starts however they want.
    markPriority(sourceDate, item.index, "startedAt")
      .then(refreshUI)
      .catch((err) => console.error("MindLoop: rescue start failed", err));
    closeRescue();
  });

  go.addEventListener("click", () => {
    const step = (input.value || "").trim();
    if (!step) {
      input.focus();
      return;
    }
    askOutcome(item, sourceDate, step);
  });

  const actions = el("div", "rescue-actions");
  actions.append(go, reject);
  c.append(input, actions, cancelRow());
  c.hidden = false;
  input.focus();
}

// Step 3: what happened? Only a confirmed answer is recorded.
function askOutcome(item, sourceDate, step) {
  const c = ensureCard();
  if (!c) return;

  c.replaceChildren(
    el("h2", "rescue-title", "How did it go?"),
    el("p", "rescue-note", `Your step: "${step}"`),
  );

  const quiet = (promise) => {
    promise.then(refreshUI).catch((err) => {
      console.error("MindLoop: rescue outcome failed", err);
    });
    closeRescue();
  };

  const buttons = [
    ["I started", () => quiet(markPriority(sourceDate, item.index, "startedAt"))],
    [
      "The step helped — done",
      () =>
        quiet(
          markPriority(sourceDate, item.index, "startedAt").then(() =>
            markPriority(sourceDate, item.index, "doneAt"),
          ),
        ),
    ],
    ["Another step, please", () => askStep(item, sourceDate, "other")],
    // A break is not an outcome on the task: close quietly, record nothing.
    ["I need a break", () => closeRescue()],
    [
      "Reschedule it",
      () => {
        const time = prompt(
          `New start time for "${item.text}" (HH:MM). Leave empty for no time.`,
          item.time || "",
        );
        if (time === null) return;
        const clean = (time || "").trim();
        if (clean !== "" && !/^\d{1,2}:\d{2}$/.test(clean)) return;
        quiet(reschedulePriority(sourceDate, item.index, clean));
      },
    ],
    [
      "Postpone to another day",
      () => quiet(markPriority(sourceDate, item.index, "postponedAt")),
    ],
  ];

  const actions = el("div", "rescue-actions");
  for (const [label, onClick] of buttons) {
    const b = el("button", "plan-btn", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    actions.append(b);
  }
  c.append(actions, cancelRow());
  c.hidden = false;
}

function cancelRow() {
  const cancel = el("button", "plan-btn rescue-cancel", "Close");
  cancel.type = "button";
  cancel.addEventListener("click", closeRescue);
  return cancel;
}

/* ---------- Public API ---------- */

// Opens Rescue Mode for one of today's priorities.
// Never marks anything complete — only the confirmed outcome does.
export function openRescue(item, sourceDate) {
  askBlocker(item, sourceDate);
}

/* ---------- "I'm stuck" buttons on today's plan items ---------- */

// ui.js renders plan items in the same order as the items array, so the nth
// .plan-item belongs to items[n]. Re-decorates whenever the list re-renders.
function decoratePlan() {
  const list = document.getElementById("priority-list");
  if (!list || list.hidden) return;

  const entries = getEntriesLocal();
  const { sourceDate, planDate, items } = getCardPlan(
    entries,
    toDateKey(new Date()),
    false,
  );
  if (planDate > toDateKey(new Date())) return;

  const rendered = list.querySelectorAll(":scope > .plan-item");
  rendered.forEach((li, n) => {
    const item = items[n];
    if (!item) return;
    if (item.doneAt || item.skippedAt || item.postponedAt) return;

    const actions = li.querySelector(".plan-actions");
    if (!actions || actions.querySelector(".rescue-open")) return;

    const btn = el("button", "plan-btn rescue-open", "I'm stuck");
    btn.type = "button";
    btn.addEventListener("click", () => openRescue(item, sourceDate));
    actions.append(btn);
  });
}

/* ---------- Styles + wiring ---------- */

function initStyle() {
  if (document.getElementById("rescue-style")) return;
  const style = document.createElement("style");
  style.id = "rescue-style";
  style.textContent = `
    #rescue-card { border-color: var(--accent); }
    #rescue-card[hidden] { display: none; }
    .rescue-blockers { display: grid; gap: 8px; margin: 10px 0; }
    .rescue-blockers .plan-btn { justify-content: flex-start; }
    #rescue-card input[type="text"] { margin: 10px 0; }
    .rescue-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 0; }
    .rescue-actions .plan-btn { flex: 1 1 auto; justify-content: center; }
    .rescue-cancel { margin-top: 8px; color: var(--muted); }
    .rescue-open { color: var(--accent); border-color: var(--accent); }
  `;
  document.head.append(style);
}

initStyle();

const planList = document.getElementById("priority-list");
if (planList) {
  new MutationObserver(() => decoratePlan()).observe(planList, {
    childList: true,
  });
}

export { decoratePlan };
