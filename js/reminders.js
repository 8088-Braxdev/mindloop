// js/reminders.js
// Reminders for the day's priorities (spec §5, honest scope).
//
// What this IS: when a priority's start time arrives, a reminder card appears
// at the top of Today, and — if the person allowed notifications — a device
// notification with the same words. One reminder per priority, no follow-ups.
// Permission is asked at the end of the tour and, if it was never answered,
// from Account by a plain "Allow notifications" control (see js/notify.js).
// Account also states whether closed-app delivery actually works on this device
// instead of claiming it does.
//
// Closed-app delivery is real too, and lives elsewhere: js/push.js stores this
// device's Web Push subscription and api/push-send.js sends the reminder at the
// start time (scheduled every 5 minutes, see PUSH.md). Both paths are best
// effort — a phone that is off, offline or out of battery is not a failure, and
// the card is still waiting when the person returns.
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
import {
  notificationState,
  notificationReport,
  requestNotifications,
  onNotificationChange,
  askOnFirstTap,
  syncPushIfGranted,
} from "./notify.js";
import { askStartTime } from "./timesheet.js";

const TICK_MS = 30000; // check every 30 seconds
const REMINDER_KEY = "mindloop:reminders";
const LEAD_KEY = "mindloop:reminder-lead";
const QUIET_KEY = "mindloop:quiet-hours";
const VALID_LEAD = new Set([0, 5, 10, 15]);
const DEFAULT_QUIET = { on: false, from: "22:00", to: "07:00" };

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

// Each priority may choose its own lead in the night review (spec §4); Account
// holds the default for the ones that did not choose.
function leadFor(item) {
  const own = Number(item?.remind);
  return VALID_LEAD.has(own) ? own : readLead();
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

/* ---------- Quiet hours (spec §5) ---------- */

function readQuiet() {
  const uid = cachedUserId();
  if (!uid) return { ...DEFAULT_QUIET };
  try {
    const raw = localStorage.getItem(`${QUIET_KEY}:${uid}`);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_QUIET };
    return {
      on: !!parsed.on,
      from: parsed.from || DEFAULT_QUIET.from,
      to: parsed.to || DEFAULT_QUIET.to,
    };
  } catch {
    return { ...DEFAULT_QUIET };
  }
}

function setQuiet(quiet) {
  const uid = cachedUserId();
  if (!uid) return;
  try {
    localStorage.setItem(`${QUIET_KEY}:${uid}`, JSON.stringify(quiet));
  } catch {
    // A per-device convenience; the reminder card works without it.
  }
  // Closed-app reminders are sent by the server, so it needs this device's
  // quiet hours too (js/push.js). Without a subscription this is a no-op.
  import("./push.js")
    .then((push) => push.syncQuietHours(quiet))
    .catch(() => {});
}

const clockMinutes = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

