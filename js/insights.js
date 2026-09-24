// js/insights.js
// Talks to the insight system. Reading an existing insight never calls the API:
// it is a small database read, remembered in memory for the rest of the session.

import { supabase } from "./supabase.js";
import { getSession } from "./auth.js";

const found = new Map(); // "week:2026-09-21" -> { insight, createdAt }
const missedAt = new Map(); // when we last looked and found nothing
const MISS_TTL_MS = 30000;

const idOf = (type, key) => `${type}:${key}`;

export class InsightError extends Error {
  constructor(code, message, retryAfter) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function clearInsightCache() {
  found.clear();
  missedAt.clear();
}

// A finished insight for this period, or null. Only the person's own rows are visible (RLS).
export async function getInsight(type, key) {
  const id = idOf(type, key);
  if (found.has(id)) return found.get(id);
  if (!navigator.onLine) return null;

  const last = missedAt.get(id);
  if (last && Date.now() - last < MISS_TTL_MS) return null;

  const { data, error } = await supabase
    .from("insights")
    .select("content, created_at")
    .eq("type", type)
    .eq("period_key", key)
    .eq("status", "done")
    .maybeSingle();
  if (error) throw error;

  if (!data) {
    missedAt.set(id, Date.now());
    return null;
  }
  const value = { insight: data.content, createdAt: data.created_at };
  found.set(id, value);
  return value;
}

// Asks the server to write the insight. The server caches, limits and verifies it.
export async function requestInsight(type, key, facts) {
  if (!navigator.onLine) {
    throw new InsightError("offline", "You need an internet connection to get an insight.");
  }
  const session = await getSession();
  if (!session) throw new InsightError("signin", "Sign in again to get insights.");

  let response;
  try {
    response = await fetch("/api/insight", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ type, key, facts }),
    });
  } catch {
    throw new InsightError("offline", "Could not reach the server. Check your connection.");
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.status !== "ok") {
    throw new InsightError(
      body?.code || "server",
      body?.message || "Something went wrong. Try again in a moment.",
      body?.retryAfter,
    );
  }

  const value = { insight: body.insight, createdAt: body.createdAt };
  found.set(idOf(type, key), value);
  missedAt.delete(idOf(type, key));
  return value;
}