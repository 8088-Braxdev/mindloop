// js/reminders.js
// In-app reminders for today's priorities (spec §5, honest scope).
//
// What this IS: a reminder shown inside the app while the app is open, at the
// moment a priority's start time arrives. Start / snooze / change time /
// done / stuck — and none of them assume the person failed.
//
// What this is NOT: a guaranteed closed-app push notification. Web push while
// the app is closed needs a server-side push subscription and scheduler,
// which is a later step. If the app was not open at the start time, the card
// simply appears when the person returns and the item still needs an answer.
//
// This module is self-contained: it builds its own card inside the Today
// view and its own setting inside the Account card, so index.html and ui.js
// do not change. It is loaded by settings.js after the app DOM exists.

import {
  getEntriesLocal,
  markPriority,
  reschedulePriority,
} from "./storage.js";
import { getCardPlan, toDateKey } from "./logic.js";
import { cachedUserId } from "./auth.js";

const TICK_MS = 30000; // check every 30 seconds
const REMINDER_KEY = "mindloop:reminders";
const FOLLOWUP_KEY = "mindloop:followup";
const VALID_FOLLOWUP = new Set([0, 5, 15, 30]);
const LEAD_KEY = "mindloop:reminder-lead";
const VALID_LEAD = new Set([0, 5, 10, 15]);

const idOf = (sourceDate, index) => `${sourceDate}#${index}`;

/* ---------- Small per-device store ---------- */

