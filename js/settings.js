// js/settings.js
// Loader for the optional feature modules: reminders.js, rescue.js, measure.js
// and feedback.js are dynamically imported here so index.html never needs a
// new script tag for a feature to work.
//
// Insight language is Automatic on purpose: new AI insights follow the
// language the person writes their reviews in. There is no English/Kiswahili
// switch, and saved reviews or old insights are never translated.

function loadOptionalModules() {
  import("./reminders.js").catch((err) => {
    console.error("MindLoop: reminders module failed to load", err);
  });
  import("./rescue.js").catch((err) => {
    console.error("MindLoop: rescue module failed to load", err);
  });
  import("./measure.js").catch((err) => {
    console.error("MindLoop: measure module failed to load", err);
  });
  import("./feedback.js").catch((err) => {
    console.error("MindLoop: feedback module failed to load", err);
  });
}

loadOptionalModules();
