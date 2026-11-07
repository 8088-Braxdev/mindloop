// js/reminders.js
// In-app reminders for today's priorities (spec §5, honest scope).
//
// What this IS: a reminder shown inside the app when the app is open, at the
// moment a priority's start time arrives. Snooze, change time, done, postpone.
//
// What this is NOT: a guaranteed closed-app push notification. Web push while
// the app is closed needs a server-side push subscription and scheduler, which
// is a separate step. If the app was not open at the start time, the card is
// shown when the person returns and the item still needs an answer.
//
// Duplicate rules: one reminder per priority until it is answered or snoozed.
// A snoozed item is quiet for its snooze window. A dismissed item can be
// re-offered once by the follow-up setting, then stays quiet.

import { getEntriesLocal } from "./storage.js";
import { getCardPlan, priorityStatus, toDateKey } from "./logic.js";
import { cachedUserId } from "./auth.js";

const TICK_MS = 30000; // check every 30 seconds
const REMINDER_KEY = "mindloop:reminders";
const FOLLOWUP_KEY = "mindloop:followup";
const VALID_FOLLOWUP = new Set([0, 5, 15, 30]);

const idOf = (sourceDate, index) => `${sourceDate}#${index}`;

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
    // Reminders are per-device convenience; a failed write is not fatal.
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

export function setFollowup(value) {
  const uid = cachedUserId();
  if (!uid || !VALID_FOLLOWUP.has(value)) return;
  try {
    localStorage.setItem(`${FOLLOWUP_KEY}:${uid}`, String(value));
  } catch {
    // Convenience setting; not fatal if storage is blocked.
  }
}

// Drop the record for a priority once it has an answer (done/skipped/postponed
// or was started). Keeps the store small and prevents stale reminders.
function pruneAnswered(store, items, sourceDate) {
  let changed = false;
  for (const id of Object.keys(store)) {
    if (!id.startsWith(`${sourceDate}#`)) continue;
    const index = Number(id.split("#")[1]);
    const item = items.find((i) => i.index === index);
    if (!item || item.doneAt || item.skippedAt || item.postponedAt || item.startedAt) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

function needsReminder(item, planDate, now) {
  // Only items with a start time whose moment has come, still unanswered.
  if (!item.time) return false;
  if (item.doneAt || item.skippedAt || item.postponedAt || item.startedAt)
    return false;
  return priorityStatus(item, planDate, now) === "late";
}

/* ---------- Rendering ---------- */

let shownId = null;

function hideCard() {
  const card = document.getElementById("reminder-card");
  if (card) card.hidden = true;
  shownId = null;
}

// The friendly text uses the person's own words (the task), never shame.
function reminderText(item, now) {
  const lateBy = item.time
    ? Math.max(
        0,
        Math.round(
          (now - new Date(`${toDateKey(now)}T${item.time}:00`).getTime()) /
            60000,
        ),
      )
    : 0;
  const when =
    lateBy > 0 && lateBy < 60
      ? `You planned "${item.text}" for ${item.time} (${lateBy} min ago).`
      : `You planned "${item.text}" for ${item.time}.`;
  return {
    title: "Time to start 📚",
    when,
    note: "You don't have to finish everything now — starting with 5 focused minutes counts.",
  };
}

export function renderReminders() {
  const card = document.getElementById("reminder-card");
  if (!card) return;

  const entries = getEntriesLocal();
  const { sourceDate, planDate, items } = getCardPlan(
    entries,
    toDateKey(new Date()),
    false,
  );
  const now = new Date();
  const store = readStore();
  pruneAnswered(store, items, sourceDate);

  const followupMin = readFollowup();
  let target = null;

  if (planDate <= toDateKey(now)) {
    for (const item of items) {
      if (!needsReminder(item, planDate, now)) continue;
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

  const { item, id } = target;
  store[id] = { ...(store[id] || {}), sourceDate };
  writeStore(store);

  const text = reminderText(item, now);
  card.querySelector(".reminder-title").textContent = text.title;
  card.querySelector(".reminder-when").textContent = text.when;
  card.querySelector(".reminder-note").textContent = text.note;

  const actions = card.querySelector(".reminder-actions");
  actions.replaceChildren();

  const btn = (label, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "plan-btn";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  };

  const emit = (action, extra = {}) =>
    card.dispatchEvent(
      new CustomEvent("reminder-action", {
        detail: { action, item, sourceDate, ...extra },
      }),
    );

  // The card lives in index.html; ui.js listens and does the data work.
  actions.append(
    btn("Nimeanza — Start", () => emit("start")),
    btn("Nikumbushe baadaye (15 min)", () => emit("snooze", { minutes: 15 })),
    btn("Badilisha muda", () => emit("change-time")),
    btn("Nimekamilisha", () => emit("done")),
    btn("Nimekwama", () => emit("postpone")),
  );

  const dismiss = card.querySelector(".reminder-dismiss");
  dismiss.textContent = "Not now";
  dismiss.onclick = () => {
    const s = readStore();
    s[id] = {
      ...s[id],
      dismissedAt: Date.now(),
      followedUp: target.first ? false : true,
    };
    writeStore(s);
    hideCard();
  };

  shownId = id;
  card.hidden = false;
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export function markReminderSnoozed(sourceDate, index, minutes) {
  const s = readStore();
  s[idOf(sourceDate, index)] = {
    ...s[idOf(sourceDate, index)],
    sourceDate,
    snoozedUntil: Date.now() + minutes * 60000,
  };
  writeStore(s);
  hideCard();
}

export function markReminderActioned(sourceDate, index) {
  const s = readStore();
  delete s[idOf(sourceDate, index)];
  writeStore(s);
  hideCard();
}

let timer = null;

export function initReminders() {
  renderReminders();
  if (timer) clearInterval(timer);
  timer = setInterval(renderReminders, TICK_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderReminders();
  });
}
