// js/storage.js
// The only file that knows where data lives.
// Supabase is the source of truth. This device keeps two small things so the
// app works offline: a read copy (cache) and a queue of changes not yet sent.
// Both are stored per user, so two accounts on one browser never mix.

import { supabase } from "./supabase.js";
import { getSession, cachedUserId } from "./auth.js";

const TABLE = "entries";
const cacheKey = (uid) => `mindloop:cache:${uid}`;
const queueKey = (uid) => `mindloop:queue:${uid}`;

/* ---------- Device storage ---------- */

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.error("MindLoop: could not read device storage", err);
    return {};
  }
}

// Throws on failure: a queued change must never be lost silently.
function writeQueue(uid, queue) {
  localStorage.setItem(queueKey(uid), JSON.stringify(queue));
}

// The cache is only a convenience, so a failed write is not fatal.
function writeCache(uid, map) {
  try {
    localStorage.setItem(cacheKey(uid), JSON.stringify(map));
  } catch (err) {
    console.error("MindLoop: could not update offline copy", err);
  }
}

/* ---------- Shapes ---------- */

// DB row -> app entry (same shape the app always used).
function toEntry(row) {
  return {
    date: row.date,
    wins: row.wins,
    challenges: row.challenges,
    reason: row.reason,
    lessons: row.lessons,
    priorities: row.priorities || [],
  };
}

// App entry -> DB row.
function toRow(entry, userId, updatedAt) {
  return {
    user_id: userId,
    date: entry.date,
    wins: entry.wins ?? "",
    challenges: entry.challenges ?? "",
    reason: entry.reason ?? "",
    lessons: entry.lessons ?? "",
    priorities: entry.priorities ?? [],
    updated_at: updatedAt,
  };
}

/* ---------- Helpers ---------- */

async function currentUserId() {
  const session = await getSession();
  if (session) return session.user.id;
  const cached = cachedUserId();
  if (cached && !navigator.onLine) return cached;
  throw new Error("Hujaingia (not signed in)");
}

const isNetworkError = (err) =>
  !navigator.onLine ||
  /fetch|network|load failed|offline/i.test(err?.message || "");

function fail(action, error) {
  console.error(`MindLoop: ${action} failed`, error);
  throw new Error(error.message || `${action} failed`);
}

function logSyncError(err) {
  console.error("MindLoop: sync failed", err);
}

// Server data with this device's unsent changes on top.
function withPending(uid, map) {
  const merged = { ...map };
  for (const [date, item] of Object.entries(readJson(queueKey(uid)))) {
    merged[date] = item.entry;
  }
  return merged;
}

function updateCache(uid, entry) {
  const cache = readJson(cacheKey(uid));
  cache[entry.date] = entry;
  writeCache(uid, cache);
}

/* ---------- Sync ---------- */

export function hasPending() {
  const uid = cachedUserId();
  return !!uid && Object.keys(readJson(queueKey(uid))).length > 0;
}

let flushing = null;

// Sends queued changes. Safe to call any time: one run at a time,
// does nothing when offline or signed out.
export function syncNow() {
  if (!flushing) {
    flushing = flushQueue().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

async function flushQueue() {
  if (!navigator.onLine) return;
  const session = await getSession();
  if (!session) return;
  const uid = session.user.id;

  const queue = readJson(queueKey(uid));
  for (const date of Object.keys(queue)) {
    const { entry, updatedAt } = queue[date];

    // Last write wins: if the server copy is newer than this edit, keep the server's.
    const { data: current, error: readError } = await supabase
      .from(TABLE)
      .select("updated_at")
      .eq("date", date)
      .maybeSingle();
    if (readError) {
      if (isNetworkError(readError)) return;
      fail("sync", readError);
    }

    if (!current || new Date(current.updated_at) <= new Date(updatedAt)) {
      const { error } = await supabase
        .from(TABLE)
        .upsert(toRow(entry, uid, updatedAt), { onConflict: "user_id,date" });
      if (error) {
        if (isNetworkError(error)) return;
        fail("sync", error);
      }
    }

    // Re-read the queue so an edit made during sync is not deleted.
    const latest = readJson(queueKey(uid));
    if (latest[date] && latest[date].updatedAt === updatedAt) {
      delete latest[date];
      writeQueue(uid, latest);
    }
  }
}

/* ---------- Public API ---------- */

// All entries as an array (logic.js sorts and filters).
export async function getEntries() {
  const uid = await currentUserId();
  try {
    if (!navigator.onLine) throw new Error("offline");
    await syncNow().catch(logSyncError);
    const { data, error } = await supabase.from(TABLE).select("*");
    if (error) throw error;
    const map = {};
    data.forEach((row) => {
      map[row.date] = toEntry(row);
    });
    writeCache(uid, map);
    return Object.values(withPending(uid, map));
  } catch (err) {
    if (!isNetworkError(err)) fail("getEntries", err);
    return Object.values(withPending(uid, readJson(cacheKey(uid))));
  }
}

export async function getEntry(dateKey) {
  const uid = await currentUserId();
  if (navigator.onLine) await syncNow().catch(logSyncError);

  const pending = readJson(queueKey(uid))[dateKey];
  if (pending) return pending.entry;

  try {
    if (!navigator.onLine) throw new Error("offline");
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .eq("date", dateKey)
      .maybeSingle();
    if (error) throw error;
    return data ? toEntry(data) : null;
  } catch (err) {
    if (!isNetworkError(err)) fail("getEntry", err);
    return readJson(cacheKey(uid))[dateKey] || null;
  }
}

// Create or replace the entry for entry.date.
// The change is written to this device first, then sent. Offline, it waits in the queue.
export async function saveEntry(entry) {
  const uid = await currentUserId();
  const queue = readJson(queueKey(uid));
  queue[entry.date] = { entry, updatedAt: new Date().toISOString() };
  writeQueue(uid, queue);
  updateCache(uid, entry);

  try {
    await syncNow();
  } catch (err) {
    if (!isNetworkError(err)) throw err;
  }
  return entry;
}

// Plan card: stamp "startedAt", "doneAt" or "skippedAt" on one priority (only once).
export async function markPriority(dateKey, index, field) {
  if (!["startedAt", "doneAt", "skippedAt"].includes(field)) return null;
  const entry = await getEntry(dateKey);
  const item = entry?.priorities?.[index];
  if (!item || item[field]) return null;
  item[field] = new Date().toISOString();
  return saveEntry(entry);
}

// Backup: everything as a JSON string (works offline from the device copy).
export async function exportAll() {
  return JSON.stringify(await getEntries(), null, 2);
}

// Deletes ALL of this user's entries, on the server and on this device.
// Needs a connection, so a delete can never be undone by a later sync.
export async function clearAll() {
  if (!navigator.onLine) {
    throw new Error("You need an internet connection to delete your data.");
  }
  const uid = await currentUserId();
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .gte("date", "1900-01-01");
  if (error) fail("clearAll", error);
  localStorage.removeItem(cacheKey(uid));
  localStorage.removeItem(queueKey(uid));
}

// Call before signing out. Removes the device copy, but only when nothing is
// waiting to sync. Returns false if unsent changes would be lost.
export async function prepareSignOut() {
  const uid = cachedUserId();
  if (!uid) return true;
  await syncNow().catch(logSyncError);
  if (Object.keys(readJson(queueKey(uid))).length > 0) return false;
  localStorage.removeItem(cacheKey(uid));
  return true;
}