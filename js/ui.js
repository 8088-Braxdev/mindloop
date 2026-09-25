// js/ui.js  (part 1 of 2)
// DOM only. Numbers come from logic.js, data from storage.js.

import {
  getEntries,
  getEntry,
  saveEntry,
  markPriority,
  clearAll,
  syncNow,
  hasPending,
  prepareSignOut,
} from "./storage.js";
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
  weekFacts,
  dayFacts,
  addDays,
  validateReview,
  isDeleteConfirmed,
  getCardPlan,
} from "./logic.js";
import { getSession, signInWithGoogle, signOut, cachedUserId } from "./auth.js";
import { deleteAccount } from "./account.js";
import {
  getInsight,
  requestInsight,
  clearInsightCache,
  InsightError,
  deleteInsight,
} from "./insights.js";

let currentWeek = mondayOf(toDateKey(new Date()));
let editing = false; // true = fomu ina review ya leo, inaeditiwa
let hasToday = false; // review ya leo imeshasaviwa

function clearForm() {
  $("review-form").reset();
}
// Saved tonight and not editing: hide priority inputs, show the shield.
function syncPriorityMode() {
  const locked = hasToday && !editing;
  document
    .querySelectorAll(
      "#review-fields .priority-row, #review-fields .priority-head",
    )
    .forEach((el) => {
      el.style.display = locked ? "none" : "";
    });
  $("lock-shield").hidden = !locked;
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
function completionMessage() {
  const li = document.createElement("li");
  li.className = "plan-complete";
  li.textContent = "All three priorities done. Well done today. 🎉";
  return li;
}
function buildPlanItem(item, sourceDate, planDate) {
  const status = priorityStatus(item, planDate, new Date());

  const li = document.createElement("li");
  li.className = `plan-item is-${status}`;

  const text = document.createElement("p");
  text.className = "plan-text";
  text.textContent = item.text;

  const meta = document.createElement("p");
  meta.className = "plan-meta";
  meta.textContent = `${item.time || "No time"} · ${STATUS_TEXT[status]}`;

  const note = document.createElement("p");
  note.className = "confirm-msg";

  const actions = document.createElement("div");
  actions.className = "plan-actions";

  const isPreview = planDate > todayKey(); // tomorrow's plan: nothing to mark yet
  if (!isPreview) {
    if (item.doneAt) {
      note.textContent = HONESTY.yes;
    } else if (item.skippedAt) {
      note.textContent = HONESTY.no;
    } else {
      if (!item.startedAt) {
        actions.append(
          planButton("i-play", "Start", () =>
            onMark(sourceDate, item.index, "startedAt"),
          ),
        );
      }
      if (confirming.has(item.index)) {
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
        actions.append(
          planButton("i-check", "Mark done", async () => {
            confirming.add(item.index);
            renderPriorityCard(await getEntries());
          }),
          planButton("i-x", "Not done", () =>
            answer(sourceDate, item.index, "skippedAt"),
          ),
        );
      }
    }
  }

  li.append(text, meta, note, actions);
  return li;
}

function renderPriorityCard(entries) {
  const { sourceDate, planDate, items } = getCardPlan(
    entries,
    todayKey(),
    hasToday && !editing,
  );
  const isPreview = planDate > todayKey();
  const allDone =
    !isPreview && items.length > 0 && items.every((i) => i.doneAt || i.skippedAt);

  $("priority-title").textContent = isPreview
    ? "Tomorrow's priorities"
    : "Today's priorities";

  const hint = $("priority-hint");
  hint.textContent = "Locked until tomorrow. Fill it in carefully — it can't be edited once tonight's review is saved.";
  hint.hidden = !isPreview;

  if (allDone) {
    $("priority-list").replaceChildren(completionMessage());
  } else {
    $("priority-list").replaceChildren(
      ...items.map((i) => buildPlanItem(i, sourceDate, planDate)),
    );
  }
  $("priority-review").hidden = items.length === 0 || editing;
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

/* ---------- AI insights ---------- */

const RETRY_COOLDOWN_MS = 8000;
// Errors where trying again cannot help: hide the button.
const FINAL_ERRORS = new Set([
  "user_limit",
  "already_generated",
  "at_capacity",
  "no_data",
  "too_early",
]);

const textEl = (tag, text) => {
  const el = document.createElement(tag);
  el.textContent = text; // AI text is never inserted as HTML
  return el;
};

function insightBlock(label, content) {
  const box = document.createElement("div");
  box.className = "insight-block";
  box.append(textEl("h3", label), content);
  return box;
}

function fillInsight(body, insight, createdAt) {
  const well = document.createElement("ul");
  (insight.went_well || []).forEach((t) => well.append(textEl("li", t)));

  const headline = textEl("p", insight.headline);
  headline.className = "insight-headline";
  const parts = [
    headline,
    insightBlock("What went well", well),
    insightBlock("Pattern", textEl("p", insight.pattern)),
    insightBlock("Try next", textEl("p", insight.suggestion)),
  ];
  if (insight.data_note) {
    const note = textEl("p", insight.data_note);
    note.className = "insight-note";
    parts.push(note);
  }
  if (createdAt) {
    const when = new Date(createdAt).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });
    const foot = textEl("p", `Written ${when}`);
    foot.className = "hint";
    parts.push(foot);
  }
  body.replaceChildren(...parts);
}
// "Delete this insight" with tap-again confirmation. Deleting does not give
// the period another try: the server usage log remembers it.
function addDeleteButton(card, opts) {
  const body = card.querySelector(".insight-body");
  const status = card.querySelector(".insight-status");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "plan-btn insight-delete";
  btn.textContent = "Delete this insight";

  let armed = false;
  const reset = () => {
    armed = false;
    btn.textContent = "Delete this insight";
    status.textContent = "";
  };

  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = "Tap again to confirm";
      status.textContent =
        "This cannot be undone, and this period will not get a new insight.";
      setTimeout(reset, 4000);
      return;
    }
    btn.disabled = true;
    try {
      await deleteInsight(opts.type, opts.key);
      card.dataset.state = "deleted";
      body.replaceChildren(textEl("p", "Insight deleted."));
      status.textContent = "";
    } catch (err) {
      console.error("MindLoop: delete insight failed", err);
      btn.disabled = false;
      reset();
      status.textContent =
        err.message || "Could not delete the insight. Try again.";
    }
  });
  body.append(btn);
}
// Shows a saved insight, or a button to ask for one. opts: { type, key, available, hint, facts }
async function showInsight(card, opts) {
  const token = `${opts.type}:${opts.key}`;
  // Already showing this period's insight (or waiting for it): leave it alone.
  if (
    card.dataset.showing === token &&
    ["found", "busy", "deleted"].includes(card.dataset.state)
  )
    return;

  const body = card.querySelector(".insight-body");
  const btn = card.querySelector(".insight-btn");
  const status = card.querySelector(".insight-status");
  card.dataset.showing = token;
  card.dataset.state = "";
  card.hidden = false;
  body.replaceChildren();
  status.textContent = "";
  btn.hidden = true;

  let found = null;
  try {
    found = await getInsight(opts.type, opts.key);
  } catch (err) {
    console.error("MindLoop: could not read insight", err);
  }
  if (card.dataset.showing !== token) return;

  if (found) {
    fillInsight(body, found.insight, found.createdAt);
    card.dataset.state = "found";
    addDeleteButton(card, opts);
    return;
  }
  if (!opts.available) {
    status.textContent = opts.hint;
    return;
  }

  btn.hidden = false;
  btn.disabled = false;
  btn.onclick = async () => {
    btn.disabled = true;
    card.dataset.state = "busy";
    status.textContent = "Checking your latest changes...";
    try {
      await syncNow().catch(() => {});
      if (hasPending()) {
        throw new InsightError(
          "syncing",
          "Your latest changes are still syncing. Try again in a moment.",
        );
      }
      status.textContent =
        "Writing your insight. This can take a few seconds...";
      const result = await requestInsight(
        opts.type,
        opts.key,
        await opts.facts(),
      );
      if (card.dataset.showing !== token) return;
      fillInsight(body, result.insight, result.createdAt);
      addDeleteButton(card, opts);
      card.dataset.state = "found";
      btn.hidden = true;
      status.textContent = "";
    } catch (err) {
      console.error("MindLoop: insight failed", err);
      if (card.dataset.showing !== token) return;
      card.dataset.state = "";
      status.textContent =
        err.message || "Something went wrong. Try again in a moment.";
      if (FINAL_ERRORS.has(err.code)) {
        btn.hidden = true;
      } else {
        setTimeout(() => {
          btn.disabled = false;
        }, RETRY_COOLDOWN_MS);
      }
    }
  };
}

