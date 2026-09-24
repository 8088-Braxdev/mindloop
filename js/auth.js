import { supabase } from "./supabase.js";

const UID_KEY = "mindloop:uid";

// Last signed-in user id on this device. Lets the app open offline,
// when Supabase cannot refresh an expired session.
export function cachedUserId() {
  try {
    return localStorage.getItem(UID_KEY);
  } catch {
    return null;
  }
}

// Returns the session, or null. Never throws (offline refresh fails quietly).
export async function getSession() {
  const { data } = await supabase.auth.getSession();
  const session = data?.session || null;
  if (session) {
    try {
      localStorage.setItem(UID_KEY, session.user.id);
    } catch {
      // Device storage blocked: the app still works while online.
    }
  }
  return session;
}

export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  try {
    localStorage.removeItem(UID_KEY);
  } catch {
    // Nothing to clean up if storage is blocked.
  }
}