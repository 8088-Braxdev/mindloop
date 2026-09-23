// js/storage.js
// The only file that knows where data lives.
// Today: localStorage. Later: Supabase (same function names, same shapes).

const KEY = "mindloop:entries";

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.error("MindLoop: could not read entries", err);
    return {};
  }
}

function writeAll(map) {
  localStorage.setItem(KEY, JSON.stringify(map));
}

// All entries as an array (logic.js sorts and filters).
export async function getEntries() {
  return Object.values(readAll());
}

export async function getEntry(dateKey) {
  return readAll()[dateKey] || null;
}

// Create or replace the entry for entry.date.
export async function saveEntry(entry) {
  const map = readAll();
  map[entry.date] = entry;
  writeAll(map);
  return entry;
}


// Plan card: stamp "startedAt" or "doneAt" on one priority (only once).
export async function markPriority(dateKey, index, field) {
  if (!["startedAt", "doneAt", "skippedAt"].includes(field)) return null;
  const map = readAll();
  const item = map[dateKey]?.priorities?.[index];
  if (!item || item[field]) return null;
  item[field] = new Date().toISOString();
  writeAll(map);
  return map[dateKey];
}

// Backup: everything as a JSON string (Export button uses this on Day 4).
export async function exportAll() {
  return JSON.stringify(Object.values(readAll()), null, 2);
}
export async function clearAll() {
  localStorage.removeItem(KEY);
}