function renderDayInsight() {
  const card = $("day-insight");
  if (!hasToday) {
    card.hidden = true;
    return;
  }
  showInsight(card, {
    type: "day",
    key: todayKey(),
    available: true,
    facts: async () => dayFacts(await getEntries(), todayKey(), new Date()),
  });
}

// The week's insight opens after Sunday's review (or once the week is over),
// so its one chance per week is not spent on half a week.
function renderWeekInsight(s) {
  const weekOver = s.weekStart < mondayOf(todayKey());
  const sundayDone = todayKey() === addDays(s.weekStart, 6) && hasToday;
  showInsight($("week-insight"), {
    type: "week",
    key: s.weekStart,
    available: s.daysFilled > 0 && (weekOver || sundayDone),
    hint:
      s.daysFilled === 0
        ? "No reviews this week."
        : "Available after Sunday's review.",
    facts: async () => weekFacts(await getEntries(), s.weekStart, new Date()),
  });
}

/* ---------- Refresh + init ---------- */

async function refresh(entries = null) {
  entries ??= await getEntries();
  renderStreak(entries);
  renderPriorityCard(entries);
  syncPriorityMode();
  if (!$("view-week").hidden) await renderWeek();
  renderSyncStatus();
  renderDayInsight();
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

    const problem = validateReview(review);
    if (problem) {
      setStatus(problem.message, true);
      $(problem.focus).focus();
      return;
    }

    await saveEntry(review);
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
  renderWeekInsight(s);
}