// Quiet hours may cross midnight, and they only silence the device: the card
// inside the app still appears, because that is the person asking to be shown.
function inQuietHours(now = new Date()) {
  const quiet = readQuiet();
  if (!quiet.on) return false;
  const from = clockMinutes(quiet.from);
  const to = clockMinutes(quiet.to);
  if (from === null || to === null) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  return from <= to ? at >= from && at < to : at >= from || at < to;
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

// The same reminder, delivered to the phone's notification tray. This is a
// local notification: nothing is sent anywhere, and it only exists while the
// app is running. The service worker shows it when the browser supports that
// (phones do not allow `new Notification()` from a page).
async function showDeviceNotification(title, body, tag) {
  if (notificationState() !== "granted") return;
  if (inQuietHours()) return; // phone stays quiet; the card still appears
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

// The account line tells the plain truth about this device: allowed or not,
// and whether a closed-app reminder can actually reach it. A permission the
// person never answered is fixed here, by a real tap.
function buildNotificationStatus() {
  const box = document.createElement("div");
  box.className = "notif-status";

  // Named, so the line is easy to find in Account instead of reading as a
  // stray hint when notifications are already on and there is nothing to tap.
  const title = document.createElement("p");
  title.className = "notif-title";
  title.textContent = "Notifications on this device";

  const status = document.createElement("p");
  status.className = "hint";
  status.id = "reminder-permission-status";

  const action = document.createElement("button");
  action.type = "button";
  action.className = "plan-btn notif-action";

  // The one check the app cannot do alone: ask the server to send right now.
  // It tells the person which half is broken — the saved device and keys, or
  // the 5-minute schedule that sends the real reminders.
  const test = document.createElement("button");
  test.type = "button";
  test.className = "plan-btn notif-action notif-test";
  test.textContent = "Send a test notification";
  test.hidden = true;

  const testResult = document.createElement("p");
  testResult.className = "hint notif-test-result";
  testResult.setAttribute("role", "status");
  testResult.hidden = true;

  const setTestResult = (text) => {
    testResult.textContent = text || "";
    testResult.hidden = !text;
  };

  const paint = (report) => {
    action.disabled = false;
    test.disabled = false;
    // Only a device that is allowed to notify can receive a test at all.
    test.hidden = report.permission !== "granted";
    if (test.hidden) setTestResult("");
    if (report.permission === "unsupported") {
      action.hidden = true;
      status.textContent = report.iosTab
        ? "This browser cannot show notifications. On iPhone and iPad they only work after MindLoop is added to the Home Screen; a Safari tab never shows them. The reminder card still appears inside the app."
        : "This browser does not support notifications. The reminder card still appears inside the app.";
      return;
    }
    if (report.permission === "denied") {
      action.hidden = true;
      status.textContent =
        "Notifications are blocked for MindLoop in this browser, so the app cannot ask again. You can allow them in your browser's site settings; the reminder card still appears inside the app.";
      return;
    }
    if (report.permission === "default") {
      action.hidden = false;
      action.textContent = "Allow notifications";
      status.textContent =
        "MindLoop has not been allowed to notify this device yet, so nothing reaches your phone. Tap Allow and your browser asks once. The reminder card works inside the app either way.";
      return;
    }
    if (report.push === "on") {
      // Nothing left to tap: a button here would read like a problem. The test
      // below is a check, not a fix, so it stays available.
      action.hidden = true;
      status.textContent =
        "Notifications are on for this device, and your account has this device saved. MindLoop sends one reminder when a priority's start time arrives — usually within 10 minutes — even while the app is closed. If this device is offline or asleep at that moment, the push service holds the reminder and delivers it when the connection returns, for up to 12 hours; after that it can be lost, and the reminder card is still waiting inside the app. Delivery also depends on this phone or computer, its notification settings and the browser's push service.";
      return;
    }
    if (report.saved === false) {
      // The browser has a subscription, but the account does not. Saying "on"
      // here would promise a reminder the server cannot send.
      action.hidden = false;
      action.textContent = "Try again";
      status.textContent =
        "Notifications are allowed, but this device is not saved to your account, so MindLoop's server has nowhere to send a closed-app reminder. Tap Try again. If it keeps happening, the push tables or keys on the server are not set up (see PUSH.md).";
      return;
    }
    action.hidden = false;
    action.textContent = "Try again";
    const why = {
      "no-server-key": "MindLoop's push keys are not set up on the server yet",
      "signed-out": "you are signed out on this device",
      "no-service-worker": "the service worker is not ready yet",
      save: "this device could not be saved to your account",
      subscribe: "this browser refused a push subscription",
      incomplete: "this browser returned an incomplete subscription",
      unsupported: "this browser does not support push",
      permission: "notifications are not allowed",
    }[report.reason];
    status.textContent = `Notifications are allowed for MindLoop, but closed-app reminders are not working on this device${why ? ` — ${why}` : ""}. Reminders appear inside the app only while it is open.`;
  };

  const refresh = () => {
    action.disabled = true;
    notificationReport()
      .then(paint)
      .catch(() => {
        action.disabled = false;
        status.textContent =
          "MindLoop could not check this device's notification state.";
      });
  };

  test.addEventListener("click", () => {
    test.disabled = true;
    setTestResult("Asking the server to send one test notification…");
    import("./push.js")
      .then((push) => push.testPush())
      .then((result) => {
        test.disabled = false;
        if (result.ok && result.sent > 0) {
          const many =
            result.devices > 1
              ? `${result.devices} devices on this account`
              : "this device";
          let text = `The server sent the test just now to ${many}.`;
          if (result.failures?.length) {
            text += ` ${result.failures.length} of them could not be reached.`;
          }
          text +=
            " If this device is offline it will arrive when the connection returns, up to 12 hours later, just like a reminder. If nothing appeared at all, this phone or browser held it back — not MindLoop's schedule. On iPhone, leave MindLoop before it arrives: iOS decides when to show it. If this test arrives but reminders at a priority's start time never do, the 5-minute schedule is the part that is not running.";
          setTestResult(text);
          return;
        }
        const missing = result.missing?.length
          ? ` It is missing: ${result.missing.join(", ")}.`
          : "";
        const why =
          {
            setup: `The server is not set up for closed-app reminders yet.${missing}`,
            "no-subscription":
              "The server has no saved device for this account, so nothing can be sent. Tap Try again above to save this device first.",
            server: "The server could not read this account's devices.",
            signin:
              "This device's session has expired. Sign in again, then try the test.",
            permission:
              "Notifications are not allowed on this device, so nothing can be shown.",
            network:
              "This device could not reach the server. Check the connection and try again.",
          }[result.code] ||
          `The server answered with ${result.http || "an error"}.`;
        let text = why;
        const failures = result.failures || [];
        const gone = failures.filter((f) => f.status === "gone").length;
        if (gone) {
          text += ` The push service said ${gone === 1 ? "this device's subscription is" : `${gone} of these subscriptions are`} gone (410), so ${gone === 1 ? "it was" : "they were"} removed. Tap Try again above to make a new one.`;
        }
        const refused = failures.find((f) => f.status && f.status !== "gone");
        if (refused) {
          text += ` The push service refused the send (${refused.status}).`;
        }
        setTestResult(text);
      })
      .catch(() => {
        test.disabled = false;
        setTestResult("The test could not be sent from this device. Try again.");
      });
  });

  action.addEventListener("click", () => {
    action.disabled = true;
    status.textContent = "Checking this device…";
    requestNotifications()
      .then(paint)
      .catch(() => {
        action.disabled = false;
        status.textContent =
          "MindLoop could not change this device's notification setting.";
      });
  });

  refresh();
  // The ask can be answered while this card is already on screen (for example
  // the automatic ask on the first tap). Repaint so it never keeps showing
  // "Allow notifications" after the permission was granted.
  onNotificationChange(refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });

  box.append(title, status, action, test, testResult);
  return box;
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

  // Two answers in their own row, the quieter plan moves under them: five
  // equal buttons in one grid read as a wall nobody wants to read.
  const actions = document.createElement("div");
  actions.className = "reminder-actions reminder-answers";

  const secondary = document.createElement("div");
  secondary.className = "plan-secondary reminder-secondary";

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "plan-btn reminder-dismiss";

  card.append(title, when, note, actions, secondary, dismiss);
  return card;
}

function buildSettings() {
  const wrap = document.createElement("div");
  const head = document.createElement("h3");
  head.textContent = "Reminders";

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "MindLoop uses each priority's start time. When that moment is near and the app is open, a reminder card appears at the top of Today. If you set a finish time too, one gentle heads-up follows when that time is reached and the task still has no answer. One reminder each — no follow-ups, and none of them assume you failed.";

  const leadLabel = document.createElement("label");
  leadLabel.htmlFor = "reminder-lead-select";
  leadLabel.textContent = "Remind me by default";

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
    "This is the default for every priority with a start time. Each priority can pick its own reminder in the night review's \"Remind me\" row. Closed-app reminders are worked out from each device's own clock by MindLoop's scheduler, which runs every 5 minutes, so one can arrive up to 10 minutes after the moment you chose. A device that is offline or asleep is not skipped: the push service holds the reminder and delivers it when the connection returns, for up to 12 hours. Each device you signed in on gets its own reminder, with its own quiet hours.";

  wrap.append(
    head,
    hint,
    leadLabel,
    lead,
    buildNotificationStatus(),
    buildQuietHours(),
    scope,
  );
  return wrap;
}

// Quiet hours: silence the phone, never the app.
function buildQuietHours() {
  const box = document.createElement("div");
  box.className = "quiet-hours";

  const head = document.createElement("h3");
  head.textContent = "Quiet hours";

  const toggle = document.createElement("label");
  toggle.className = "quiet-toggle";
  toggle.htmlFor = "quiet-on";

  const on = document.createElement("input");
  on.type = "checkbox";
  on.id = "quiet-on";

  const toggleText = document.createElement("span");
  toggleText.textContent = "No MindLoop notifications during these hours";
  toggle.append(on, toggleText);

  // Two labelled fields side by side: the label sits above its own input, so
  // the row keeps its shape on a narrow phone and on a wide screen.
  const field = (id, labelText) => {
    const wrap = document.createElement("label");
    wrap.className = "quiet-field";
    wrap.htmlFor = id;
    const text = document.createElement("span");
    text.textContent = labelText;
    const input = document.createElement("input");
    input.type = "time";
    input.id = id;
    wrap.append(text, input);
    return { wrap, input };
  };

  const fromField = field("quiet-from", "From");
  const toField = field("quiet-to", "To");
  const from = fromField.input;
  const to = toField.input;

  const arrow = document.createElement("span");
  arrow.className = "quiet-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";

  const row = document.createElement("div");
  row.className = "quiet-row";
  row.append(fromField.wrap, arrow, toField.wrap);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "During these hours MindLoop sends no notification to this device, including closed-app reminders; the reminder card still appears inside the app. This only silences MindLoop — it does not switch on your phone's Do Not Disturb or mute other apps. The times may cross midnight.";

  const paint = () => {
    const quiet = readQuiet();
    on.checked = quiet.on;
    from.value = quiet.from;
    to.value = quiet.to;
    from.disabled = !quiet.on;
    to.disabled = !quiet.on;
  };

  const save = () => {
    setQuiet({
      on: on.checked,
      from: from.value || DEFAULT_QUIET.from,
      to: to.value || DEFAULT_QUIET.to,
    });
    paint();
  };

  on.addEventListener("change", save);
  from.addEventListener("change", save);
  to.addEventListener("change", save);

  paint();
  box.append(head, toggle, row, hint);
  return box;
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
      "Your finish time has arrived",
      `"${item.text}" — you planned to finish by ${item.endTime}. Still going?`,
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
    title: "It's time to start",
    when,
    note: "You do not have to finish everything now — five minutes of starting is enough.",
  };
}

