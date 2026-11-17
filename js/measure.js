// js/measure.js
// Transparent measurement (spec §9–§12): the MindLoop Score, the consistency
// tracker, milestones and the weekly report.
//
// All numbers come from logic.js; this file only builds the Progress view.
// The honesty rules from the spec, followed exactly:
// - Only recorded answers (Start / Done / Not done / Postpone) and written
//   reviews count. Opening the app or receiving a reminder is never an outcome.
// - A new user sees "Still learning your pattern", never a misleading low
//   score.
// - Postponed priorities are not failures; cancelled ones stay in the
//   denominator as an honest answer.
// - Milestones are derived from history, so a broken streak cannot erase one
//   and nothing can be awarded twice.
//
// Loaded by settings.js like reminders.js and rescue.js, so index.html only
// needs the empty #view-progress section.

import { getEntries, getEntriesLocal, syncNow } from "./storage.js";
import {
  addDays,
  canGoNext,
  canGoPrev,
  growthTimeline,
  MILESTONES,
  mindloopScore,
  patternCoach,
  mondayOf,
  shiftWeek,
  streakHistory,
  toDateKey,
  weeklyReport,
  windowStats,
} from "./logic.js";

const todayKey = () => toDateKey(new Date());
let reportWeek = mondayOf(todayKey());

/* ---------- Small helpers ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function statRow(label, value) {
  const row = el("div", "stat-row");
  row.append(el("span", "stat-label", label), el("span", "stat-value", value));
  return row;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const rateText = (part, whole, rate) =>
  rate === null ? "No data yet" : `${part} of ${whole} (${rate}%)`;

const fmtDay = (key) =>
  new Date(`${key}T00:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });

const dateRange = (w) => `${fmtDay(w.start)} to ${fmtDay(w.end)}`;

/* ---------- Score card ---------- */

function buildHow() {
  const list = el("ul");
  for (const [label, weight] of [
    ["Priorities completed", "40%"],
    ["Priorities begun", "25%"],
    ["Follow-through days", "20%"],
    ["Days reviewed", "15%"],
  ]) {
    list.append(el("li", null, `${label}: ${weight} of the score.`));
  }

  const details = el("details", "score-how");
  details.append(
    el("summary", null, "How this score works"),
    el(
      "p",
      null,
      "Each part is a real result from the last 7 days multiplied by its weight. The weights are not added together. A part with no data is left out and the remaining weights are scaled back up, so a week with nothing planned never counts as a failure.",
    ),
    list,
    el(
      "p",
      "hint",
      "Cancelled priorities stay in the denominator: an honest no is an answer. Postponed priorities leave it: the task moved, it did not fail. The score appears after 3 planned days and 2 reviews.",
    ),
  );
  return details;
}

function buildScoreCard() {
  const card = el("div", "card");
  card.id = "score-card";

  const head = el("div", "score-head");
  const number = el("p", "score-number");
  number.id = "score-number";
  const range = el("p", "score-range");
  range.id = "score-range";
  head.append(number, range);

  const parts = el("ul", "score-parts");
  parts.id = "score-parts";

  const note = el("p", "hint");
  note.id = "score-note";

  card.append(
    el("h2", null, "MindLoop Score"),
    el(
      "p",
      "hint",
      "A snapshot of your last 7 days of planning and follow-through. It describes the week, not your worth.",
    ),
    head,
    parts,
    note,
    buildHow(),
  );
  return card;
}

