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
  getEntriesLocal,
  clearPriorityStamp,
  reschedulePriority,
  setPriorityData,
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
  plannedMinutes,
  addMinutesToTime,
  energyPlan,
  validateReview,
  isDeleteConfirmed,
  getCardPlan,
} from "./logic.js";
import {
  getSession,
  signInWithGoogle,
  signOut,
  cachedUserId,
  getUserDisplay,
} from "./auth.js";
import { deleteAccount } from "./account.js";
import {
  getInsight,
  requestInsight,
  clearInsightCache,
  InsightError,
  deleteInsight,
} from "./insights.js";
import { askNotificationPermission } from "./notify.js";
import { askNote, askReason, askStartTime } from "./timesheet.js";

let currentWeek = mondayOf(toDateKey(new Date()));
let editing = false; // true = fomu ina review ya leo, inaeditiwa
let reviewLocked = false; // siku mpya + priorities za leo hazijaisha
const LOCK_MSG =
  "Finish all 3 of today's priorities (Done or Not done) to unlock tonight's review.";
let hasToday = false; // review ya leo imeshasaviwa

function clearForm() {
  $("review-form").reset();
  syncAllTimeBlocks();
}
// Saved tonight and not editing: hide priority inputs, show the shield.
function syncPriorityMode() {
  // Priorities zinaandikwa tu kabla ya kusave. Baada ya hapo hazionekani, hata ukiedit.
  document
    .querySelectorAll(
      "#review-fields .priority-row, #review-fields .priority-head",
    )
    .forEach((el) => {
      el.style.display = hasToday ? "none" : "";
    });
  $("lock-shield").hidden = !hasToday || editing;

  // Card nzima inalock hadi priorities za leo ziishe
  $("review-fields").disabled = reviewLocked;
  $("review-form").querySelector("button[type='submit']").hidden =
    reviewLocked;

  const status = $("form-status");
  if (reviewLocked) {
    setStatus(LOCK_MSG);
  } else if (status.textContent === LOCK_MSG) {
    setStatus("");
  }
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

// Start and finish are one time block: the person picks two clock times and
// the length is worked out from them, so there is no separate minutes field.
function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m} min`;
}

function syncTimeBlock(n) {
  const label = $(`dur${n}`);
  if (!label) return;
  const minutes = plannedMinutes($(`t${n}`)?.value, $(`e${n}`)?.value);
  label.textContent = minutes ? formatDuration(minutes) : "";
  label.title = minutes ? `${minutes} minutes` : "";
}

function syncAllTimeBlocks() {
  for (const n of [1, 2, 3]) syncTimeBlock(n);
}

function initPriorityTimes() {
  for (const n of [1, 2, 3]) {
    $(`t${n}`)?.addEventListener("input", () => syncTimeBlock(n));
    $(`e${n}`)?.addEventListener("input", () => syncTimeBlock(n));
  }
}

/* ---------- Spec §8: plan for the energy you expect ---------- */

// Advice only: the person still writes every priority, and nothing is hidden
// or blocked if they plan more than the suggestion.
let energyLevel = "normal";

function paintEnergy() {
  document.querySelectorAll(".energy-btn").forEach((btn) => {
    const on = btn.dataset.energy === energyLevel;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
  const hint = $("energy-hint");
  if (hint) hint.textContent = energyPlan(energyLevel).message;
}

function initEnergy() {
  document.querySelectorAll(".energy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      energyLevel = btn.dataset.energy || "normal";
      paintEnergy();
    });
  });
  paintEnergy();
}

initEnergy();

// Part 2 fills this: onViewShow.week = renderWeek
const onViewShow = {};

/* ---------- Tabs ---------- */

function showView(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.view === name;
    tab.classList.toggle("is-active", active);
    // Screen readers hear which section the person is on, not just its look.
    tab.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.hidden = view.id !== `view-${name}`;
  });
  window.scrollTo({ top: 0, left: 0 });
  if (onViewShow[name]) onViewShow[name]();
}

function initTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  });
  // Keyboard: the tab bar is one stop, then the arrows move between views.
  tabs.forEach((tab, index) => {
    tab.addEventListener("keydown", (event) => {
      const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      tabs[next].focus();
      showView(tabs[next].dataset.view);
    });
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
  postponed: "Postponed",
};

// "Nimeanza — Start" becomes "Nimeanza" under the icon on a phone; the full
// wording still lives in .btn-label, aria-label and data-tip.
function captionFor(label) {
  return label.split("—")[0].split("(")[0].trim() || label;
}

function planButton(iconId, label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "plan-btn";
  btn.setAttribute("aria-label", label);
  // Three actions per row. On phones the icon gets a short caption under it,
  // and data-tip still shows the full words on hover/focus.
  btn.dataset.tip = label;
  btn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${iconId}"/></svg><span class="btn-label">${label}</span><span class="btn-caption">${captionFor(label)}</span>`;
  btn.addEventListener("click", onClick);
  return btn;
}
function completionMessage() {
  const li = document.createElement("li");
  li.className = "plan-complete";
  li.textContent = "All three priorities done. Well done today. 🎉";
  return li;
}

