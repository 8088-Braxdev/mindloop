// js/settings.js
// Preferred insight language (spec §3): auto, English or Kiswahili.
//
// The preference is saved to the Supabase account (user metadata), so it
// follows the person to every device. A per-device copy in localStorage keeps
// it readable offline. Insight language is separate from the interface
// language: this only changes what language NEW AI insights are written in.
// Saved entries and old insights are never translated or rewritten.

import { supabase } from "./supabase.js";
import { getSession, cachedUserId } from "./auth.js";

const VALID = new Set(["auto", "en", "sw"]);
const localKey = (uid) => `mindloop:insight-lang:${uid}`;

function readLocal(uid) {
  try {
    const value = localStorage.getItem(localKey(uid));
    return VALID.has(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLocal(uid, value) {
  try {
    localStorage.setItem(localKey(uid), value);
  } catch {
    // The device copy is a convenience; the account copy is the truth.
  }
}

// The saved preference, or "auto" when nothing was chosen yet.
// Works offline: the session may be gone, the device copy is still there.
export async function getInsightLanguage() {
  const session = await getSession();
  const uid = session?.user?.id || cachedUserId();
  if (!uid) return "auto";

  const saved = session?.user?.user_metadata?.insight_language;
  if (VALID.has(saved)) {
    writeLocal(uid, saved);
    return saved;
  }
  return readLocal(uid) || "auto";
}

// Saves the preference to the account and this device.
// Needs a connection: the account copy is what other devices read.
export async function setInsightLanguage(value) {
  if (!VALID.has(value)) throw new Error("Unknown language.");
  if (!navigator.onLine) {
    throw new Error("You need an internet connection to change this setting.");
  }
  const session = await getSession();
  if (!session) throw new Error("Sign in again to change this setting.");
  const { error } = await supabase.auth.updateUser({
    data: { insight_language: value },
  });
  if (error) throw new Error("Could not save the setting. Try again.");
  writeLocal(session.user.id, value);
  return value;
}

/* ---------- Account view wiring (self-contained) ---------- */

async function initLanguageSelect() {
  const select = document.getElementById("insight-language");
  const status = document.getElementById("language-status");
  if (!select || !status) return;

  try {
    select.value = await getInsightLanguage();
  } catch (err) {
    console.error("MindLoop: could not read insight language", err);
  }

  select.addEventListener("change", async () => {
    const value = select.value;
    select.disabled = true;
    status.textContent = "Saving...";
    try {
      await setInsightLanguage(value);
      status.textContent = "Saved. New insights will use this language.";
    } catch (err) {
      console.error("MindLoop: could not save insight language", err);
      status.textContent = err.message || "Could not save. Try again.";
      select.value = await getInsightLanguage().catch(() => "auto");
    } finally {
      select.disabled = false;
    }
  });
}

// index.html loads this file as a module at the end of <body>. The card sits
// inside #app, so it only ever shows for a signed-in (or offline known) user.
initLanguageSelect();
