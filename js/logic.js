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

function plannedStart(planDate, time) {
  return time ? parseLocal(planDate, time) : null;
}

// Minutes between planned time and real start (negative = early).
export function startDiffMinutes(item, planDate) {
  const planned = plannedStart(planDate, item.time);
  if (!planned || !item.startedAt) return null;
  return Math.round((new Date(item.startedAt) - planned) / 60000);
}

// "done" | "started" | "missed" | "late" | "waiting"
// missed = day is over and never started
// late   = planned time passed today, not started yet
// waiting = planned time still ahead
export function priorityStatus(item, planDate, now) {
  if (item.doneAt) return "done";
  if (item.skippedAt) return "skipped";
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

  let due = 0, started = 0, done = 0, onTime = 0, lateMinutesTotal = 0;
  for (const item of items) {
    const status = priorityStatus(item, dateKey, now);
    if (status === "waiting") continue;
    due += 1;
    if (item.startedAt) {
      started += 1;
      const diff = startDiffMinutes(item, dateKey);
      if (diff !== null) lateMinutesTotal += Math.max(0, diff);
      if (isOnTime(item, dateKey)) onTime += 1;
    }
    if (item.doneAt) done += 1;
  }

  return {
    date: dateKey,
    weekday: weekdayName(dateKey),
    isFuture,
    isToday: dateKey === toDateKey(now),
    filled: entry !== null,
    reason: entry ? entry.reason : "",
    planned: items.length,
    due, started, done, onTime, lateMinutesTotal,
  };
}
// True when the item's time has come and the user has not answered yet.
export function needsAnswer(item, planDate, now = new Date()) {
  return !item.doneAt && !item.skippedAt &&
    priorityStatus(item, planDate, now) !== "waiting";
}
export function weekStats(entries, weekStart, now) {
  const days = weekDays(weekStart).map((d) => dayStats(entries, d, now));
  const past = days.filter((d) => !d.isFuture);

  const sum = (key) => past.reduce((total, d) => total + d[key], 0);
  const due = sum("due");
  const started = sum("started");
  const done = sum("done");
  const onTime = sum("onTime");

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
    due, started, done, onTime,
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
    done_rate_percent: s.doneRate,
    started_on_time: s.onTime,
    on_time_rate_percent: s.onTimeRate,
    average_start_delay_minutes: s.avgLateMinutes,
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
    started_on_time: d.onTime,
        done_rate_percent: d.due === 0 ? null : Math.round((d.done / d.due) * 100),
    on_time_rate_percent: d.due === 0 ? null : Math.round((d.onTime / d.due) * 100),
    priorities: items.map((item) => ({
      task: clipText(item.text, 80),
      planned_time: item.time || null,
      status: priorityStatus(item, dateKey, now),
      start_delay_minutes: startDiffMinutes(item, dateKey),
    })),
  };
}
// Every field of the night review must be filled before saving.
export function validateReview(review) {
  const missing = (label, focus) => ({ message: `Fill in ${label} first.`, focus });
  if (!review.wins) return missing("what went well", "wins");
  if (!review.challenges) return missing("what didn't go well", "challenges");
  if (!review.lessons) return missing("what you learned", "lessons");
  for (let i = 0; i < review.priorities.length; i++) {
    const p = review.priorities[i];
    if (!p.text) return missing(`priority ${i + 1}`, `p${i + 1}`);
    if (!p.time) {
      return { message: `Add a start time for priority ${i + 1}.`, focus: `t${i + 1}` };
    }
  }
  return null;
}
// The final delete button unlocks only when the person types DELETE.
export const isDeleteConfirmed = (text) => String(text).trim().toUpperCase() === "DELETE";