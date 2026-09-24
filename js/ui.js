// js/ui.js  (part 1 of 2)
// DOM only. Numbers come from logic.js, data from storage.js.

import { getEntries, getEntry, saveEntry, markPriority, exportAll, clearAll, syncNow, hasPending, prepareSignOut } from "./storage.js";
import {
  toDateKey,
  computeStreak,
  getPlan,
  priorityStatus,
  mondayOf,
  shiftWeek,
  canGoPrev,
  canGoNext,
  weekStats,
  reasonChartData,
  dayChartData,
  worstWeekday,
  buildWeekSummary,
  needsAnswer,
} from "./logic.js";
import { getSession, signInWithGoogle, signOut, cachedUserId } from "./auth.js";

let currentWeek = mondayOf(toDateKey(new Date()));
let editing = false; // true = fomu ina review ya leo, inaeditiwa
let hasToday = false; // review ya leo imeshasaviwa

function clearForm() {
  $("review-form").reset();
}

function setStatus(message, isError = false) {
  const el = $("form-status");
  el.textContent = message;
  el.classList.toggle("is-error", isError);
}

function syncSubmitLabel() {
  const btn = $("review-form").querySelector("button[type='submit']");
  btn.textContent = !hasToday
    ? "Save review"
    : editing
      ? "Update review"
      : "Edit today's review";
}

function validate(review) {
  const hasContent =
    review.wins ||
    review.challenges ||
    review.lessons ||
    review.priorities.some((p) => p.text);
  if (!hasContent) {
    return {
      message: "Write at least one thing before saving.",
      focus: "wins",
    };
  }
  const i = review.priorities.findIndex((p) => p.text && !p.time);
  if (i !== -1) {
    return {
      message: `Add a start time for priority ${i + 1}.`,
      focus: `t${i + 1}`,
    };
  }
  return null;
}

const HONESTY = {
  ask: "You said you did it. Nobody is checking, this is only for you. Did you really finish it?",
  yes: "Well done. You did what you said you would.",
  no: "Thanks for the honest answer. That is what makes this useful.",
};
const confirming = new Set(); // priorities waiting for the second "are you sure?"

async function answer(sourceDate, index, field) {
  confirming.delete(index);
  await onMark(sourceDate, index, field);
}

function renderConfirm(entries) {
  const { sourceDate, items } = getPlan(entries, todayKey());
  const open = items.filter((i) => needsAnswer(i, todayKey()));

  // Block visible only until tonight's review is saved
  $("confirm-block").hidden = items.length === 0 || isDayClosed(items);
  // Every field locked until all items are answered
  $("review-fields").disabled = !hasToday && open.length > 0;

  $("confirm-list").replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      li.className = "plan-item";

      const text = document.createElement("p");
      text.className = "plan-text";
      text.textContent = `${item.text} (${item.time || "no time"})`;

      const note = document.createElement("p");
      note.className = "confirm-msg";

      const actions = document.createElement("div");
      actions.className = "plan-actions";

      if (item.doneAt) {
        note.textContent = HONESTY.yes;
      } else if (item.skippedAt) {
        note.textContent = HONESTY.no;
      } else if (!needsAnswer(item, todayKey())) {
        note.textContent = "Not due yet.";
      } else if (confirming.has(item.index)) {
        note.textContent = HONESTY.ask;
        actions.append(
          planButton("i-check", "Yes, honestly", () =>
            answer(sourceDate, item.index, "doneAt"),
          ),
          planButton("i-x", "No, not really", () =>
            answer(sourceDate, item.index, "skippedAt"),
          ),
        );
      } else {
        note.textContent = "Did you do it?";
        actions.append(
          planButton("i-check", "Yes", () => {
            confirming.add(item.index);
            renderConfirm(entries);
          }),
          planButton("i-x", "No", () =>
            answer(sourceDate, item.index, "skippedAt"),
          ),
        );
      }

      li.append(text, note, actions);
      return li;
    }),
  );
}
/* ---------- Helpers ---------- */

const $ = (id) => document.getElementById(id);
const todayKey = () => toDateKey(new Date());

// Part 2 fills this: onViewShow.week = renderWeek
const onViewShow = {};

/* ---------- Tabs ---------- */

function showView(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.hidden = view.id !== `view-${name}`;
  });
  if (onViewShow[name]) onViewShow[name]();
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  });
}