function renderScore() {
  const number = document.getElementById("score-number");
  const parts = document.getElementById("score-parts");
  const range = document.getElementById("score-range");
  const note = document.getElementById("score-note");
  if (!number || !parts || !range || !note) return;

  const now = new Date();
  const entries = getEntriesLocal();
  const result = mindloopScore(entries, now);
  const w = result.window;

  number.replaceChildren();
  if (result.available) {
    number.append(
      el("strong", "score-value", String(result.score)),
      el("span", "score-out-of", "/ 100"),
    );
  } else {
    number.append(el("strong", "score-learning", "Still learning your pattern"));
  }

  range.textContent = `Last 7 days · ${dateRange(w)}`;

  if (result.available) {
    const previous = mindloopScore(entries, now, addDays(todayKey(), -7));
    if (previous.available && previous.score !== null) {
      const delta = result.score - previous.score;
      note.textContent =
        delta === 0
          ? "The same as the previous 7 days."
          : `${Math.abs(delta)} points ${delta > 0 ? "higher" : "lower"} than the previous 7 days.`;
    } else {
      note.textContent =
        "This is your first score. A comparison appears after another week.";
    }
  } else {
    const missing = [];
    if (result.missing.plannedDays > 0) {
      missing.push(
        plural(result.missing.plannedDays, "more planned day", "more planned days"),
      );
    }
    if (result.missing.reviews > 0) {
      missing.push(plural(result.missing.reviews, "more review", "more reviews"));
    }
    note.textContent = `The score starts after 3 planned days and 2 reviews${
      missing.length ? ` — ${missing.join(" and ")} to go.` : "."
    }`;
  }

  parts.replaceChildren(
    ...result.components.map((component) => {
      const li = el("li", "score-part");
      li.classList.toggle("is-empty", component.fraction === null);

      const head = el("div", "score-part-head");
      head.append(
        el("span", "score-part-label", component.label),
        el(
          "span",
          "score-part-value",
          component.fraction === null
            ? "No data yet"
            : rateText(component.part, component.whole, component.percent),
        ),
      );

      const bar = el("div", "score-bar");
      bar.setAttribute("aria-hidden", "true");
      const fill = el("div", "score-bar-fill");
      fill.style.width = `${component.fraction === null ? 0 : Math.round(component.fraction * 100)}%`;
      bar.append(fill);

      li.append(
        head,
        bar,
        el(
          "span",
          "score-part-weight",
          component.fraction === null
            ? "not counted this week"
            : `${component.weight}% of the score`,
        ),
      );
      return li;
    }),
  );
}

/* ---------- Consistency and milestones ---------- */

function buildConsistencyCard() {
  const card = el("div", "card");
  card.id = "consistency-card";

  const body = el("div");
  body.id = "consistency-body";

  const row = el("div", "milestone-row");
  row.id = "milestone-row";

  card.append(
    el("h2", null, "Consistency"),
    el(
      "p",
      "hint",
      "A follow-through day is a day when you started or completed at least one priority you had planned. Opening the app does not count.",
    ),
    body,
    el("p", "milestones-head", "Milestones"),
    row,
    el(
      "p",
      "hint",
      "Milestones stay once reached. A broken streak never erases what you already did.",
    ),
  );
  return card;
}

function renderConsistency() {
  const body = document.getElementById("consistency-body");
  const row = document.getElementById("milestone-row");
  if (!body || !row) return;

  const now = new Date();
  const entries = getEntriesLocal();
  const week = windowStats(entries, todayKey(), 7, now);
  const month = windowStats(entries, todayKey(), 30, now);
  const streak = streakHistory(entries, todayKey());

  const daysText = (w) =>
    w.plannedDays === 0
      ? "No planned days yet"
      : `${w.followThroughDays} of ${w.plannedDays} planned days (${w.consistencyRate}%)`;

  body.replaceChildren(
    statRow("Last 7 days", daysText(week)),
    statRow("Last 30 days", daysText(month)),
    statRow(
      "Current review streak",
      streak.current === 0 ? "No streak yet" : plural(streak.current, "day", "days"),
    ),
    statRow(
      "Best review streak",
      streak.best === 0 ? "No reviews yet" : plural(streak.best, "day", "days"),
    ),
  );

  row.replaceChildren(
    ...MILESTONES.map((days) => {
      const earned = streak.earned.includes(days);
      const chip = el(
        "span",
        `milestone${earned ? " is-earned" : ""}`,
        earned ? `${days} days ✓` : `${days} days`,
      );
      chip.setAttribute(
        "aria-label",
        `${days} day milestone, ${earned ? "reached" : "not reached yet"}`,
      );
      return chip;
    }),
  );
}