function act(promise) {
  promise.catch((err) => {
    console.error("MindLoop: reminder action failed", err);
  });
}

function wireActions(actions, secondary, item, sourceDate, id) {
  const btn = (iconId, label, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "plan-btn";
    b.setAttribute("aria-label", label);
    b.dataset.tip = label;
    // The phone shows a short caption ("Nimeanza", "Badilisha muda") instead
    // of the full bilingual label, which is too long for three per row.
    const caption = label.split("—")[0].split("(")[0].trim() || label;
    b.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${iconId}"/></svg><span class="btn-label">${label}</span><span class="btn-caption">${caption}</span>`;
    b.addEventListener("click", onClick);
    return b;
  };

  // The two answers to the reminder itself.
  actions.replaceChildren(
    btn("i-play", "Nimeanza — Start", () => {
      act(markPriority(sourceDate, item.index, "startedAt"));
      hideCard();
    }),
    btn("i-check", "Nimekamilisha", () => {
      act(markPriority(sourceDate, item.index, "doneAt"));
      hideCard();
    }),
  );

  // Plan moves: quieter, below the answers, each with its own words.
  secondary.replaceChildren(
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
    btn("i-calendar", "Badilisha muda", async () => {
      const time = await askStartTime({
        title: "Badilisha muda wa kuanza",
        text: item.text,
        time: item.time || "",
      });
      if (time === null) return;
      act(reschedulePriority(sourceDate, item.index, time));
      hideCard();
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
  pruneAnswered(store, items, sourceDate);
  notifyExpectedFinish(items, sourceDate, planDate, now, store);

  let target = null;

  if (planDate <= toDateKey(now)) {
    for (const item of items) {
      if (!needsReminder(item, planDate, now, leadFor(item))) continue;
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
    const lead = leadFor(item);
    showDeviceNotification(
      lead > 0 ? "Heads-up: starting soon" : "Time to start",
      lead > 0
        ? `"${item.text}" starts at ${item.time} (in ${lead} min). Five minutes of starting is enough.`
        : `"${item.text}" — ${item.time}. Five minutes of starting is enough.`,
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

  wireActions(
    c.querySelector(".reminder-answers"),
    c.querySelector(".reminder-secondary"),
    item,
    sourceDate,
    id,
  );

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

  // Older accounts finished the tour before the app started asking; their next
  // real tap brings the prompt once.
  askOnFirstTap();

  // Already allowed? Keep this device's closed-app subscription current
  // (time zone, quiet hours) without asking anything.
  syncPushIfGranted();

  renderReminders();
  if (timer) clearInterval(timer);
  timer = setInterval(renderReminders, TICK_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderReminders();
  });
}

initReminders();
