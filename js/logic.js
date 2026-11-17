// js/logic.js
// Pure functions only. No DOM, no storage.

export const REASON_LABELS = {
  distraction: "Distractions / social media",
  overwhelmed: "Task felt too big",
  fatigue: "Low energy",
  motivation: "Low motivation",
};

// Starting within this many minutes of the planned time counts as on time.
export const ON_TIME_GRACE_MIN = 10;

const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday",
];

/* ---------- Dates ---------- */

export function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseLocal(dateKey, time = "00:00") {
  return new Date(`${dateKey}T${time}:00`);
}

export function addDays(dateKey, n) {
  const d = parseLocal(dateKey);
  d.setDate(d.getDate() + n);
  return toDateKey(d);
}

export function weekdayName(dateKey) {
  return WEEKDAYS[parseLocal(dateKey).getDay()];
}

/* ---------- Weeks (Monday to Sunday) ---------- */

export function mondayOf(dateKey) {
  const day = parseLocal(dateKey).getDay(); // 0 = Sunday
  return addDays(dateKey, -((day + 6) % 7));
}

export function weekDays(weekStart) {
  return [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(weekStart, n));
}

export function shiftWeek(weekStart, n) {
  return addDays(weekStart, n * 7);
}

export function firstEntryDate(entries) {
  if (entries.length === 0) return null;
  return entries.map((e) => e.date).sort()[0];
}

// Week 1 = the week of your first review.
export function weekNumber(entries, weekStart) {
  const first = firstEntryDate(entries);
  if (!first) return 1;
  const ms = parseLocal(weekStart) - parseLocal(mondayOf(first));
  return Math.max(1, Math.round(ms / (7 * 24 * 60 * 60 * 1000)) + 1);
}

export function canGoPrev(entries, weekStart) {
  const first = firstEntryDate(entries);
  return first !== null && weekStart > mondayOf(first);
}

export function canGoNext(weekStart, todayKey) {
  return weekStart < mondayOf(todayKey);
}

