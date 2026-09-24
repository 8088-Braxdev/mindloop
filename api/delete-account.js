// api/delete-account.js
// Vercel serverless function: permanently deletes the signed-in user's account.
// entries and insights go with it (foreign keys cascade). ai_log keeps anonymous counts.

import { createClient } from "@supabase/supabase-js";

const fail = (res, status, code, message) =>
  res.status(status).json({ status: "error", code, message });

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "method", "Use POST.");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("MindLoop delete-account: missing env vars");
    return fail(res, 500, "setup", "Account deletion is not set up yet.");
  }

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The user id comes from the verified token, never from the body.
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return fail(res, 401, "signin", "Sign in to delete your account.");
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth?.user) {
    return fail(res, 401, "signin", "Your session has expired. Sign in again.");
  }

  if ((req.body || {}).confirm !== "DELETE") {
    return fail(res, 400, "bad_request", "Confirmation is missing.");
  }

  const { error } = await admin.auth.admin.deleteUser(auth.user.id);
  if (error) {
    console.error("MindLoop delete-account: failed", error);
    return fail(res, 500, "server", "Could not delete the account. Try again.");
  }
  return res.status(200).json({ status: "ok" });
}