/* ---------- Streak label ---------- */

function renderStreak(entries) {
  const streak = computeStreak(entries, todayKey());
  const label = $("streak-label");
  if (streak === 0) {
    label.textContent = "No streak yet";
  } else {
    label.textContent = `Streak: ${streak} ${streak === 1 ? "day" : "days"}`;
  }
}

/* ---------- Today's plan ---------- */
const STATUS_TEXT = {
  done: "Done",
  started: "In progress",
  missed: "Missed",
  late: "Overdue",
  waiting: "Waiting",
  skipped: "Skipped",
};

function planButton(iconId, label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "plan-btn";
  btn.innerHTML = `<svg class="icon"><use href="#${iconId}"/></svg><span>${label}</span>`;
  btn.addEventListener("click", onClick);
  return btn;
}

function buildPlanItem(item, sourceDate) {
  const status = priorityStatus(item, todayKey(), new Date());

  const li = document.createElement("li");
  li.className = `plan-item is-${status}`;

  const text = document.createElement("p");
  text.className = "plan-text";
  text.textContent = item.text;

  const meta = document.createElement("p");
  meta.className = "plan-meta";
  meta.textContent = `${item.time || "No time"} · ${STATUS_TEXT[status]}`;

  const actions = document.createElement("div");
  actions.className = "plan-actions";
  if (!item.startedAt && !item.doneAt && !item.skippedAt) {
    actions.append(
      planButton("i-play", "Start", () =>
        onMark(sourceDate, item.index, "startedAt"),
      ),
    );
  }

  li.append(text, meta, actions);
  return li;
}

async function onMark(sourceDate, index, field) {
  try {
    await markPriority(sourceDate, index, field);
    await refresh();
  } catch (err) {
    console.error("MindLoop: mark failed", err);
    showAppError("Could not save that. Check your connection and try again.");
  }
}
const isDayClosed = (items) =>
  hasToday && items.every((i) => i.doneAt || i.skippedAt);

function renderPlan(entries) {
  const { sourceDate, items } = getPlan(entries, todayKey());
  $("plan-list").replaceChildren(
    ...items.map((i) => buildPlanItem(i, sourceDate)),
  );
  $("plan-card").hidden = items.length === 0 || isDayClosed(items);
}

/* ---------- Refresh + init ---------- */

async function refresh() {
  const entries = await getEntries();
  renderStreak(entries);
  renderPlan(entries);
  renderConfirm(entries);
  if (!$("view-week").hidden) await renderWeek();
    renderSyncStatus();
}

// If the text is unchanged, keep the previous done value.
function readForm(previous) {
  const old = (previous && previous.priorities) || [];
  const priorities = [1, 2, 3].map((n, i) => {
    const text = $(`p${n}`).value.trim();
    const time = text ? $(`t${n}`).value : ""; // saa bila maandishi inapuuzwa
    const same = old[i] && old[i].text === text;
    return {
      text,
      time,
      startedAt: same ? old[i].startedAt || null : null,
      doneAt: same ? old[i].doneAt || null : null,
      skippedAt: same ? old[i].skippedAt || null : null, // <- mstari huu mpya
    };
  });

  return {
    date: todayKey(),
    wins: $("wins").value.trim(),
    challenges: $("challenges").value.trim(),
    reason: $("reason").value,
    lessons: $("lessons").value.trim(),
    priorities,
  };
}

function fillForm(entry) {
  if (!entry) return;
  $("wins").value = entry.wins || "";
  $("challenges").value = entry.challenges || "";
  $("reason").value = entry.reason || "";
  $("lessons").value = entry.lessons || "";
  (entry.priorities || []).forEach((p, i) => {
    $(`p${i + 1}`).value = p.text || "";
    $(`t${i + 1}`).value = p.time || "";
  });
}