/* ---------- Pattern coach (spec §7) ---------- */

function buildCoachCard() {
  const card = el("div", "card");
  card.id = "coach-card";

  const body = el("div");
  body.id = "coach-body";

  card.append(
    el("h2", null, "Pattern coach"),
    el(
      "p",
      "hint",
      "Built only from your own last 4 weeks of answers. It names a pattern only when several records agree, and it never guesses.",
    ),
    body,
  );
  return card;
}

function renderCoach() {
  const body = document.getElementById("coach-body");
  if (!body) return;

  const coach = patternCoach(getEntriesLocal(), todayKey(), new Date());
  if (!coach.ready) {
    body.replaceChildren(el("p", null, coach.focus));
    return;
  }

  const parts = [];
  if (coach.observations.length === 0) {
    parts.push(
      el(
        "p",
        "hint",
        "No pattern is strong enough to name yet. Keep planning with start times and it will speak up.",
      ),
    );
  } else {
    const list = el("ul", "coach-list");
    for (const text of coach.observations) list.append(el("li", null, text));
    parts.push(list);
  }

  const focus = el("div", "coach-focus");
  focus.append(el("h3", null, "One thing to try"), el("p", null, coach.focus));
  parts.push(focus);

  body.replaceChildren(...parts);
}

/* ---------- Growth timeline (spec §13) ---------- */

function buildTimelineCard() {
  const card = el("div", "card");
  card.id = "timeline-card";

  const body = el("div");
  body.id = "timeline-body";

  card.append(
    el("h2", null, "Growth timeline"),
    el(
      "p",
      "hint",
      "Real moments from your history, newest first. Nothing here is written by hand.",
    ),
    body,
  );
  return card;
}

function renderTimeline() {
  const body = document.getElementById("timeline-body");
  if (!body) return;

  const { events } = growthTimeline(getEntriesLocal(), todayKey(), new Date());
  if (events.length === 0) {
    body.replaceChildren(
      el("p", "hint", "Your timeline starts with your first review tonight."),
    );
    return;
  }

  const list = el("ol", "timeline");
  for (const event of events) {
    const item = el("li", "timeline-item");
    item.append(
      el("span", "timeline-date", fmtDay(event.date)),
      el("span", "timeline-title", event.title),
      el("span", "timeline-note", event.note),
    );
    list.append(item);
  }
  body.replaceChildren(list);
}

/* ---------- Weekly report ---------- */

function buildReportCard() {
  const card = el("div", "card");
  card.id = "report-card";

  const prev = el("button", "icon-btn");
  prev.type = "button";
  prev.id = "report-prev";
  prev.setAttribute("aria-label", "Previous week");
  prev.innerHTML = `<svg class="icon"><use href="#i-left"/></svg>`;

  const next = el("button", "icon-btn");
  next.type = "button";
  next.id = "report-next";
  next.setAttribute("aria-label", "Next week");
  next.innerHTML = `<svg class="icon"><use href="#i-right"/></svg>`;

  const title = el("div", "report-title");
  const week = el("p", "report-week");
  week.id = "report-week";
  const range = el("p", "report-range");
  range.id = "report-range";
  title.append(week, range);

  const nav = el("div", "report-nav");
  nav.append(prev, title, next);

  const body = el("div", "report-body");
  body.id = "report-body";

  card.append(el("h2", null, "Weekly report"), nav, body);
  return card;
}

