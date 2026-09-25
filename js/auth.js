import { supabase } from "./supabase.js";

const UID_KEY = "mindloop:uid";
const GOOGLE_CLIENT_ID =
  "721846211292-qaf3eu4r5a06acgm9ctn9bmuubrbtkre.apps.googleusercontent.com";

let gsiLoading = null;
function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gsiLoading) {
    gsiLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Could not load Google sign-in."));
      document.head.appendChild(script);
    });
  }
  return gsiLoading;
}
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
async function hashNonce(raw) {
  const encoded = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function signInWithGoogle() {
  await loadGoogleIdentity();

  const rawNonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const hashedNonce = await hashNonce(rawNonce);

  return new Promise((resolve, reject) => {
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      nonce: hashedNonce,
      use_fedcm_for_prompt: true,
      callback: async (response) => {
        try {
          const { error } = await supabase.auth.signInWithIdToken({
            provider: "google",
            token: response.credential,
            nonce: rawNonce,
          });
          if (error) throw error;
          resolve();
        } catch (err) {
          reject(err);
        }
      },
    });
    window.google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        reject(new Error("Google sign-in was closed. Try again."));
      }
    });
  });
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