async function onSubmit(event) {
  event.preventDefault();
  const button = event.target.querySelector("button[type='submit']");

  // Imeshasaviwa leo na hatuedit bado: click hii inamaanisha "Edit"
  if (hasToday && !editing) {
    fillForm(await getEntry(todayKey()));
    editing = true;
    setStatus("Editing today's review.");
    syncSubmitLabel();
    return;
  }

  button.disabled = true;
  try {
    const previous = await getEntry(todayKey());
    const review = readForm(previous);
    const { items } = getPlan(await getEntries(), todayKey());
    if (items.some((i) => needsAnswer(i, todayKey()))) {
      setStatus("Answer today's plan first.", true);
      $("confirm-block").scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      return;
    }
    const problem = validate(review);
    if (problem) {
      setStatus(problem.message, true);
      $(problem.focus).focus();
      return;
    }

    await saveEntry(review);
    clearForm();
    hasToday = true;
    editing = false;
      setStatus(
      hasPending()
        ? "Saved on this device. It will sync when you are online."
        : "Saved. Tap the button if you need to edit.",
    );
    syncSubmitLabel();
    await refresh();
  } catch (err) {
    console.error("MindLoop: save failed", err);
    setStatus("Could not save. Check your connection and try again.", true);
  } finally {
    button.disabled = false;
  }
}

/* ---------- Week view ---------- */

function statRow(label, value) {
  const row = document.createElement("div");
  row.className = "stat-row";

  const l = document.createElement("span");
  l.className = "stat-label";
  l.textContent = label;

  const v = document.createElement("span");
  v.className = "stat-value";
  v.textContent = value;

  row.append(l, v);
  return row;
}

const ratio = (part, whole, rate) =>
  rate === null ? "No data yet" : `${part}/${whole} (${rate}%)`;

async function renderWeek() {
  const entries = await getEntries();
  const s = weekStats(entries, currentWeek, new Date());

  $("week-title").textContent = `Week ${s.number}`;
  $("week-range").textContent = s.range;
  $("week-prev").disabled = !canGoPrev(entries, currentWeek);
  $("week-next").disabled = !canGoNext(currentWeek, todayKey());

  $("week-days").replaceChildren(
    ...s.days.map((d) => {
      const cell = document.createElement("div");
      cell.className = "day-cell";
      cell.classList.toggle("is-filled", d.filled);
      cell.classList.toggle("is-today", d.isToday);
      cell.classList.toggle("is-future", d.isFuture);
      cell.textContent = d.weekday.slice(0, 3);
      return cell;
    }),
  );

  const worst = worstWeekday(entries);
  const planned = s.days.reduce((t, d) => t + d.planned, 0);
  const doneText =
    s.due > 0
      ? ratio(s.done, s.due, s.doneRate)
      : planned === 0
        ? "No plan yet"
        : `${planned} planned, none due yet`;
  $("week-stats").replaceChildren(
    statRow("Days filled", `${s.daysFilled}/7`),
    statRow("Priorities done", doneText),
    statRow("Started on time", ratio(s.onTime, s.due, s.onTimeRate)),
    statRow(
      "Avg start delay",
      s.avgLateMinutes === null ? "No data yet" : `${s.avgLateMinutes} min`,
    ),
    statRow(
      "Top blocker",
      s.topReason
        ? `${s.topReason.label} (${s.topReason.count}x)`
        : "None logged",
    ),
    statRow("Hardest weekday", worst ? worst.day : "Not enough data"),
  );

  renderReasonChart(s);
  renderDayChart(s);
}