function renderReport() {
  const body = document.getElementById("report-body");
  if (!body) return;

  const now = new Date();
  const entries = getEntriesLocal();
  const report = weeklyReport(entries, reportWeek, now);

  document.getElementById("report-week").textContent = `Week ${report.number}`;
  document.getElementById("report-range").textContent = report.range;
  document.getElementById("report-prev").disabled = !canGoPrev(
    entries,
    reportWeek,
  );
  document.getElementById("report-next").disabled = !canGoNext(
    reportWeek,
    todayKey(),
  );

  const statsBox = el("div");
  statsBox.append(
    statRow("Priorities planned", String(report.planned)),
    statRow("Started", rateText(report.begun, report.due, report.startRate)),
    statRow(
      "Completed",
      rateText(report.done, report.due, report.completionRate),
    ),
    statRow(
      "Postponed",
      report.postponed > 0 ? String(report.postponed) : "None",
    ),
    statRow(
      "Cancelled / not done",
      report.cancelled > 0 ? String(report.cancelled) : "None",
    ),
    statRow(
      "Follow-through days",
      report.plannedDays === 0
        ? "No planned days"
        : `${report.followThroughDays} of ${report.plannedDays} (${report.consistencyRate}%)`,
    ),
  );

  const compareBox = el("div", "report-compare");
  if (report.comparison) {
    const c = report.comparison;
    const delta = (value) =>
      value === null
        ? ""
        : value === 0
          ? " (no change)"
          : ` (${value > 0 ? "+" : ""}${value} points)`;
    compareBox.append(
      el("p", "report-compare-head", `Compared with ${c.previousRange}`),
      el(
        "p",
        null,
        `Completed ${c.previousDoneRate}% then, ${report.completionRate}% now${delta(c.doneDelta)}.`,
      ),
      el(
        "p",
        null,
        `Started ${c.previousStartRate}% then, ${report.startRate}% now${delta(c.startDelta)}.`,
      ),
    );
  } else {
    compareBox.append(
      el("p", "report-compare-head", "No comparison"),
      el(
        "p",
        null,
        report.weekStart < mondayOf(todayKey())
          ? "Last week had no comparable plan, or your records do not cover it fully."
          : "The comparison with last week appears once this week is over.",
      ),
    );
  }

  const patterns = el("div");
  patterns.append(el("h3", null, "What your own records show"));
  if (report.patterns.length === 0) {
    patterns.append(
      el(
        "p",
        "hint",
        "No reliable pattern yet this week. MindLoop only names a pattern when several of your own records agree.",
      ),
    );
  } else {
    const list = el("ul", "report-patterns");
    for (const text of report.patterns) list.append(el("li", null, text));
    patterns.append(list);
  }

  const experiment = el("div", "report-experiment");
  experiment.append(
    el("h3", null, "One thing to try"),
    el("p", null, report.experiment),
  );

  const aiHint = el(
    "p",
    "hint report-next-hint",
    "For an AI explanation in your insight language, open the Week insight in the Week tab.",
  );

  body.replaceChildren(statsBox, compareBox, patterns, experiment, aiHint);
}

/* ---------- Styles ---------- */

