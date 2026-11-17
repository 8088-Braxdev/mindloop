// js/reminders.js
// Reminders for the day's priorities (spec §5, honest scope).
//
// What this IS: when a priority's start time arrives, a reminder card appears
// at the top of Today, and — if the person allowed notifications — a device
// notification with the same words. One reminder per priority, no follow-ups.
//
// What this is NOT: a guaranteed closed-app push notification. Web push while
// the app is closed needs a server-side push subscription and scheduler,
// which is a later step. If the app was not open at the start time, the card
// simply appears when the person returns and the item still needs an answer.
//
// This module is self-contained: it builds its own card inside the Today
// view and its own settings inside the Account card, so index.html and ui.js
// do not need to change. It is loaded by settings.js after the app DOM exists.

import {
  getEntriesLocal,
  markPriority,
  reschedulePriority,
} from "./storage.js";
import { getCardPlan, toDateKey } from "./logic.js";
import { cachedUserId } from "./auth.js";

const TICK_MS = 30000; // check every 30 seconds
const REMINDER_KEY = "mindloop:reminders";
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

// How many minutes before a priority's start time the reminder appears.
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

/* ---------- Device notifications ---------- */

function notificationState() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

// The same reminder, delivered to the phone's notification tray. This is a
// local notification: nothing is sent anywhere, and it only exists while the
// app is running. The service worker shows it when the browser supports that
// (phones do not allow `new Notification()` from a page).
async function showDeviceNotification(title, body, tag) {
  if (notificationState() !== "granted") return;
  const options = {
    body,
    tag,
    icon: "icons/icon-192.png",
    badge: "icons/favicon-32.png",
    data: { url: "./" },
  };
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
      return;
    }
    new Notification(title, options);
  } catch (err) {
    // A blocked or unsupported notification must never break the reminder.
    console.warn("MindLoop: device notification failed", err);
  }
}

function buildNotificationControl() {
  const wrap = document.createDocumentFragment();

  const button = document.createElement("button");
  button.type = "button";
  button.id = "reminder-permission";
  button.className = "plan-btn";

  const status = document.createElement("p");
  status.className = "hint";
  status.id = "reminder-permission-status";

  const paint = () => {
    const state = notificationState();
    button.hidden = state !== "default";
    if (state === "granted") {
      status.textContent =
        "Notifications are on. Each reminder also appears in your phone's notification tray while MindLoop is open.";
    } else if (state === "denied") {
      status.textContent =
        "Notifications are blocked for MindLoop. You can allow them again in your browser's site settings. The reminder card still appears inside the app.";
    } else if (state === "unsupported") {
      status.textContent =
        "This browser does not support notifications. The reminder card still appears inside the app.";
    } else {
      status.textContent = "";
    }
  };

  button.textContent = "Turn on notifications";
  button.addEventListener("click", async () => {
    try {
      await Notification.requestPermission();
    } catch (err) {
      console.warn("MindLoop: notification permission failed", err);
    }
    paint();
  });

  paint();
  wrap.append(button, status);
  return wrap;
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
    "MindLoop uses each priority's start time. When that time is near and the app is open, a reminder card appears at the top of Today. If you set a finish time too, one gentle heads-up follows when that time is reached and the task still has no answer. One reminder each — no follow-ups, and none of them assume you failed.";

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

  const scope = document.createElement("p");
  scope.className = "hint";
  scope.textContent =
    "This applies to every priority with a start time. Closed-app notifications need a push server and arrive in a later update — MindLoop will never claim guaranteed delivery.";

  wrap.append(head, hint, leadLabel, lead, buildNotificationControl(), scope);
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

// A finish time is a small promise the person made to themselves. When it is
// reached and the task still has no answer, one calm heads-up — never a
// "you failed" message, and never a second one.
function notifyExpectedFinish(items, sourceDate, planDate, now, store) {
  for (const item of items) {
    if (!item.time || !item.endTime) continue;
    if (item.doneAt || item.skippedAt || item.postponedAt) continue;
    const id = idOf(sourceDate, item.index);
    const record = store[id] || {};
    if (record.endNotifiedAt) continue;
    // Only after the start reminder was already delivered: opening the app
    // late should not fire both messages at once.
    if (!record.notifiedAt) continue;
    const end = new Date(`${planDate}T${item.endTime}:00`);
    if (Number.isNaN(end.getTime()) || now.getTime() < end.getTime()) continue;
    store[id] = { ...record, sourceDate, endNotifiedAt: Date.now() };
    writeStore(store);
    showDeviceNotification(
      "Muda wa kumaliza umefika",
      `"${item.text}" — ulipanga kumaliza saa ${item.endTime}. Unaendelea?`,
      `mindloop-finish-${item.time}-${item.index}`,
    );
  }
}

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
    btn("i-play", "Nimeanza — Start", () => {
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
  notifyExpectedFinish(items, sourceDate, planDate, now, store);

  let target = null;

  if (planDate <= toDateKey(now)) {
    for (const item of items) {
      if (!needsReminder(item, planDate, now, leadMin)) continue;
      const id = idOf(sourceDate, item.index);
      const record = store[id];

      if (record?.snoozedUntil && now.getTime() < record.snoozedUntil) continue;
      if (record?.dismissedAt) continue;
      target = { item, id };
      break;
    }
  }

  if (!target) {
    if (shownId) hideCard();
    return;
  }
  if (shownId === target.id) return; // already showing this one

  const { item, id } = target;
  const record = store[id] || {};
  // One device notification per priority, at the first moment it is due.
  if (!record.notifiedAt) {
    showDeviceNotification(
      "Muda wa kuanza umefika",
      `"${item.text}" — ${item.time}. Dakika 5 tu za kuanza zinatosheleza.`,
      `mindloop-start-${item.time}-${item.index}`,
    );
    store[id] = { ...record, sourceDate, notifiedAt: Date.now() };
  } else {
    store[id] = { ...record, sourceDate };
  }
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
    s[id] = { ...s[id], dismissedAt: Date.now() };
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
