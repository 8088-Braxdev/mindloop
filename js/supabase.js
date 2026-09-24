import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://hptpgbzzkfibckwahqwd.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwdHBnYnp6a2ZpYmNrd2FocXdkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MDMzNDMsImV4cCI6MjA5MzQ3OTM0M30.ctIqiOZkYrrDpzHjd84nJhdKWKGJDjXn0kOOWAZVw1Q";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);