function readStore() {
  try {
    const raw = localStorage.getItem(REMINDER_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(REMINDER_KEY, JSON.stringify(store));
  } catch {
    // Per-device convenience; a failed write is not fatal.
  }
}

function readFollowup() {
  const uid = cachedUserId();
  if (!uid) return 0;
  try {
    const value = Number(localStorage.getItem(`${FOLLOWUP_KEY}:${uid}`));
    return VALID_FOLLOWUP.has(value) ? value : 0;
  } catch {
    return 0;
  }
}

function setFollowup(value) {
  const uid = cachedUserId();
  if (!uid || !VALID_FOLLOWUP.has(value)) return;
  try {
    localStorage.setItem(`${FOLLOWUP_KEY}:${uid}`, String(value));
  } catch {
    // Same as above: convenience setting, not fatal.
  }
}

// How many minutes before a priority's start time the card appears.
function readLead() {
  const uid = cachedUserId();
  if (!uid) return 0;
  try {
    const value = Number(localStorage.getItem(`${LEAD_KEY}:${uid}`));
    return VALID_LEAD.has(value) ? value : 0;
  } catch {
    return 0;
  }
}

function setLead(value) {
  const uid = cachedUserId();
  if (!uid || !VALID_LEAD.has(value)) return;
  try {
    localStorage.setItem(`${LEAD_KEY}:${uid}`, String(value));
  } catch {
    // Convenience setting, not fatal.
  }
}

// Drop records for priorities that now have an answer. Keeps the store small
// and prevents stale reminders for finished work.
function pruneAnswered(store, items, sourceDate) {
  let changed = false;
  for (const id of Object.keys(store)) {
    if (!id.startsWith(`${sourceDate}#`)) continue;
    const index = Number(id.split("#")[1]);
    const item = items.find((i) => i.index === index);
    if (
      !item ||
      item.doneAt ||
      item.skippedAt ||
      item.postponedAt ||
      item.startedAt
    ) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

function needsReminder(item, planDate, now, leadMin = 0) {
  // Only items with a start time whose moment is near, still unanswered.
  if (!item.time) return false;
  if (item.doneAt || item.skippedAt || item.postponedAt || item.startedAt)
    return false;
  const start = new Date(`${planDate}T${item.time}:00`);
  if (Number.isNaN(start.getTime())) return false;
  return now.getTime() >= start.getTime() - leadMin * 60000;
}

/* ---------- DOM the module owns ---------- */

function buildCard() {
  const card = document.createElement("div");
  card.id = "reminder-card";
  card.className = "card";
  card.hidden = true;

  const title = document.createElement("h2");
  title.className = "reminder-title";

  const when = document.createElement("p");
  when.className = "reminder-when";

  const note = document.createElement("p");
  note.className = "reminder-note";

  const actions = document.createElement("div");
  actions.className = "reminder-actions";

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "plan-btn reminder-dismiss";

  card.append(title, when, note, actions, dismiss);
  return card;
}

function buildSettings() {
  const wrap = document.createElement("div");
  const head = document.createElement("h3");
  head.textContent = "Reminders";

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "MindLoop uses each priority's start time. When that time is near and the app is open, a reminder card appears. Reminders never assume you failed, and there are no endless alerts."

  const leadLabel = document.createElement("label");
  leadLabel.htmlFor = "reminder-lead-select";
  leadLabel.textContent = "Remind me";

  const lead = document.createElement("select");
  lead.id = "reminder-lead-select";
  lead.setAttribute("aria-label", "When to remind you before a priority starts");
  for (const [value, text] of [
    [0, "At the start time"],
    [5, "5 minutes before"],
    [10, "10 minutes before"],
    [15, "15 minutes before"],
  ]) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = text;
    lead.append(option);
  }
  lead.value = String(readLead());
  lead.addEventListener("change", () => setLead(Number(lead.value)));

  const label = document.createElement("label");
  label.htmlFor = "followup-select";
  label.textContent = "Follow-up after dismissing a reminder";

  const select = document.createElement("select");
  select.id = "followup-select";
  select.setAttribute("aria-label", "Follow-up reminder timing");
  for (const [value, text] of [
    [0, "No follow-up"],
    [5, "After 5 minutes"],
    [15, "After 15 minutes"],
    [30, "After 30 minutes"],
  ]) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = text;
    select.append(option);
  }
  select.value = String(readFollowup());
  select.addEventListener("change", () => setFollowup(Number(select.value)));

  const scope = document.createElement("p");
  scope.className = "hint";
  scope.textContent =
    "In-app only for now. Closed-app notifications need a push subscription and arrive in a later update — MindLoop will never claim guaranteed delivery.";

  wrap.append(head, hint, leadLabel, lead, label, select, scope);
  return wrap;
}

let card = null;

function ensureCard() {
  const today = document.getElementById("view-today");
  if (!today) return null;
  if (!card || !card.isConnected) {
    card = today.querySelector("#reminder-card");
    if (!card) {
      card = buildCard();
      today.prepend(card);
    }
  }
  return card;
}

/* ---------- Rendering ---------- */

let shownId = null;

function hideCard() {
  if (card) card.hidden = true;
  shownId = null;
}

// The friendly text uses the person's own words (the task), never shame.
function reminderText(item, now) {
  const start = item.time
    ? new Date(`${toDateKey(now)}T${item.time}:00`)
    : null;
  const minutes =
    start && !Number.isNaN(start.getTime())
      ? Math.round((start.getTime() - now.getTime()) / 60000)
      : 0;
  let when;
  if (minutes > 0) {
    when = `"${item.text}" starts in ${minutes} min (${item.time}).`;
  } else if (minutes === 0) {
    when = `"${item.text}" starts now (${item.time}).`;
  } else {
    when = `You planned "${item.text}" for ${item.time} (${Math.abs(minutes)} min ago).`;
  }
  return {
    title: "Muda wako wa kuanza umefika",
    when,
    note: "Huhitaji kumaliza kila kitu sasa — dakika 5 tu za kuanza zinatosheleza.",
  };
}

function act(promise) {
  promise.catch((err) => {
    console.error("MindLoop: reminder action failed", err);
  });
}

function wireActions(actions, item, sourceDate, id) {
  const btn = (iconId, label, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "plan-btn";
    b.setAttribute("aria-label", label);
    b.dataset.tip = label;
    b.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${iconId}"/></svg><span class="btn-label">${label}</span>`;
    b.addEventListener("click", onClick);
    return b;
  };

  actions.replaceChildren(
    btn("i-play", "Nimeana — Start", () => {
      act(markPriority(sourceDate, item.index, "startedAt"));
      hideCard();
    }),
    btn("i-clock", "Nikumbushe baadaye (15 min)", () => {
      const s = readStore();
      s[id] = {
        ...s[id],
        sourceDate,
        snoozedUntil: Date.now() + 15 * 60000,
      };
      writeStore(s);
      hideCard();
    }),
    btn("i-calendar", "Badilisha muda", () => {
      const time = prompt(
        `New start time for "${item.text}" (HH:MM). Leave empty for no time.`,
        item.time || "",
      );
      if (time === null) return;
      const clean = (time || "").trim();
      if (clean !== "" && !/^\d{1,2}:\d{2}$/.test(clean)) {
        if (card) {
          card.querySelector(".reminder-note").textContent =
            "Use a time like 09:30, or leave it empty.";
        }
        return;
      }
      act(reschedulePriority(sourceDate, item.index, clean));
      hideCard();
    }),
    btn("i-check", "Nimekamilisha", () => {
      act(markPriority(sourceDate, item.index, "doneAt"));
      hideCard();
    }),
    btn("i-help", "Nimekwama", () => {
      // Spec §6: stuck opens Rescue Mode, it does not postpone the task.
      import("./rescue.js")
        .then((rescue) => {
          hideCard();
          rescue.openRescue(item, sourceDate);
        })
        .catch((err) => {
          console.error("MindLoop: rescue module failed to load", err);
        });
    }),
  );
}

export function renderReminders() {
  const c = ensureCard();
  if (!c) return;

  const entries = getEntriesLocal();
  const { sourceDate, planDate, items } = getCardPlan(
    entries,
    toDateKey(new Date()),
    false,
  );
  const now = new Date();
  const store = readStore();
  const leadMin = readLead();
  pruneAnswered(store, items, sourceDate);

  const followupMin = readFollowup();
  let target = null;

  if (planDate <= toDateKey(now)) {
    for (const item of items) {
      if (!needsReminder(item, planDate, now, leadMin)) continue;
      const id = idOf(sourceDate, item.index);
      const record = store[id];

      if (!record) {
        target = { item, id, first: true };
        break;
      }
      if (record.snoozedUntil) {
        if (now.getTime() >= record.snoozedUntil) {
          target = { item, id, first: false };
          break;
        }
        continue;
      }
      if (record.dismissedAt) {
        // Follow-up: re-offer once after the configured minutes.
        if (followupMin > 0) {
          const due = record.dismissedAt + followupMin * 60000;
          if (now.getTime() >= due && !record.followedUp) {
            target = { item, id, first: false };
            break;
          }
        }
        continue;
      }
      // A record exists but is in no known state: treat as fresh.
      target = { item, id, first: true };
      break;
    }
  }

  if (!target) {
    if (shownId) hideCard();
    return;
  }
  if (shownId === target.id) return; // already showing this one

  const { item, id, first } = target;
  store[id] = { ...(store[id] || {}), sourceDate };
  writeStore(store);

  const text = reminderText(item, now);
  c.querySelector(".reminder-title").textContent = text.title;
  c.querySelector(".reminder-when").textContent = text.when;
  c.querySelector(".reminder-note").textContent = text.note;

  wireActions(c.querySelector(".reminder-actions"), item, sourceDate, id);

  const dismiss = c.querySelector(".reminder-dismiss");
  dismiss.textContent = "Not now";
  dismiss.onclick = () => {
    const s = readStore();
    s[id] = {
      ...s[id],
      dismissedAt: Date.now(),
      followedUp: first ? false : true,
    };
    writeStore(s);
    hideCard();
  };

  shownId = id;
  c.hidden = false;
  c.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------- Init ---------- */

let timer = null;

function initReminders() {
  // Settings live in the Account card, above the WhatsApp footer.
  const accountCard = document.getElementById("account-card");
  if (accountCard) {
    const footer = accountCard.querySelector(".data-footer");
    const settings = buildSettings();
    footer
      ? accountCard.insertBefore(settings, footer)
      : accountCard.append(settings);
  }

  renderReminders();
  if (timer) clearInterval(timer);
  timer = setInterval(renderReminders, TICK_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderReminders();
  });
}

initReminders();