let wasPending = hasPending();
let syncedUntil = 0;

function renderSyncStatus() {
  const el = $("sync-status");
  const pending = hasPending();
  if (!navigator.onLine) {
    el.textContent =
      "Offline. Changes are saved on this device and will sync when you are back online.";
    el.hidden = false;
  } else if (pending) {
    el.textContent = "Syncing your changes...";
    el.hidden = false;
  } else {
    if (wasPending) {
      syncedUntil = Date.now() + 4000;
      setTimeout(renderSyncStatus, 4100);
    }
    if (Date.now() < syncedUntil) {
      el.textContent = "Synced. Your changes are saved to your account. ✅";
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
  wasPending = pending;
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
    status.textContent = "Copied to clipboard.";
  } catch (err) {
    console.error("MindLoop: copy failed", err);
    status.textContent = "Copy failed.";
  }
}
/* ---------- Your data ---------- */

let deleteArmed = false;
async function onDeleteData() {
  const btn = $("delete-data");
  if (!deleteArmed) {
    if (Object.keys(await getEntries()).length === 0) {
      $("data-status").textContent = "You have no data to delete.";
      return;
    }
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
  clearInsightCache();
  document.querySelectorAll(".insight-card").forEach((c) => {
    delete c.dataset.showing;
    delete c.dataset.state;
  });
  clearForm();
  syncSubmitLabel();
  currentWeek = mondayOf(todayKey());
  setStatus("");
  $("copy-status").textContent = "";
  $("data-status").textContent = "All data deleted.";
  await refresh();
}
/* ---------- Init ---------- */

onViewShow.week = () => {
  currentWeek = mondayOf(todayKey());
  renderWeek();
};
let errorTimer;
function showAppError(message) {
  const el = $("app-error");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    el.hidden = true;
  }, 6000);
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
function initAccountDelete() {
  const open = $("account-open");
  const panel = $("account-confirm");
  const phrase = $("account-phrase");
  const confirmBtn = $("account-delete");
  const status = $("account-status");

  const say = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  };

  open.addEventListener("click", () => {
    open.hidden = true;
    panel.hidden = false;
    phrase.focus();
  });

  $("account-cancel").addEventListener("click", () => {
    panel.hidden = true;
    open.hidden = false;
    phrase.value = "";
    confirmBtn.disabled = true;
    say("");
  });

  phrase.addEventListener("input", () => {
    confirmBtn.disabled = !isDeleteConfirmed(phrase.value);
  });

  confirmBtn.addEventListener("click", async () => {
    if (!isDeleteConfirmed(phrase.value)) return;
    confirmBtn.disabled = true;
    say("Deleting your account...");
    try {
      await deleteAccount();
      location.reload();
    } catch (err) {
      console.error("MindLoop: account delete failed", err);
      say(err.message || "Could not delete the account. Try again.", true);
      confirmBtn.disabled = !isDeleteConfirmed(phrase.value);
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
  // Locate the line around 866 in ui.js
  const shield = $("lock-shield");
  if (shield) {
    shield.addEventListener("click", () => {
      // your click logic here
    });
  } else {
    console.warn("MindLoop: lock-shield element not found in DOM.");
  }
  // Use optional chaining (?.) to safely call addEventListener only if the element exists
  $("review-form")?.addEventListener("submit", onSubmit);
  $("lock-shield")?.addEventListener("click", () =>
    setStatus("Review saved. Click the button to edit."),
  );
  $("copy-summary")?.addEventListener("click", onCopySummary);
  $("delete-data")?.addEventListener("click", onDeleteData);

  initAccountDelete();

  $("sign-out")?.addEventListener("click", async () => {
    if (!(await prepareSignOut())) {
      showAppError(
        "Some changes have not synced yet. Connect to the internet, then sign out.",
      );
      return;
    }
    await signOut();
    location.reload();
  });
  syncSubmitLabel();
  requestAnimationFrame(() => {
    setTimeout(async () => {
      try {
        const entries = await getEntries();
        hasToday = entries.some((entry) => entry.date === todayKey());
        fillForm(entries.find((entry) => entry.date === todayKey()));
        syncSubmitLabel();
        await refresh(entries);
      } catch (err) {
        console.error("MindLoop: initial data load failed", err);
        showAppError(
          "Could not load your reviews. Check your connection and try again.",
        );
      }
    }, 0);
  });
}
document.addEventListener("visibilitychange", async () => {
  if (document.hidden || $("app").hidden) return;
  const wasSaved = hasToday;
  hasToday = (await getEntry(todayKey())) !== null;
  if (wasSaved && !hasToday) {
    editing = false; // new day: start a fresh form
    clearForm();
  }
  syncSubmitLabel();
  await refresh();
});

init();
window.addEventListener("online", async () => {
  renderSyncStatus();
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