// Spec §4: change or remove a priority's start time, keeping its history.
async function onChangeTime(sourceDate, index, item) {
  const time = await askStartTime({
    title: "Change start time",
    text: item.text,
    time: item.time || "",
  });
  if (time === null) return; // cancelled
  reschedulePriority(sourceDate, index, time)
    .then(() => refresh())
    .catch((err) => {
      console.error("MindLoop: reschedule failed", err);
      showAppError("Could not change the time. Check your connection and try again.");
    });
}

// Spec §4: moving a task asks for a reason, once. The reason is a plan note,
// never a judgement, and "prefer not to say" is a real answer.
const POSTPONE_REASONS = [
  { id: "too-big", label: "Task felt too big" },
  { id: "no-time", label: "No time left today" },
  { id: "energy", label: "Low energy" },
  { id: "something", label: "Something came up" },
  { id: "private", label: "Prefer not to say" },
];
const POSTPONE_REASON_LABEL = Object.fromEntries(
  POSTPONE_REASONS.map((reason) => [reason.id, reason.label]),
);

async function onPostpone(sourceDate, index, item) {
  const reason = await askReason({
    title: "Moving this to another day",
    text: item.text,
    options: POSTPONE_REASONS,
  });
  if (reason === null) return; // cancelled: nothing recorded
  try {
    await markPriority(sourceDate, index, "postponedAt");
    if (reason) await setPriorityData(sourceDate, index, { postponeReason: reason });
  } catch (err) {
    console.error("MindLoop: postpone failed", err);
    showAppError("Could not save that. Check your connection and try again.");
  }
  await refresh();
}

// Done is followed by one optional note, so tomorrow-you knows how it went.
// Closing the note sheet records nothing: the answer is still the person's.
async function confirmDone(sourceDate, index, item) {
  const written = await askNote({
    title: "Done. Anything to remember?",
    text: item.text,
  });
  if (written === null) return;
  confirming.delete(index);
  try {
    await markPriority(sourceDate, index, "doneAt");
    if (written) await setPriorityData(sourceDate, index, { note: written });
  } catch (err) {
    console.error("MindLoop: mark done failed", err);
    showAppError("Could not save that. Check your connection and try again.");
  }
  await refresh();
}

function onUndoPostpone(sourceDate, index) {
  clearPriorityStamp(sourceDate, index, "postponedAt")
    .then(() => setPriorityData(sourceDate, index, { postponeReason: null }))
    .then(() => refresh())
    .catch((err) => {
      console.error("MindLoop: undo postpone failed", err);
      showAppError("Could not undo the postpone. Check your connection and try again.");
    });
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
  const block = item.time
    ? item.endTime
      ? `${item.time} – ${item.endTime}`
      : item.time
    : "No time";
  const duration = item.duration ? ` · ${formatDuration(item.duration)}` : "";
  meta.textContent = `${block}${duration} · ${STATUS_TEXT[status]}`;

  // Spec §4: the line written last night that says when this is really done.
  const definition = document.createElement("p");
  definition.className = "plan-def";
  if (item.definition) definition.textContent = `Done means: ${item.definition}`;

  const note = document.createElement("p");
  note.className = "confirm-msg";

  // Two tidy rows of three: the answer first, then the quieter plan moves.
  const actions = document.createElement("div");
  actions.className = "plan-actions";
  const secondary = document.createElement("div");
  secondary.className = "plan-secondary";

  const isPreview = planDate > todayKey(); // tomorrow's plan: nothing to mark yet
  if (!isPreview) {
    if (item.doneAt) {
      note.textContent = item.note
        ? `${HONESTY.yes} “${item.note}”`
        : HONESTY.yes;
    } else if (item.skippedAt) {
      note.textContent = HONESTY.no;
    } else if (item.postponedAt) {
      const reason = POSTPONE_REASON_LABEL[item.postponeReason];
      note.textContent = `Moved to another day${
        reason ? ` (${reason.toLowerCase()})` : ""
      }. No pressure — you can undo this if today changes.`;
      secondary.append(
        planButton("i-left", "Undo postpone", () =>
          onUndoPostpone(sourceDate, item.index),
        ),
      );
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
            confirmDone(sourceDate, item.index, item),
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
      secondary.append(
        planButton("i-clock", "Change time", () =>
          onChangeTime(sourceDate, item.index, item),
        ),
        planButton("i-right", "Postpone", () =>
          onPostpone(sourceDate, item.index, item),
        ),
      );
    }
  }

  li.append(text, meta, definition, note, actions, secondary);
  return li;
}