export function weekRangeLabel(weekStart) {
  const fmt = (key) =>
    parseLocal(key).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${fmt(weekStart)} to ${fmt(addDays(weekStart, 6))}`;
}

/* ---------- Metric formulas (documented, spec §4/§9/§18) ----------
  Events are only ever recorded when the user taps an answer:
    startedAt   = user tapped Start
    doneAt      = user confirmed Done (honestly)
    skippedAt   = user said Not done (the "cancelled/skipped" status)
    postponedAt = user moved the task to another day (with optional reason)

  Denominator rules:
    due        = planned items whose time/day has arrived, minus postponed ones
    cancelled  (skippedAt) STAYS in the denominator: an honest "no" is an answer
    postponed  (postponedAt) LEAVES the denominator: the task moved, it did not
                fail. It is never counted as missed or late.
  A sent reminder, an app open, or a reschedule is NOT an outcome.
------------------------------------------------------------------------- */

/* ---------- Plans and priority status ---------- */

// Priorities written on the night of (dateKey - 1) are the plan for dateKey.
export function getPlan(entries, dateKey) {
  const sourceDate = addDays(dateKey, -1);
  const source = entries.find((e) => e.date === sourceDate);
  if (!source) return { sourceDate, items: [] };
  const items = (source.priorities || [])
    .map((p, index) => ({ ...p, index }))
    .filter((p) => p.text);
  return { sourceDate, items };
}
// Priorities shown in the card.
// savedTonight: the ones just saved (for tomorrow). Otherwise today's plan.
export function getCardPlan(entries, todayKey, savedTonight) {
  if (savedTonight) {
    const source = entries.find((e) => e.date === todayKey);
    const items = ((source && source.priorities) || [])
      .map((p, index) => ({ ...p, index }))
      .filter((p) => p.text);
    return { sourceDate: todayKey, planDate: addDays(todayKey, 1), items };
  }
  const { sourceDate, items } = getPlan(entries, todayKey);
  return { sourceDate, planDate: todayKey, items };
}
function plannedStart(planDate, time) {
  return time ? parseLocal(planDate, time) : null;
}

// Minutes between planned time and real start (negative = early).
export function startDiffMinutes(item, planDate) {
  const planned = plannedStart(planDate, item.time);
  if (!planned || !item.startedAt) return null;
  return Math.round((new Date(item.startedAt) - planned) / 60000);
}

// "done" | "started" | "missed" | "late" | "waiting" | "skipped" | "postponed"
// missed     = day is over and never started
// late       = planned time passed today, not started yet
// waiting    = planned time still ahead, or no time planned
// postponed  = the person moved it to another day (not a failure)
export function priorityStatus(item, planDate, now) {
  if (item.doneAt) return "done";
  if (item.skippedAt) return "skipped";
  if (item.postponedAt) return "postponed";
  if (item.startedAt) return "started";
  if (planDate < toDateKey(now)) return "missed";
  const planned = plannedStart(planDate, item.time);
  if (planned && now > planned) return "late";
  return "waiting";
}


export function isOnTime(item, planDate) {
  const diff = startDiffMinutes(item, planDate);
  return diff !== null && diff <= ON_TIME_GRACE_MIN;
}

/* ---------- Day and week stats ---------- */

export function dayStats(entries, dateKey, now) {
  const { items } = getPlan(entries, dateKey);
  const entry = entries.find((e) => e.date === dateKey) || null;
  const isFuture = dateKey > toDateKey(now);

  let due = 0, started = 0, begun = 0, done = 0, onTime = 0, lateMinutesTotal = 0, postponed = 0;
  let cancelled = 0;
  for (const item of items) {
    const status = priorityStatus(item, dateKey, now);
    if (status === "waiting") continue;
    // Postponed = moved to another day. It leaves today's counts entirely:
    // not due, not started, not done — and never counted as a failure here.
    if (item.postponedAt) {
      postponed += 1;
      continue;
    }
    due += 1;
    if (item.skippedAt) cancelled += 1;
    if (item.startedAt) {
      started += 1;
      const diff = startDiffMinutes(item, dateKey);
      if (diff !== null) lateMinutesTotal += Math.max(0, diff);
      if (isOnTime(item, dateKey)) onTime += 1;
    }
    if (item.doneAt) done += 1;
    // Begun = the person tapped Start or marked it done. Marking a task done
    // is a confirmed answer that the work happened, so it counts as begun
    // even when Start was never tapped (see METRICS.md).
    if (item.startedAt || item.doneAt) begun += 1;
  }

  return {
    date: dateKey,
    weekday: weekdayName(dateKey),
    isFuture,
    isToday: dateKey === toDateKey(now),
    filled: entry !== null,
    reason: entry ? entry.reason : "",
    planned: items.length,
    due, started, begun, done, onTime, postponed, cancelled, lateMinutesTotal,
  };
}
// True when the item's time has come and the user has not answered yet.
export function needsAnswer(item, planDate, now = new Date()) {
  return !item.doneAt && !item.skippedAt && !item.postponedAt &&
    priorityStatus(item, planDate, now) !== "waiting";
}
export function weekStats(entries, weekStart, now) {
  const days = weekDays(weekStart).map((d) => dayStats(entries, d, now));
  const past = days.filter((d) => !d.isFuture);

  const sum = (key) => past.reduce((total, d) => total + d[key], 0);
  const due = sum("due");
  const started = sum("started");
  const begun = sum("begun");
  const done = sum("done");
  const onTime = sum("onTime");
  const postponed = sum("postponed");
  const cancelled = sum("cancelled");

  const pct = (part, whole) => (whole === 0 ? null : Math.round((part / whole) * 100));

  const counts = {};
  for (const d of days) {
    if (d.reason) counts[d.reason] = (counts[d.reason] || 0) + 1;
  }
  const reasons = Object.entries(counts)
    .map(([reason, count]) => ({ reason, label: REASON_LABELS[reason], count }))
    .sort((a, b) => b.count - a.count);

  return {
    weekStart,
    number: weekNumber(entries, weekStart),
    range: weekRangeLabel(weekStart),
    days,
    daysFilled: days.filter((d) => d.filled).length,
    due, started, begun, done, onTime, postponed, cancelled,
    onTimeRate: pct(onTime, due),
    doneRate: pct(done, due),
    avgLateMinutes: started === 0 ? null : Math.round(sum("lateMinutesTotal") / started),
    reasons,
    topReason: reasons.length > 0 ? reasons[0] : null,
  };
}

/* ---------- Streak and patterns ---------- */

// Streak stays alive until a full day is missed.
export function computeStreak(entries, todayKey) {
  const filled = new Set(entries.map((e) => e.date));
  let cursor = filled.has(todayKey) ? todayKey : addDays(todayKey, -1);
  let streak = 0;
  while (filled.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// Weekday with the most logged blockers, across all weeks.
export function worstWeekday(entries) {
  const counts = {};
  for (const e of entries) {
    if (!e.reason) continue;
    const name = weekdayName(e.date);
    counts[name] = (counts[name] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return null;
  return { day: sorted[0][0], count: sorted[0][1] };
}

/* ---------- Chart data (UI only draws it) ---------- */

export function reasonChartData(stats) {
  const max = stats.reasons.length > 0 ? stats.reasons[0].count : 0;
  return stats.reasons.map((r) => ({
    label: r.label,
    count: r.count,
    widthPct: max === 0 ? 0 : Math.round((r.count / max) * 100),
  }));
}

export function dayChartData(stats) {
  return stats.days.map((d) => ({
    weekday: d.weekday.slice(0, 3),
    isFuture: d.isFuture,
    due: d.due,
    done: d.done,
    heightPct: d.due === 0 ? 0 : Math.round((d.done / d.due) * 100),
  }));
}

/* ---------- Share summary (plain text, any app) ---------- */

export function buildWeekSummary(entries, weekStart, now) {
  const s = weekStats(entries, weekStart, now);
  const lines = [];

  lines.push(`MindLoop, Week ${s.number} (${s.range})`);
  lines.push(`Days filled: ${s.daysFilled}/7`);

  if (s.due > 0) {
    lines.push(`Priorities done: ${s.done}/${s.due} (${s.doneRate}%)`);
    lines.push(`Started on time: ${s.onTime}/${s.due} (${s.onTimeRate}%)`);
    if (s.avgLateMinutes !== null) {
      lines.push(`Average start delay: ${s.avgLateMinutes} min`);
    }
  }
  if (s.postponed > 0) {
    lines.push(`Postponed: ${s.postponed}`);
  }
  if (s.topReason) {
    lines.push(`Top blocker: ${s.topReason.label} (${s.topReason.count}x)`);
  }

  for (const d of s.days) {
    if (d.isFuture) continue;
    const entry = entries.find((e) => e.date === d.date);
    lines.push("");
    lines.push(`${d.weekday} ${d.date}`);
    if (!entry) {
      lines.push("No review.");
      continue;
    }
    if (entry.wins) lines.push(`Wins: ${entry.wins}`);
    if (entry.challenges) lines.push(`Challenges: ${entry.challenges}`);
    if (entry.reason) lines.push(`Blocker: ${REASON_LABELS[entry.reason]}`);
    if (entry.lessons) lines.push(`Lessons: ${entry.lessons}`);

    const { items } = getPlan(entries, d.date);
    for (const item of items) {
      const status = priorityStatus(item, d.date, now);
      lines.push(`  - ${item.text} (${item.time || "no time"}) [${status}]`);
    }
  }

  return lines.join("\n");
}
/* ---------- Facts for AI insights ---------- */
// Ground-truth numbers sent to the AI. Same source as the Week view.

const clipText = (text, max) => {
  const t = String(text || "").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};

export function weekFacts(entries, weekStart, now) {
  const s = weekStats(entries, weekStart, now);
  const worst = worstWeekday(entries);
  return {
    week_number: s.number,
    range: s.range,
    on_time_means_started_within_minutes: ON_TIME_GRACE_MIN,
    days_with_review: s.daysFilled,
    priorities_due: s.due,
    priorities_started: s.started,
    priorities_done: s.done,
    started_on_time: s.onTime,
    on_time_rate_percent: s.onTimeRate,
    average_start_delay_minutes: s.avgLateMinutes,
    priorities_postponed: s.postponed,
    priorities_cancelled: s.cancelled,
    postponed_means: "moved to another day by the person; not counted as due or failed",
    top_blocker: s.topReason ? { label: s.topReason.label, days: s.topReason.count } : null,
    blockers: s.reasons.map((r) => ({ label: r.label, days: r.count })),
    hardest_weekday_all_time: worst ? { day: worst.day, blocker_days: worst.count } : null,
    days: s.days
      .filter((d) => !d.isFuture)
      .map((d) => ({
        date: d.date,
        weekday: d.weekday,
        review_written: d.filled,
        priorities_planned: d.planned,
        priorities_due: d.due,
        priorities_done: d.done,
        started_on_time: d.onTime,
        postponed: d.postponed,
        blocker: d.reason ? REASON_LABELS[d.reason] : null,
      })),
  };
}

export function dayFacts(entries, dateKey, now) {
  const d = dayStats(entries, dateKey, now);
  const { items } = getPlan(entries, dateKey);
  return {
    date: dateKey,
    weekday: d.weekday,
    on_time_means_started_within_minutes: ON_TIME_GRACE_MIN,
    review_written: d.filled,
    blocker: d.reason ? REASON_LABELS[d.reason] : null,
    priorities_planned: d.planned,
    priorities_due: d.due,
    priorities_started: d.started,
    priorities_done: d.done,
    priorities_postponed: d.postponed,
    priorities_cancelled: d.cancelled,
    started_on_time: d.onTime,
        done_rate_percent: d.due === 0 ? null : Math.round((d.done / d.due) * 100),
    on_time_rate_percent: d.due === 0 ? null : Math.round((d.onTime / d.due) * 100),
    priorities: items.map((item) => ({
      task: clipText(item.text, 80),
      planned_time: item.time || null,
      estimated_minutes: item.duration || null,
      times_rescheduled: (item.rescheduled || []).length,
      status: priorityStatus(item, dateKey, now),
      start_delay_minutes: startDiffMinutes(item, dateKey),
    })),
  };
}
// Every field of the night review must be filled before saving.
// A start time is optional (spec §4): only the task text is required.
export function validateReview(review) {
  const missing = (label, focus) => ({ message: `Fill in ${label} first.`, focus });
  if (!review.wins) return missing("what went well", "wins");
  if (!review.challenges) return missing("what didn't go well", "challenges");
  if (!review.lessons) return missing("what you learned", "lessons");
  for (let i = 0; i < review.priorities.length; i++) {
    const p = review.priorities[i];
    if (!p.text) return missing(`priority ${i + 1}`, `p${i + 1}`);
    if (
      p.duration != null &&
      (!Number.isFinite(p.duration) || p.duration < 1 || p.duration > 600)
    ) {
      return {
        message: `Priority ${i + 1}: duration must be between 1 and 600 minutes.`,
        focus: `d${i + 1}`,
      };
    }
  }
  return null;
}
// The final delete button unlocks only when the person types DELETE.
export const isDeleteConfirmed = (text) => String(text).trim().toUpperCase() === "DELETE";

/* ---------- Measurement: score, consistency, milestones, weekly report ----------
   Spec §9-§12. Every number below comes from answers the person actually gave
   (startedAt / doneAt / skippedAt / postponedAt) and reviews they wrote.
   App opens and sent reminders are never outcomes.

   The same rules are written down for people in METRICS.md and in the
   "How this score works" panel on the Progress tab.
--------------------------------------------------------------------------- */

export const SCORE_WEIGHTS = {
  completion: 40,
  start: 25,
  consistency: 20,
  reflection: 15,
};
export const SCORE_WINDOW_DAYS = 7;
export const SCORE_MIN_PLANNED_DAYS = 3;
export const SCORE_MIN_REVIEWS = 2;
export const MILESTONES = [3, 7, 14, 30];

// Rounded percentage, or null when there is nothing to divide by.
export function percent(part, whole) {
  return whole === 0 ? null : Math.round((part / whole) * 100);
}

// The last `size` days ending on endKey, oldest first. Never in the future.
export function windowDays(endKey, size, now = new Date()) {
  const end = endKey > toDateKey(now) ? toDateKey(now) : endKey;
  const days = [];
  for (let n = size - 1; n >= 0; n--) days.push(addDays(end, -n));
  return days;
}

// Totals for a rolling window. Same denominator rules as the Week view:
//   cancelled (an honest "not done") stays in the denominator,
//   postponed (the task moved) leaves it.
// `plannedDays` counts days that had work come due; a rest day is not a fail.
export function windowStats(entries, endKey, size, now = new Date()) {
  const keys = windowDays(endKey, size, now);
  const start = keys[0];
  const end = keys[keys.length - 1];
  const days = keys.map((key) => dayStats(entries, key, now));
  const elapsed = days.filter((d) => !d.isFuture);

  // Days before the person's first review had no plan, so a missing review
  // there is not counted against them.
  const first = firstEntryDate(entries);
  const counted =
    first && first > start ? elapsed.filter((d) => d.date >= first) : elapsed;

  const total = (key) => elapsed.reduce((sum, d) => sum + d[key], 0);
  const due = total("due");
  const begun = total("begun");
  const done = total("done");
  const plannedDays = elapsed.filter(
    (d) => d.due > 0 || d.postponed > 0,
  ).length;
  const followThroughDays = elapsed.filter(
    (d) => d.done > 0 || d.started > 0,
  ).length;
  const reviewDays = counted.filter((d) => d.filled).length;

  return {
    start,
    end,
    size,
    days,
    elapsedDays: counted.length,
    reviewDays,
    plannedDays,
    followThroughDays,
    planned: total("planned"),
    due,
    started: total("started"),
    begun,
    done,
    onTime: total("onTime"),
    postponed: total("postponed"),
    cancelled: total("cancelled"),
    doneRate: percent(done, due),
    startRate: percent(begun, due),
    onTimeRate: percent(total("onTime"), due),
    consistencyRate: percent(followThroughDays, plannedDays),
    reflectionRate: percent(reviewDays, counted.length),
  };
}

// The MindLoop Score: each part's real result multiplied by its weight, then
// divided by the weights that had data. Weights are never simply added.
// A new user gets "Still learning your pattern" (score null) instead of a
// misleading low number.
export function mindloopScore(
  entries,
  now = new Date(),
  endKey = toDateKey(now),
  size = SCORE_WINDOW_DAYS,
) {
  const w = windowStats(entries, endKey, size, now);

  const components = [
    {
      id: "completion",
      label: "Priorities completed",
      weight: SCORE_WEIGHTS.completion,
      part: w.done,
      whole: w.due,
    },
    {
      id: "start",
      label: "Priorities begun",
      weight: SCORE_WEIGHTS.start,
      part: w.begun,
      whole: w.due,
    },
    {
      id: "consistency",
      label: "Follow-through days",
      weight: SCORE_WEIGHTS.consistency,
      part: w.followThroughDays,
      whole: w.plannedDays,
    },
    {
      id: "reflection",
      label: "Days reviewed",
      weight: SCORE_WEIGHTS.reflection,
      part: w.reviewDays,
      whole: w.elapsedDays,
    },
  ].map((component) => ({
    ...component,
    percent: percent(component.part, component.whole),
    fraction: component.whole > 0 ? component.part / component.whole : null,
  }));

  const counted = components.filter((c) => c.fraction !== null);
  const countedWeight = counted.reduce((sum, c) => sum + c.weight, 0);
  const available =
    w.plannedDays >= SCORE_MIN_PLANNED_DAYS &&
    w.reviewDays >= SCORE_MIN_REVIEWS;
  const score =
    available && countedWeight > 0
      ? Math.round(
          (counted.reduce((sum, c) => sum + c.fraction * c.weight, 0) /
            countedWeight) *
            100,
        )
      : null;

  return {
    available,
    score,
    window: w,
    components,
    countedWeight,
    missing: {
      plannedDays: Math.max(0, SCORE_MIN_PLANNED_DAYS - w.plannedDays),
      reviews: Math.max(0, SCORE_MIN_REVIEWS - w.reviewDays),
    },
    weakest: counted.length
      ? counted.reduce((low, c) => (c.fraction < low.fraction ? c : low)).id
      : null,
  };
}

// Best run of consecutive review days, ever. Milestones are derived from
// history, so breaking a streak cannot erase one and nothing is awarded twice.
export function streakHistory(entries, todayKey) {
  const filled = [...new Set(entries.map((e) => e.date))].sort();
  let best = 0;
  let bestEnd = null;
  let run = 0;
  let previous = null;

  for (const key of filled) {
    run = previous && addDays(previous, 1) === key ? run + 1 : 1;
    if (run > best) {
      best = run;
      bestEnd = key;
    }
    previous = key;
  }

  return {
    current: computeStreak(entries, todayKey),
    best,
    bestEnd,
    earned: MILESTONES.filter((m) => best >= m),
    next: MILESTONES.find((m) => best < m) || null,
  };
}

// One experiment for the coming week, chosen from the person's own blocker
// and results. Never a long generic list.
export function weeklyExperiment(stats) {
  if (stats.due === 0) {
    return "Next week, plan one small priority with a start time. One is enough to begin.";
  }
  const reason = stats.topReason ? stats.topReason.reason : null;
  if (reason === "distraction") {
    return "Try one priority with your phone face-down for the first 25 minutes, and see whether starting gets easier.";
  }
  if (reason === "overwhelmed") {
    return "Pick your biggest priority and write its first two-minute step before you start it.";
  }
  if (reason === "fatigue") {
    return "Move your most important priority to the time of day when you usually have the most energy.";
  }
  if (reason === "motivation") {
    return "Choose one priority and commit to only five minutes of it. Stopping after five is allowed.";
  }
  if ((stats.doneRate ?? 100) < 50) {
    return "Plan two priorities instead of three next week, and give each one a start time.";
  }
  if ((stats.onTimeRate ?? 100) < 50) {
    return "Give one priority a start time and begin within ten minutes of it, just for one day.";
  }
  return "Keep the same number of priorities and add a start time to one of them.";
}

// Spec §12: a concise report of the week, compared only with a full previous
// week of real records. Patterns are stated with counts, never as "always".
export function weeklyReport(entries, weekStart, now = new Date()) {
  const stats = weekStats(entries, weekStart, now);
  const previousStart = shiftWeek(weekStart, -1);
  const previous = weekStats(entries, previousStart, now);
  const today = toDateKey(now);
  const first = firstEntryDate(entries);

  const elapsed = stats.days.filter((d) => !d.isFuture);
  const plannedDays = elapsed.filter(
    (d) => d.due > 0 || d.postponed > 0,
  ).length;
  const followThroughDays = elapsed.filter(
    (d) => d.done > 0 || d.started > 0,
  ).length;

  // Comparing a half-finished week with a full one would not be honest.
  const weekOver = weekStart < mondayOf(today);
  const comparable =
    weekOver && previous.due > 0 && first !== null && first <= previousStart;

  const comparison = comparable
    ? {
        previousRange: previous.range,
        previousDone: previous.done,
        previousDue: previous.due,
        previousDoneRate: previous.doneRate,
        previousStartRate: percent(previous.begun, previous.due),
        doneDelta:
          stats.doneRate === null || previous.doneRate === null
            ? null
            : stats.doneRate - previous.doneRate,
        startDelta:
          stats.due === 0 || previous.due === 0
            ? null
            : percent(stats.begun, stats.due) -
              percent(previous.begun, previous.due),
        dueDelta: stats.due - previous.due,
      }
    : null;

  // Rescheduling is a plan change the person recorded, not a failure.
  let rescheduled = 0;
  for (const day of elapsed) {
    const { items } = getPlan(entries, day.date);
    rescheduled += items.filter((item) => (item.rescheduled || []).length > 0)
      .length;
  }

  const patterns = [];
  if (stats.daysFilled >= 3 && stats.topReason && stats.topReason.count >= 2) {
    patterns.push(
      `${stats.topReason.label} was your main blocker on ${stats.topReason.count} of the ${stats.daysFilled} days you reviewed.`,
    );
  }
  const dueDays = elapsed.filter((d) => d.due > 0);
  const doneDays = dueDays.filter((d) => d.done > 0);
  if (dueDays.length >= 3 && doneDays.length >= 2) {
    const best = doneDays.reduce((top, d) => (d.done > top.done ? d : top));
    if (best.done >= 2) {
      patterns.push(
        `You completed ${best.done} priorities on ${best.weekday} — more than on any other day this week.`,
      );
    }
  }
  if (patterns.length === 0 && rescheduled >= 2) {
    patterns.push(
      `You changed the start time of ${rescheduled} priorities during the week.`,
    );
  }

  return {
    weekStart,
    number: stats.number,
    range: stats.range,
    stats,
    planned: stats.days.reduce((sum, d) => sum + d.planned, 0),
    due: stats.due,
    started: stats.started,
    begun: stats.begun,
    done: stats.done,
    postponed: stats.postponed,
    cancelled: stats.cancelled,
    completionRate: stats.doneRate,
    startRate: percent(stats.begun, stats.due),
    plannedDays,
    followThroughDays,
    consistencyRate: percent(followThroughDays, plannedDays),
    rescheduled,
    blockers: stats.reasons,
    patterns: patterns.slice(0, 2),
    comparable,
    comparison,
    experiment: weeklyExperiment(stats),
  };
}