function renderSyncStatus() {
  const el = $("sync-status");
  if (!navigator.onLine) {
    el.textContent = "Offline. Changes are saved on this device and will sync when you are back online.";
    el.hidden = false;
  } else if (hasPending()) {
    el.textContent = "Syncing your changes...";
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}
function renderReasonChart(s) {
  const box = $("reason-chart");
  const data = reasonChartData(s);
  if (data.length === 0) {
    box.textContent = "No blockers logged this week.";
    return;
  }
  box.replaceChildren(
    ...data.map((r) => {
      const row = document.createElement("div");
      row.className = "bar-row";
      row.innerHTML = `<span class="bar-label"></span>
      <div class="bar-track"><div class="bar-fill"></div></div>
      <span class="bar-count"></span>`;
      row.querySelector(".bar-label").textContent = r.label;
      row.querySelector(".bar-fill").style.width = `${r.widthPct}%`;
      row.querySelector(".bar-count").textContent = r.count;
      return row;
    }),
  );
}

function renderDayChart(s) {
  $("day-chart").replaceChildren(
    ...dayChartData(s).map((d) => {
      const col = document.createElement("div");
      col.className = "col";
      col.classList.toggle("is-future", d.isFuture);
      col.innerHTML = `<div class="col-track"><div class="col-fill"></div></div>
      <span class="col-label"></span><span class="col-count"></span>`;
      col.querySelector(".col-fill").style.height = `${d.heightPct}%`;
      col.querySelector(".col-label").textContent = d.weekday;
      col.querySelector(".col-count").textContent = d.isFuture
        ? ""
        : `${d.done}/${d.due}`;
      return col;
    }),
  );
}

function initWeekNav() {
  $("week-prev").addEventListener("click", () => {
    currentWeek = shiftWeek(currentWeek, -1);
    renderWeek();
  });
  $("week-next").addEventListener("click", () => {
    currentWeek = shiftWeek(currentWeek, 1);
    renderWeek();
  });
}

/* ---------- Copy summary ---------- */

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for non-secure contexts (e.g. file:// or plain http on phone)
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("copy failed");
}

async function onCopySummary() {
  const status = $("copy-status");
  try {
    const entries = await getEntries();
    await copyText(buildWeekSummary(entries, currentWeek, new Date()));
    status.textContent = "Copied. Paste it to Claude.";
  } catch (err) {
    console.error("MindLoop: copy failed", err);
    status.textContent = "Copy failed.";
  }
}
/* ---------- Your data ---------- */

async function onExport() {
  const blob = new Blob([await exportAll()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mindloop-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  $("data-status").textContent = "Exported.";
}

let deleteArmed = false;
async function onDeleteData() {
  const btn = $("delete-data");
  if (!deleteArmed) {
    deleteArmed = true;
    btn.textContent = "Tap again to delete everything";
    setTimeout(() => {
      deleteArmed = false;
      btn.textContent = "Delete all data";
    }, 4000);
    return;
  }
    try {
    await clearAll();
  } catch (err) {
    deleteArmed = false;
    btn.textContent = "Delete all data";
    $("data-status").textContent = err.message;
    return;
  }
  deleteArmed = false;
  btn.textContent = "Delete all data";
  hasToday = false;
  editing = false;
  confirming.clear();
  clearForm();
  syncSubmitLabel();
  $("data-status").textContent = "All data deleted.";
  await refresh();
}
/* ---------- Init ---------- */

onViewShow.week = () => {
  currentWeek = mondayOf(todayKey());
  renderWeek();
};
function showAppError(message) {
  const el = $("app-error");
  el.textContent = message;
  el.hidden = false;
}

window.addEventListener("unhandledrejection", (e) => {
  console.error("MindLoop:", e.reason);
  showAppError("Something went wrong. Refresh the page.");
});
window.addEventListener("error", (e) => {
  console.error("MindLoop:", e.error);
  showAppError("Something went wrong. Refresh the page.");
});

function showWelcome() {
  $("app").hidden = true;
  $("welcome").hidden = false;
  $("google-signin").addEventListener("click", async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error("MindLoop: sign-in failed", err);
      showAppError("Could not start Google sign-in. Try again.");
    }
  });
}

async function init() {
  const session = await getSession();
  const offlineUser = !session && !navigator.onLine && cachedUserId();
  if (!session && !offlineUser) {
    showWelcome();
    return;
  }
  $("welcome").hidden = true;
  $("app").hidden = false;

  initTabs();
  initWeekNav();
  $("review-form").addEventListener("submit", onSubmit);
  $("copy-summary").addEventListener("click", onCopySummary);
  $("export-data").addEventListener("click", onExport);
  $("delete-data").addEventListener("click", onDeleteData);
  $("sign-out").addEventListener("click", async () => {
    if (!(await prepareSignOut())) {
      showAppError("Some changes have not synced yet. Connect to the internet, then sign out.");
      return;
    }
    await signOut();
    location.reload();
  });
  hasToday = (await getEntry(todayKey())) !== null;
  syncSubmitLabel();
  await refresh();
}
document.addEventListener("visibilitychange", async () => {
  if (document.hidden|| $("app").hidden) return;
  hasToday = (await getEntry(todayKey())) !== null;
  editing = false;
  syncSubmitLabel();
  await refresh();
});

init();
window.addEventListener("online", async () => {
  try {
    await syncNow();
  } catch (err) {
    console.error("MindLoop: sync failed", err);
  }
  if (!$("app").hidden) await refresh();
  renderSyncStatus();
});
window.addEventListener("offline", renderSyncStatus);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => {
    console.error("MindLoop: service worker failed", err);
  });
}
