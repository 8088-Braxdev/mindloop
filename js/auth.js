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

// Returns { name, avatar, email } for the topbar, or null if no session.
export function getUserDisplay(session) {
  if (!session?.user) return null;
  const meta = session.user.user_metadata || {};
  const fullName = meta.full_name || meta.name || "";
  const firstName = fullName.split(" ")[0] || session.user.email?.split("@")[0] || "Mgeni";
  return {
    name: firstName,
    avatar: meta.avatar_url || meta.picture || null,
    email: session.user.email || "",
  };
}

// SHA-256 hash of the nonce, hex-encoded (Google needs the hash, Supabase needs the raw value).
// Full-page redirect to Google — works in every browser, no FedCM/One Tap
// dependency. Supabase exchanges the returned code for a session
// automatically when the browser lands back on redirectTo.
export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin,
    },
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