function initStyle() {
  if (document.getElementById("measure-style")) return;
  const style = document.createElement("style");
  style.id = "measure-style";
  style.textContent = `
    #score-card { border-color: var(--accent); }
    .score-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      margin: 6px 0 12px;
    }
    .score-number { margin: 0; font-weight: 700; }
    .score-value { font-size: 2.4rem; line-height: 1; color: var(--accent); }
    .score-out-of { margin-left: 4px; color: var(--muted); font-size: 0.95rem; }
    .score-learning { font-size: 1.15rem; line-height: 1.3; }
    .score-range { margin: 0; color: var(--muted); font-size: 0.9rem; }
    .score-parts { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
    .score-part.is-empty { opacity: 0.6; }
    .score-part-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-size: 0.92rem;
    }
    .score-part-label { color: var(--muted); }
    .score-part-value { font-weight: 600; text-align: right; }
    .score-bar {
      height: 8px;
      margin-top: 6px;
      background: var(--line);
      border-radius: 999px;
      overflow: hidden;
    }
    .score-bar-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 999px;
    }
    .score-part-weight {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 0.78rem;
    }
    .score-how { margin-top: 14px; color: var(--muted); font-size: 0.9rem; }
    .score-how summary {
      display: flex;
      align-items: center;
      min-height: 32px;
      color: var(--text);
      cursor: pointer;
    }
    .score-how ul { margin: 6px 0 0; padding-left: 20px; }
    #score-note { margin-top: 8px; }
    .milestones-head { margin: 18px 0 4px; font-size: 0.95rem; }
    .milestone-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 12px; }
    .milestone {
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      font-size: 0.82rem;
    }
    .milestone.is-earned {
      color: var(--accent);
      border-color: var(--accent);
      background: var(--surface-alt);
      font-weight: 600;
    }
    .report-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .report-title { text-align: center; }
    .report-week { margin: 0; font-weight: 600; }
    .report-range { margin: 0; color: var(--muted); font-size: 0.85rem; }
    .report-compare {
      margin-top: 12px;
      padding: 10px 12px;
      background: var(--surface-alt);
      border-radius: 8px;
      font-size: 0.9rem;
    }
    .report-compare p { margin: 4px 0; }
    .report-compare-head { color: var(--muted); }
    .report-patterns { margin: 8px 0 0; padding-left: 20px; }
    .report-patterns li { margin: 6px 0; }
    .report-experiment {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--line);
    }
    .report-experiment h3 { margin: 0 0 6px; }
    .report-experiment p { margin: 0; }
    .report-next-hint { margin-top: 14px; }
    #coach-card { border-color: var(--accent); }
    .coach-list { margin: 8px 0 0; padding-left: 20px; }
    .coach-list li { margin: 8px 0; }
    .coach-focus {
      margin-top: 14px;
      padding: 10px 12px;
      background: var(--surface-alt);
      border-radius: 8px;
    }
    .coach-focus h3 { margin: 0 0 4px; font-size: 0.95rem; }
    .coach-focus p { margin: 0; }
    .timeline {
      list-style: none;
      margin: 10px 0 0;
      padding: 0 0 0 14px;
      border-left: 2px solid var(--line);
    }
    .timeline-item {
      position: relative;
      display: grid;
      gap: 2px;
      padding: 0 0 16px 10px;
    }
    .timeline-item:last-child { padding-bottom: 0; }
    .timeline-item::before {
      content: "";
      position: absolute;
      left: -21px;
      top: 7px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
    }
    .timeline-date { color: var(--muted); font-size: 0.78rem; }
    .timeline-title { font-weight: 600; }
    .timeline-note { color: var(--muted); font-size: 0.88rem; }
  `;
  document.head.append(style);
}

/* ---------- Init ---------- */

function renderAll() {
  renderScore();
  renderConsistency();
  renderCoach();
  renderTimeline();
  renderReport();
}

// Reload from the account so the Progress tab is fresh even if it is the first
// thing opened. getEntries already falls back to the device copy offline.
async function refreshFromAccount() {
  try {
    await getEntries();
  } catch (err) {
    console.error("MindLoop: progress refresh failed", err);
  }
  renderAll();
}

function initReportNav() {
  document.getElementById("report-prev")?.addEventListener("click", () => {
    reportWeek = shiftWeek(reportWeek, -1);
    renderReport();
  });
  document.getElementById("report-next")?.addEventListener("click", () => {
    reportWeek = shiftWeek(reportWeek, 1);
    renderReport();
  });
}

function init() {
  const view = document.getElementById("view-progress");
  if (!view) return;

  initStyle();
  view.replaceChildren(
    buildScoreCard(),
    buildConsistencyCard(),
    buildCoachCard(),
    buildTimelineCard(),
    buildReportCard(),
  );
  initReportNav();
  renderAll();
  refreshFromAccount();

  document.addEventListener("click", (event) => {
    const tab = event.target.closest ? event.target.closest(".tab") : null;
    if (!tab || tab.dataset.view !== "progress") return;
    reportWeek = mondayOf(todayKey());
    renderAll();
    refreshFromAccount();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderAll();
  });

  window.addEventListener("online", () => {
    syncNow()
      .catch(() => {})
      .finally(refreshFromAccount);
  });
}

init();
