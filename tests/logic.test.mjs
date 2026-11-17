// tests/logic.test.mjs
// Reproducible checks for the measurement rules (spec §9–§12). These import
// the pure functions only: no DOM, no storage, no network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  growthTimeline,
  mindloopScore,
  patternCoach,
  streakHistory,
  weeklyReport,
  windowStats,
  plannedMinutes,
  addMinutesToTime,
} from "../js/logic.js";

const NOW = new Date(2026, 10, 8, 12, 0, 0); // Sunday 8 November 2026, noon

const priority = (text, extra = {}) => ({
  text,
  time: "",
  duration: null,
  startedAt: null,
  doneAt: null,
  skippedAt: null,
  postponedAt: null,
  rescheduled: [],
  ...extra,
});

const entry = (date, priorities = [], extra = {}) => ({
  date,
  wins: "Something went well",
  challenges: "Something did not",
  reason: "",
  lessons: "A lesson",
  priorities,
  ...extra,
});

const at = (date, time = "09:00") => new Date(`${date}T${time}:00`).toISOString();

// Plans for 2–8 Nov live on the entries for 1–7 Nov (a plan is written the
// night before). Today's review also exists, so reflection can be measured.
const entries = [
  entry("2026-11-01", [
    priority("Read", {
      time: "09:00",
      startedAt: at("2026-11-02"),
      doneAt: at("2026-11-02"),
    }),
    priority("Walk", {
      time: "10:00",
      startedAt: at("2026-11-02"),
      doneAt: at("2026-11-02"),
    }),
  ]),
  entry("2026-11-02", [
    priority("Study", {
      startedAt: at("2026-11-03"),
      doneAt: at("2026-11-03"),
    }),
    priority("Tidy", { skippedAt: at("2026-11-03") }),
  ]),
  entry("2026-11-03", [priority("Write", { postponedAt: at("2026-11-04") })]),
  // Marked done without ever tapping Start: still begun, but not started.
  entry("2026-11-04", [priority("Call", { doneAt: at("2026-11-05") })]),
  entry("2026-11-05", [priority("Plan trip")]),
  entry("2026-11-06", []),
  entry("2026-11-07", [priority("Email", { time: "09:00" })]),
  entry("2026-11-08", []),
];

test("postponed leaves the denominator, cancelled stays in it", () => {
  const w = windowStats(entries, "2026-11-08", 7, NOW);

  assert.equal(w.due, 7);
  assert.equal(w.done, 4);
  assert.equal(w.started, 3);
  assert.equal(w.begun, 4); // Call was done without Start
  assert.equal(w.postponed, 1);
  assert.equal(w.cancelled, 1);
  assert.equal(w.plannedDays, 6);
  assert.equal(w.followThroughDays, 3);
  assert.equal(w.reviewDays, 7);
  assert.equal(w.doneRate, 57);
  assert.equal(w.consistencyRate, 50);
  assert.equal(w.reflectionRate, 100);
});

test("the score is reproducible from the recorded answers", () => {
  const result = mindloopScore(entries, NOW);

  assert.equal(result.available, true);
  assert.equal(result.score, 62); // 57%*40 + 57%*25 + 50%*20 + 100%*15, / 100
  assert.equal(result.countedWeight, 100);

  const byId = Object.fromEntries(
    result.components.map((component) => [component.id, component]),
  );
  assert.equal(byId.completion.percent, 57);
  assert.equal(byId.completion.part, 4);
  assert.equal(byId.start.percent, 57);
  assert.equal(byId.start.part, 4); // done counts as begun
  assert.equal(byId.consistency.percent, 50);
  assert.equal(byId.reflection.percent, 100);
  assert.equal(result.weakest, "consistency");
});

test("a new user gets 'still learning', never a low score", () => {
  const fresh = [
    entry("2026-11-07", [priority("One small thing")]),
    entry("2026-11-08", []),
  ];
  const result = mindloopScore(fresh, NOW);

  assert.equal(result.available, false);
  assert.equal(result.score, null);
  assert.equal(result.missing.plannedDays, 3);
});

test("milestones come from the best run and survive a broken streak", () => {
  const continuous = streakHistory(entries, "2026-11-08");
  assert.equal(continuous.current, 8);
  assert.equal(continuous.best, 8);
  assert.deepEqual(continuous.earned, [3, 7]);
  assert.equal(continuous.next, 14);

  const gapped = [
    entry("2026-11-01"),
    entry("2026-11-02"),
    entry("2026-11-03"),
    entry("2026-11-04"),
    entry("2026-11-06"),
    entry("2026-11-07"),
    entry("2026-11-08"),
  ];
  const broken = streakHistory(gapped, "2026-11-08");
  assert.equal(broken.current, 3);
  assert.equal(broken.best, 4);
  assert.deepEqual(broken.earned, [3]);
});

