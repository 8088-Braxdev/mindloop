// js/account.js
// Permanent account deletion. The server does the deleting (it needs the
// service role key); this file only asks, then wipes what is left on the device.

import { getSession, signOut } from "./auth.js";
import { clearInsightCache } from "./insights.js";

export async function deleteAccount() {
  if (!navigator.onLine) {
    throw new Error("You need an internet connection to delete your account.");
  }
  const session = await getSession();
  if (!session) throw new Error("Sign in again to delete your account.");

  let response;
  try {
    response = await fetch("/api/delete-account", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
  } catch {
    throw new Error("Could not reach the server. Check your connection.");
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status !== "ok") {
    throw new Error(body?.message || "Could not delete the account. Try again.");
  }

  // The account is gone. Remove what is left on this device.
  clearInsightCache();
  try {
    await signOut();
  } catch {
    // The session is already invalid on the server.
  }
  localStorage.clear();
  sessionStorage.clear();
}