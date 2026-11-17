# MindLoop measurement rules

How MindLoop turns recorded answers into the MindLoop Score, the consistency
tracker, milestones and the weekly report (spec §9–§12). The same rules are
shown to people in the **How this score works** panel on the Progress tab.

The short version: **only answers a person gave count.** Tapping Start, Done,
Not done or Postpone, and writing a review. Opening the app, receiving a
reminder, or the app being online are never outcomes.

## What is measured

| Event | Meaning | Counted as |
| --- | --- | --- |
| `startedAt` | The person tapped Start | Begun |
| `doneAt` | The person confirmed Done | Begun and completed |
| `skippedAt` | The person said Not done | Cancelled — stays due |
| `postponedAt` | The person moved the task | Postponed — leaves due |
| review written | A review exists for that date | Reflection |

A priority marked done without ever tapping Start still counts as **begun**,
because marking it done is a confirmed answer that the work happened. It is
not counted as a recorded **start**; the Week view's existing "Started on
time" measure keeps that stricter meaning.

## Denominator rules

- **Due** = planned items whose day or start time has arrived, minus postponed
  items.
- **Cancelled** (`skippedAt`) stays in the denominator. An honest "no" is an
  answer and must not improve a rate by disappearing.
- **Postponed** (`postponedAt`) leaves the denominator. The task moved; it did
  not fail.
- **Days with no plan** are not failures. Consistency divides by *planned
  days* — days where at least one priority came due — not by every calendar
  day.
- Days before a person's first review are left out of reflection, so a new
  account is not penalised for time before it existed.

## MindLoop Score (last 7 days)

Four parts, each a real result multiplied by its weight:

| Part | Weight | Result |
| --- | --- | --- |
| Priorities completed | 40% | done ÷ due |
| Priorities begun | 25% | begun ÷ due |
| Follow-through days | 20% | days with a start or completion ÷ planned days |
| Days reviewed | 15% | reviews ÷ elapsed days since first use in the window |

The score is `sum(part result × weight) ÷ sum(weights with data) × 100`. The
weights are **not** added together as if they were results. A part with no
data (for example no due priorities) is left out and the remaining weights are
scaled back up, so an empty week never lowers the score.

**New accounts:** the score appears only after **3 planned days** and **2
reviews**. Before that, MindLoop shows "Still learning your pattern" instead
of a misleading low number.

The Progress tab also shows the change from the previous, non-overlapping
7-day window: "8 points higher than the previous 7 days."

## Consistency

- **Follow-through day** = a day with at least one priority that was started
  or completed. Opening the app does not count.
- Shown for the last 7 and last 30 days as `follow-through days / planned
  days`, with the rate.

## Streaks and milestones

- The existing streak counts consecutive days with a review.
- Milestones are **derived from the best run of consecutive review days in the
  whole history**, at 3, 7, 14 and 30 days. Because they are derived, a broken
  streak cannot erase one, and no duplicate award is possible.
- No new database table or migration is needed for any of this: everything is
  computed from existing entries.

## Weekly report

Includes the exact date range, priorities planned, started (begun), completed,
postponed and cancelled, completion and start rates, follow-through days, and
common blockers. It adds at most two evidence-backed patterns, always with
counts ("In 4 of your last 6 reviews…"), never "you always".

**Comparison rules:** a week is compared with the previous week only when the
displayed week is over, the previous week had at least one due priority, and
the person's records cover that previous week from its start. Otherwise the
report says why the comparison is missing. A half-finished week is never
compared with a full one.

**One experiment** for the coming week is chosen from the person's own blocker
and results — one action, not a generic list.

The AI-written weekly insight remains in the Week tab and uses the preferred
insight language (spec §3). The Progress report is deterministic and does not
call the AI, so it costs nothing and cannot invent a pattern.

## Reproducing the numbers

`npm test` runs `tests/logic.test.mjs` with Node's built-in test runner. It
covers the denominator rules, a known score (62 from the fixture), the
"still learning" gate, milestone history across a break, and the weekly-report
comparison rules.