test("the weekly report only compares a full, covered previous week", () => {
  const current = weeklyReport(entries, "2026-11-02", NOW);
  assert.equal(current.range, "2 Nov to 8 Nov");
  assert.equal(current.number, 2);
  assert.equal(current.planned, 8);
  assert.equal(current.due, 7);
  assert.equal(current.done, 4);
  assert.equal(current.begun, 4);
  assert.equal(current.postponed, 1);
  assert.equal(current.cancelled, 1);
  assert.equal(current.completionRate, 57);
  assert.equal(current.startRate, 57);
  assert.equal(current.plannedDays, 6);
  assert.equal(current.followThroughDays, 3);
  assert.equal(current.comparable, false);
  assert.equal(current.comparison, null);
  assert.equal(current.patterns.length, 1);
  assert.match(current.patterns[0], /Monday/);
  assert.match(current.experiment, /start time/);
});

test("a completed week is compared with the previous week", () => {
  const past = [
    entry("2026-10-18", [
      priority("P1", {
        startedAt: at("2026-10-19"),
        doneAt: at("2026-10-19"),
      }),
    ]),
    entry("2026-10-19", [
      priority("P2", {
        startedAt: at("2026-10-20"),
        doneAt: at("2026-10-20"),
      }),
    ]),
    entry("2026-10-25", [
      priority("P3", {
        startedAt: at("2026-10-26"),
        doneAt: at("2026-10-26"),
      }),
    ]),
    entry("2026-10-26", [priority("P4", { skippedAt: at("2026-10-27") })]),
  ];
  const report = weeklyReport(past, "2026-10-26", NOW);

  assert.equal(report.comparable, true);
  assert.equal(report.comparison.previousDoneRate, 100);
  assert.equal(report.completionRate, 50);
  assert.equal(report.startRate, 50); // P3 began, P4 was skipped
  assert.equal(report.comparison.doneDelta, -50);
  assert.equal(report.comparison.startDelta, -50);
  assert.equal(report.comparison.previousRange, "19 Oct to 25 Oct");
});

test("a start and finish time make one time block", () => {
  assert.equal(plannedMinutes("09:00", "10:30"), 90);
  assert.equal(plannedMinutes("9:05", "09:35"), 30);
  assert.equal(plannedMinutes("23:30", "00:30"), 60); // crosses midnight
  assert.equal(plannedMinutes("09:00", "09:00"), null); // not a length
  assert.equal(plannedMinutes("", "10:00"), null);
  assert.equal(plannedMinutes("09:00", ""), null);
  assert.equal(plannedMinutes("24:00", "10:00"), null);

  assert.equal(addMinutesToTime("09:00", 90), "10:30");
  assert.equal(addMinutesToTime("23:30", 60), "00:30");
  assert.equal(addMinutesToTime("", 30), "");
});

/* ---------- Spec §7: the coach, and §13: the timeline ---------- */

test("the coach names only patterns its own records support", () => {
  const coach = patternCoach(entries, "2026-11-08", NOW);

  assert.equal(coach.ready, true);
  assert.equal(coach.window.size, 28);
  assert.ok(coach.observations.length >= 1);
  assert.ok(coach.observations.length <= 3);
  assert.ok(coach.focus.length > 0);
});

test("the coach refuses to invent a pattern for a new user", () => {
  const fresh = [entry("2026-11-07", [priority("One small thing")])];
  const coach = patternCoach(fresh, "2026-11-08", NOW);

  assert.equal(coach.ready, false);
  assert.deepEqual(coach.observations, []);
  assert.match(coach.focus, /more days/);
});

test("the growth timeline dates real events, newest first", () => {
  const { events, first } = growthTimeline(entries, "2026-11-08", NOW);

  assert.equal(first, "2026-11-01");
  assert.equal(events[0].date, "2026-11-07"); // the 7-day streak was reached that night
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i - 1].date >= events[i].date);
  }

  const firstReview = events.find((e) => e.title === "First review written");
  assert.equal(firstReview.date, "2026-11-01");

  const perfect = events.find((e) => e.title.startsWith("Every priority"));
  assert.equal(perfect.date, "2026-11-02");

  assert.ok(events.some((e) => e.title === "Your best week so far"));
});

test("an empty history has no timeline yet", () => {
  const { events } = growthTimeline([], "2026-11-08", NOW);
  assert.deepEqual(events, []);
});
