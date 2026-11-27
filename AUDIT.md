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
| §3 Insight language | Automatic, any language | There is no language switch and no fixed list of languages: an insight is written in whatever language the person wrote that period's reviews in. `detectInsightLanguage` (`js/logic.js`) only names Swahili or English when its small word list is sure; every other language (French, Arabic, Hindi, Chinese, and so on) is passed to the model as `auto`, where the prompt rule tells it to work the language out from the person's own words, ignore the app's English labels, and never translate into English. If the reviews are too short to tell the language, the answer is English, and Account, Privacy and Terms say so |
| §4 Start time, finish time, reschedule history | Existing | `endTime` + derived `duration`; `reschedulePriority`, `rescheduled[]` |
| §4 Description / definition of done, completion note, postponement reason, per-priority reminder | Added in this change, except per-priority reminders | One optional "Done means…" text area per priority, an optional completion note after Done, and one reason when a priority is moved (`setPriorityData` in `js/storage.js`, fields inside the priorities JSON so no schema change is needed). Each priority also chooses its own reminder lead (at the start time, or 5/10/15 minutes before), stored as `remind` inside the priorities JSON; Account's setting is the default, and `api/push-send.js` honours the same choice for closed-app reminders |
| §5 Reminder at the start time, snooze, start/stuck/done actions | Done | `js/reminders.js`: in-app card plus a local device notification, one per priority, no follow-up. Closed-app delivery: `js/push.js` (subscription) + `api/push-send.js` (sender) + `push_log` (one send per task per day on each device). Setup: `PUSH.md` |
| §5 Push while the app is closed, quiet hours, notification permission | Done | Permission is asked from a real tap (`js/notify.js`): at the end of the tour and, at most twice, on the next tap. Account always has an "Allow notifications" / "Try again" control, and its line states what is actually true on the device (permission, live subscription, missing server keys, an iPhone Safari tab). A failed subscription names its reason and is retried when the connection returns; signing out and account deletion remove the subscription; a renewed browser subscription is saved by the service worker. Quiet hours are in Account, silence local notifications (`inQuietHours`) and are stored on the device's push subscription, so `api/push-send.js` also stays silent; the copy says they only silence MindLoop, never the phone's Do Not Disturb. Scheduler: Supabase `pg_cron` every 5 minutes (Vercel's free plan only allows daily crons). Requires `VAPID_*` keys in Vercel before it can deliver. `notificationReport` confirms the account really has this device's row before calling closed-app reminders "on", and the line states the honest limits: usually within 10 minutes of the start time, a 12-hour retention while the device is offline, and quiet hours that only silence MindLoop. Diagnostics live in `PUSH.md` section 5 (subscriptions, `push_log`, `cron.job_run_details`, `net._http_response`), not in the shipped app |
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
| §17 Mobile, keyboard, loading/offline states | Partial, improved | 44px+ controls and offline/sync states already existed; visible focus rings, `prefers-reduced-motion` support and arrow-key navigation for the tab bar were added. This pass centred every sheet on the screen and fitted it to the visual viewport, so an on-screen keyboard can no longer cover it, gave the quiet-hours fields their own labels so the row holds its shape on a phone, made the tour dim the page and place its bubble next to the highlighted part, left tooltips to mouse and keyboard users only (a tap once left one stuck), made the feedback card one-time per device, and added tablet/desktop layouts. Actions on a priority now keep a short caption under the icon on a phone ("Mark done", "Change start time") instead of an icon alone, the active tab is announced with `aria-current`, the tour bubble is a labelled live region, and both the sheets and the feedback card keep Tab inside the dialog and return focus to where it was when they close. A priority is now answered by at most three buttons (Start, Mark done, Not done) and every plan edit — change the start time, move it to another day, undo that move — sits behind one labelled "More options" control that opens a sheet naming each move and what it does, instead of arrows a person had to guess at; the closed-app reminder card groups its two answers above its quieter plan moves the same way. The tour now also walks through the Progress tab and through how a priority is answered. Rescue Mode's small step is a three-line textarea whose suggestion sits in the placeholder, instead of a one-line, search-looking input, and Account's notification line reports the device's real state (permission, live subscription, missing server keys, an iPhone Safari tab) with one tap to change it. A full screen-reader pass still needs a person using a screen reader |

## Notes for the next phase

1. Verify the Supabase schema and every RLS policy with a second account
   before claiming the delete paths are safe.
2. Phase 5 (pattern coach, growth timeline, talk to progress) should reuse
   `windowStats` and `weeklyReport` so every surface uses the same formulas.
3. Closed-app push is built but unverified on a live deployment: it needs the
   `VAPID_*` variables, `supabase/push.sql` and a running `pg_cron` job, none of
   which can be inspected from the repository. The in-app test narrows a
   failure to one stage; the scheduler still needs the SQL checks in PUSH.md.