function renderPriorityCard(entries) {
  const { sourceDate, planDate, items } = getCardPlan(
    entries,
    todayKey(),
    hasToday && !editing,
  );
  const isPreview = planDate > todayKey();
  // A day is answered when every item has a final answer: done, not done,
  // or postponed (a real move of the task, not a failure).
  const allAnswered =
    !isPreview &&
    items.length > 0 &&
    items.every((i) => i.doneAt || i.skippedAt || i.postponedAt);
  const allDone =
    !isPreview &&
    items.length > 0 &&
    items.every((i) => i.doneAt || i.skippedAt);
  reviewLocked = !hasToday && !isPreview && items.length > 0 && !allAnswered;
  $("priority-title").textContent = isPreview
    ? "Tomorrow's priorities"
    : "Today's priorities";

  $("lock-countdown").hidden = !isPreview;
  if (isPreview) {
    startCountdown();
  } else {
    stopCountdown();
  }

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
  if (!$("view-week").hidden) await renderWeek(entries);
  renderSyncStatus();
  renderDayInsight();
}

// If the text is unchanged, keep the previous done value.
function readForm(previous) {
  const old = (previous && previous.priorities) || [];
  const priorities = [1, 2, 3].map((n, i) => {
    const text = $(`p${n}`).value.trim();
    const time = text ? $(`t${n}`).value : ""; // saa bila maandishi inapuuzwa
    const endTime = text ? $(`e${n}`).value : "";
    // The length is derived from the two clock times; it is stored so the
    // stats and AI still see an estimate, but nobody types minutes.
    const duration = plannedMinutes(time, endTime);
    const definition = text ? ($(`d${n}`)?.value || "").trim() : "";
    const same = old[i] && old[i].text === text;
    return {
      text,
      definition,
      time,
      endTime: endTime || null,
      duration,
      startedAt: same ? old[i].startedAt || null : null,
      doneAt: same ? old[i].doneAt || null : null,
      skippedAt: same ? old[i].skippedAt || null : null,
      postponedAt: same ? old[i].postponedAt || null : null,
      // Written while the plan was already running: keep them when the text
      // of the task has not changed.
      note: same ? old[i].note || null : null,
      postponeReason: same ? old[i].postponeReason || null : null,
      rescheduled: same ? old[i].rescheduled || [] : [],
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
    if ($(`d${i + 1}`)) $(`d${i + 1}`).value = p.definition || "";
    $(`t${i + 1}`).value = p.time || "";
    // Older plans only stored a start time and a length: rebuild the finish.
    $(`e${i + 1}`).value =
      p.endTime || addMinutesToTime(p.time, p.duration) || "";
  });
  syncAllTimeBlocks();
}

async function onSubmit(event) {
  event.preventDefault();
  if (reviewLocked) return;
  const button = event.target.querySelector("button[type='submit']");

  if (hasToday && !editing) {
    fillForm(await getEntry(todayKey()));
    editing = true;
    setStatus("Editing today's review. Priorities stay locked until tomorrow.");
    syncSubmitLabel();
    syncPriorityMode();
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

async function renderWeek(entries = null) {
  entries ??= getEntriesLocal();
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
    statRow("Postponed", s.postponed > 0 ? String(s.postponed) : "None"),
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
      syncedUntil = Date.now() + 6000;
      setTimeout(renderSyncStatus, 6100);
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
/* ---------- Onboarding tour ---------- */

const TOUR_STEPS = [
  {
    view: "today",
    target: "streak-label",
    title: "Your streak",
    text: "Every night you complete a review, your streak grows. Miss a night and it resets — a gentle nudge to keep showing up.",
  },
  {
    view: "today",
    target: "review-form",
    title: "Tonight's review",
    text: "Each night, note your wins and challenges, then plan tomorrow's three priorities with a start and finish time. After you save, priorities lock until tomorrow. You can still edit your review.",
  },
  {
    view: "today",
    target: "priority-review",
    title: "Tomorrow's plan",
    text: "After saving, tomorrow's plan waits here with a countdown. When the new day starts, the review resets and stays locked until you mark all 3 priorities Done or Not done. Be honest, it's only for you.",
  },
  {
    view: "today",
    target: "tabbar",
    title: "Swipe between tabs",
    text: "Tap a tab, or swipe left and right anywhere on the page. The bar stays at the bottom, so Today, Week, Progress and Account are always within reach.",
  },
  {
    view: "week",
    target: "week-stats",
    title: "Your Week",
    text: "See priorities done, on-time starts, your top blocker, and your hardest weekday — all calculated from your reviews.",
  },
  {
    view: "week",
    target: "week-insight",
    title: "AI insights",
    text: "Tap for an AI-written insight on your week, based only on your own reviews. You get one per period, so make it count.",
  },
  {
    view: "account",
    target: "account-card",
    title: "Your Account",
    text: "Manage your data here — delete it, close your account, or reach us on WhatsApp, all in one place.",
  },
  {
    view: "account",
    target: "tour-help",
    title: "Need this again?",
    text: "Tap this button anytime to replay the tour.",
  },
];

let tourIndex = 0;

function tourKey() {
  const uid = cachedUserId();
  return uid ? `mindloop:tour:${uid}` : null;
}

function hasTourSeen() {
  const key = tourKey();
  return !key || localStorage.getItem(key) === "1";
}

function markTourSeen() {
  const key = tourKey();
  if (key) localStorage.setItem(key, "1");
}

const isVisible = (el) =>
  !!el &&
  (el.offsetParent !== null || getComputedStyle(el).position === "fixed");

function endTour() {
  const tip = $("tour-tooltip");
  tip.hidden = true;
  tip.style.top = "";
  tip.style.bottom = "";
  tourTargetEl = null;
  document
    .querySelectorAll(".tour-target")
    .forEach((el) => el.classList.remove("tour-target"));
  markTourSeen();
  // The tour has just been finished (or skipped) with a tap, which is the
  // moment big apps ask for notifications. Asked once in total.
  askNotificationPermission();
}

let tourTargetEl = null;
let tourPlacePending = false;

const tourTooltip = () => $("tour-tooltip");

// The bubble sits next to the highlighted part: under it when there is room,
// above it otherwise, always inside the screen. Pinned to the bottom, the old
// bubble could cover the very thing the step was explaining.
function placeTourTooltip() {
  const tip = tourTooltip();
  if (!tip || tip.hidden || !tourTargetEl) return;
  const gap = 14;
  const margin = 12;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const rect = tourTargetEl.getBoundingClientRect();
  const height = tip.offsetHeight;
  const below = vh - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  let top;
  if (below >= height) top = rect.bottom + gap;
  else if (above >= height) top = rect.top - gap - height;
  else top = below >= above ? vh - height - margin : margin;
  top = Math.min(Math.max(top, margin), Math.max(margin, vh - height - margin));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.bottom = "auto";
}

function schedulePlacement() {
  if (tourPlacePending) return;
  tourPlacePending = true;
  requestAnimationFrame(() => {
    tourPlacePending = false;
    placeTourTooltip();
  });
}

window.addEventListener("scroll", schedulePlacement, {
  passive: true,
  capture: true,
});
window.addEventListener("resize", schedulePlacement);

function setTourProgress(index) {
  const tip = tourTooltip();
  if (!tip) return;
  let progress = tip.querySelector(".tour-progress");
  if (!progress) {
    progress = document.createElement("p");
    progress.className = "tour-progress";
    tip.insertBefore(progress, tip.firstChild);
  }
  progress.textContent = `Step ${index + 1} of ${TOUR_STEPS.length}`;
}

function showTourStep(index) {
  if (index >= TOUR_STEPS.length) {
    endTour();
    return;
  }
  const step = TOUR_STEPS[index];
  showView(step.view);

  requestAnimationFrame(() => {
    const target = $(step.target);
    if (!isVisible(target)) {
      showTourStep(index + 1);
      return;
    }
    document
      .querySelectorAll(".tour-target")
      .forEach((el) => el.classList.remove("tour-target"));
    target.classList.add("tour-target");
    tourTargetEl = target;
    if (getComputedStyle(target).position !== "fixed") {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    tourIndex = index;
    $("tour-title").textContent = step.title;
    $("tour-text").textContent = step.text;
    setTourProgress(index);
    $("tour-next").textContent =
      index === TOUR_STEPS.length - 1 ? "Got it" : "Next";
    const tip = tourTooltip();
    tip.hidden = false;
    placeTourTooltip();
    // The scroll may still be animating; place again once it settles.
    schedulePlacement();
    window.setTimeout(placeTourTooltip, 380);
  });
}

function startTour() {
  showTourStep(0);
}

function initTour() {
  $("tour-help")?.addEventListener("click", startTour);

  $("tour-skip")?.addEventListener("click", endTour);
  $("tour-next")?.addEventListener("click", () => {
    if (tourIndex === TOUR_STEPS.length - 1) endTour();
    else showTourStep(tourIndex + 1);
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

function renderUserChip(session) {
  const info = getUserDisplay(session);
  if (!info) return;
  $("user-avatar").src = info.avatar || "icons/icon-192.png";
  $("user-name").textContent = info.name;
  $("user-email").textContent = info.email;
  $("user-chip").hidden = false;
}

function initUserMenu() {
  $("user-chip")?.addEventListener("click", () => {
    $("user-menu").hidden = !$("user-menu").hidden;
  });
  document.addEventListener("click", (e) => {
    if (
      !$("user-menu").hidden &&
      !$("user-menu").contains(e.target) &&
      !$("user-chip").contains(e.target)
    ) {
      $("user-menu").hidden = true;
    }
  });
}

async function handleSignOut() {
  if (!(await prepareSignOut())) {
    showAppError(
      "Some changes have not synced yet. Connect to the internet, then sign out.",
    );
    return;
  }
  await signOut();
  location.reload();
}
function hideSplash() {
  const splash = $("splash");
  if (!splash) return;
  splash.classList.add("is-hiding");
  setTimeout(() => {
    splash.hidden = true;
  }, 1000);
}
function showWelcome() {
  $("app").hidden = true;
  $("welcome").hidden = false;
  $("google-signin").addEventListener("click", async () => {
    try {
      await signInWithGoogle();
      // Page now leaves for Google; on success the browser returns here
      // with a session already set, and init() picks it up on reload.
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
  const splashStart = Date.now();
  const session = await getSession();
  const offlineUser = !session && !navigator.onLine && cachedUserId();

  // Show the logo for at least this long, even on a fast connection.
  const MIN_SPLASH_MS = 1200;
  const elapsed = Date.now() - splashStart;
  if (elapsed < MIN_SPLASH_MS) {
    await new Promise((r) => setTimeout(r, MIN_SPLASH_MS - elapsed));
  }
  hideSplash();

  if (!session && !offlineUser) {
    showWelcome();
    return;
  }
  $("welcome").hidden = true;
  $("app").hidden = false;
  renderUserChip(session);
  initUserMenu();

  initTabs();
  initTour();
  initWeekNav();
  initPriorityTimes();

  // Use optional chaining (?.) to safely call addEventListener only if the element exists
  $("review-form")?.addEventListener("submit", onSubmit);
  $("lock-shield")?.addEventListener("click", () =>
    setStatus(
      editing
        ? "Priorities are locked until tomorrow."
        : "Click the button to edit.",
    ),
  );
  $("copy-summary")?.addEventListener("click", onCopySummary);
  $("delete-data")?.addEventListener("click", onDeleteData);

  initAccountDelete();

  $("sign-out-btn")?.addEventListener("click", handleSignOut);
  syncSubmitLabel();
  requestAnimationFrame(() => {
    setTimeout(async () => {
      try {
        const entries = await getEntries();
        hasToday = entries.some((entry) => entry.date === todayKey());
        fillForm(entries.find((entry) => entry.date === todayKey()));
        syncSubmitLabel();
        await refresh(entries);
        if (!hasTourSeen()) startTour();
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
  if (!$("app").hidden) {
    try {
      const entries = await getEntries();
      await refresh(entries);
    } catch (err) {
      console.error("MindLoop: refresh after online failed", err);
    }
  }
  renderSyncStatus();
});
window.addEventListener("offline", renderSyncStatus);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => {
    console.error("MindLoop: service worker failed", err);
  });
}
let countdownTimer = null;
let countdownEnd = 0;

async function tickCountdown() {
  const el = $("lock-countdown");
  const diff = countdownEnd - Date.now();

  if (diff <= 0) {
    stopCountdown();
    const wasSaved = hasToday;
    hasToday = (await getEntry(todayKey())) !== null;
    if (wasSaved && !hasToday) {
      editing = false;
      confirming.clear();
      clearForm(); // data za jana zinafutwa, form inaanza upya
    }
    syncSubmitLabel();
    await refresh(); // inalock card kwa sababu priorities za leo bado
    return;
  }
  el.textContent = formatCountdown(diff);
}

function startCountdown() {
  stopCountdown();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  countdownEnd = midnight.getTime(); // inahesabiwa MARA MOJA
  tickCountdown();
  countdownTimer = setInterval(tickCountdown, 1000);
}

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `Unlocks in ${h}h ${m}m ${s}s`;
}


function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}
