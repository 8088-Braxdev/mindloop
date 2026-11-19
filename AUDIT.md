# MindLoop audit against the product specification

Static review of this repository (master at the start of this change). It
records what the code does, not what a live deployment was tested to do.
Database policies (RLS), the live Supabase schema and hosted notifications
were **not** inspected from here and are marked for investigation.

| Spec area | Status | Evidence / notes |
| --- | --- | --- |
| §2 Nightly review (wins, challenges, reason, lessons) | Existing and verified in code | `index.html`, `js/ui.js` |
| §2 Up to three priorities, optional start and finish time | Existing | `js/logic.js` (`validateReview`, `plannedMinutes`), `readForm` |
| §2 Status tracking (waiting, in progress, done, skipped, postponed, missed) | Existing | `priorityStatus` in `js/logic.js` |
| §2 Weekly view, streak, blocker chart, day chart | Existing | `renderWeek`, `weekStats` |
| §2 Google sign-in, Supabase data | Existing | `js/auth.js`, `js/supabase.js` |
| §2 Offline cache and pending-change queue | Existing | `js/storage.js` (per-user cache and queue) |
| §2 Tour, account deletion, entry/insight deletion, privacy page | Existing | `js/ui.js`, `js/account.js`, `api/delete-account.js`, `privacy.html` |
| §2 Server-side AI via Groq, caching, limits, duplicate protection | Existing | `api/insight.js` |
| §3 Insight language | Automatic only | English/Kiswahili switch removed; `languageRule` in `api/insight.js` follows the reviews' language |
| §4 Start time, finish time, reschedule history | Existing | `endTime` + derived `duration`; `reschedulePriority`, `rescheduled[]` |
| §4 Description / definition of done, completion note, postponement reason, per-priority reminder | Added in this change, except per-priority reminders | One optional "Done means…" line per priority, an optional completion note after Done, and one reason when a priority is moved (`setPriorityData` in `js/storage.js`, fields inside the priorities JSON so no schema change is needed). Reminders are still one setting for all priorities |
| §5 Reminder at the start time, snooze, start/stuck/done actions | Done | `js/reminders.js`: in-app card plus a local device notification, one per priority, no follow-up. Closed-app delivery: `js/push.js` (subscription) + `api/push-send.js` (sender) + `push_log` (one send per task per day). Setup: `PUSH.md` |
| §5 Push while the app is closed, quiet hours, notification permission | Done | Permission is asked once by the app itself when the first tour ends (`js/notify.js`), with no button in Account. Quiet hours are in Account, silence local notifications (`inQuietHours`) and are copied to the device's push subscription, so `api/push-send.js` also stays silent. Scheduler: Supabase `pg_cron` every 5 minutes (Vercel's free plan only allows daily crons). Requires `VAPID_*` keys in Vercel before it can deliver |
| §6 Rescue Mode | Existing | `js/rescue.js`; opening it never completes a task |
| §7 Personal Pattern Coach | Added in this change | `patternCoach` in `js/logic.js` reads the last 28 days, names at most three counted patterns, and refuses to guess on thin data; card in `js/measure.js` |
| §8 Adaptive Daily Plan (energy level) | Added in this change | Low / Normal / High choice in the night review with a suggested number of priorities (`energyPlan` in `js/logic.js`); advice only — nothing is blocked, hidden or filled in |
| §9 MindLoop Score with documented rules | Added in this change | `js/logic.js`, `js/measure.js`, `METRICS.md` |
| §10 Consistency tracker (7 and 30 days) | Added in this change | `windowStats` |
| §11 Streaks and milestones | Partial before, extended here | Streak existed; milestones 3/7/14/30 added and never erased |
| §12 Weekly report | Partial before, extended here | Stats and AI insight existed; comparison, patterns, one experiment added |
| §13 Growth Timeline | Added in this change | `growthTimeline` in `js/logic.js` dates the first review, each streak milestone, the first perfect day and the best week; card in `js/measure.js` |
| §14 Talk to Your Progress | Added in this change | "Ask your progress" card in `js/measure.js`, answered by `progressAnswers` in `js/logic.js` from recorded data only (no AI call, no invented number) |
| §16 RLS on every user-owned table | Needs investigation | Policies live in Supabase, not in this repository |
| §16 Deletes rely on RLS rather than an explicit user filter | Needs investigation | `clearAll` and `deleteInsight` filter by date/period only; this is safe only if RLS is correct |
| §16 AI keys server-side, bearer auth, rate limits | Existing | `api/insight.js` reads `GROQ_API_KEY`; Supabase RLS for reads |
| §17 Mobile, keyboard, loading/offline states | Partial, improved | 44px+ controls and offline/sync states already existed; visible focus rings, `prefers-reduced-motion` support and arrow-key navigation for the tab bar were added. A full screen-reader pass still needs a person using a screen reader |

## Notes for the next phase

1. Verify the Supabase schema and every RLS policy with a second account
   before claiming the delete paths are safe.
2. Phase 5 (pattern coach, growth timeline, talk to progress) should reuse
   `windowStats` and `weeklyReport` so every surface uses the same formulas.
3. Closed-app push remains the largest unbuilt piece of Phase 2; it needs
   infrastructure, not only frontend work.
