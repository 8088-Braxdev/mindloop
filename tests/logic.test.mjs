// tests/logic.test.mjs
// Reproducible checks for the measurement rules (spec §9–§12). These import
// the pure functions only: no DOM, no storage, no network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  energyPlan,
  growthTimeline,
  mindloopScore,
  patternCoach,
  progressAnswers,
  streakHistory,
  weeklyReport,
  windowStats,
  plannedMinutes,
  addMinutesToTime,
  detectInsightLanguage,
  pushFailureText,
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

/* ---------- Spec §8: adaptive plan, §14: answers about progress ---------- */

test("the plan follows the energy the person expects", () => {
  assert.equal(energyPlan("low").suggested, 1);
  assert.equal(energyPlan("normal").suggested, 2);
  assert.equal(energyPlan("high").suggested, 3);
  assert.equal(energyPlan("anything-else").level, "normal");
});

test("progress answers come from the recorded week, not from guesses", () => {
  const answers = progressAnswers(entries, NOW);

  assert.equal(answers.length, 5);
  const week = answers.find((a) => a.id === "week");
  assert.match(week.answer, /4 of 7/);
  assert.ok(answers.every((a) => a.answer.length > 0));
});

/* ---------- Spec §3: the insight follows the language of the reviews ---------- */
// detectInsightLanguage only names Swahili and English; null means "the app does
// not name a language" and the insight prompt then follows whatever language the
// entries are in, so no language is excluded.

test("a Swahili review asks for a Swahili insight", () => {
  const rows = [
    entry("2026-11-07", [priority("Kupanga mkutano na timu")], {
      wins: "Nimefanya kazi nzuri leo na nilimaliza ripoti",
      challenges: "Nilikuwa na uchovu sana lakini nilifanya kazi",
      lessons: "Kesho nitaanza mapema",
    }),
  ];
  assert.equal(detectInsightLanguage(rows), "sw");
});

test("an English review stays English", () => {
  const rows = [
    entry("2026-11-07", [priority("Plan the meeting")], {
      wins: "Finished the report and the gym",
      challenges: "I was tired but got it done",
      lessons: "Start earlier tomorrow",
    }),
  ];
  assert.equal(detectInsightLanguage(rows), "en");
});

test("one borrowed word does not change the language", () => {
  const rows = [
    entry("2026-11-07", [priority("Email")], {
      wins: "Sent the report",
      challenges: "Slow laptop",
      lessons: "Charge it earlier",
    }),
  ];
  const detected = detectInsightLanguage(rows);
  assert.ok(detected === "en" || detected === null);
});

test("a language outside the app's own two is left to automatic detection", () => {
  // The app must not force English or Swahili: any other language is passed on
  // as "no language named" and the model answers in the language it reads.
  const french = entry("2026-11-07", [priority("Finir le rapport")], {
    wins: "J'ai fini le rapport et je suis alle a la salle de sport",
    challenges: "J'etais fatigue mais j'ai continue",
    lessons: "Commencer plus tot demain",
  });
  assert.equal(detectInsightLanguage([french]), null);

  const arabic = entry("2026-11-08", [priority("كتابة التقرير")], {
    wins: "أنهيت التقرير وذهبت إلى النادي",
    challenges: "كنت متعبا لكنني أكملت",
    lessons: "سأبدأ مبكرا غدا",
  });
  assert.equal(detectInsightLanguage([arabic]), null);

  const chinese = entry("2026-11-09", [priority("写报告")], {
    wins: "我完成了报告并去了健身房",
    challenges: "我很累但还是完成了",
    lessons: "明天早点开始",
  });
  assert.equal(detectInsightLanguage([chinese]), null);
});

test("writing that says nothing about language leaves it open", () => {
  assert.equal(detectInsightLanguage([]), null);
  assert.equal(
    detectInsightLanguage([
      { wins: "", challenges: "", lessons: "", priorities: [{ text: "Email" }] },
    ]),
    null,
  );
});

test("a failed push save names the database reason it was given", () => {
  // Account must not blame the device for a table that does not exist, nor
  // promise a fix the person cannot make. The code decides the sentence.
  assert.match(
    pushFailureText("save", "42501"),
    /do not let this account write to them \(42501\)/,
  );
  assert.match(pushFailureText("save", "42P01"), /do not exist .*\(42P01\)/);
  assert.match(
    pushFailureText("save", "23505"),
    /already stored for a different account \(23505\)/,
  );
  assert.match(pushFailureText("save", "PGRST301"), /session has expired/);
});

test("a push failure with no known code stays general instead of guessing", () => {
  assert.equal(pushFailureText("save", ""), "this device could not be saved to your account");
  assert.equal(pushFailureText("save", "XX000"), "this device could not be saved to your account (XX000)");
  assert.equal(
    pushFailureText("no-server-key"),
    "MindLoop's push keys are not set up on the server yet",
  );
  assert.equal(pushFailureText(null, ""), "");
  assert.equal(pushFailureText(undefined, "42501"), "");
});
