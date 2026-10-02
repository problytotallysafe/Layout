import { createBrowserClient } from "@supabase/ssr";

let browserClient: ReturnType<typeof createBrowserClient> | null = null;

// Layout is a public client for the Buildr suite. Supabase publishable keys are
// intentionally browser-safe; keeping these defaults prevents an otherwise
// healthy production build from silently losing sign-in when Vercel variables
// are absent. Environment variables still take precedence.
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "https://aoypdetctllpaaqryyyt.supabase.co";
const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_h3LRF9yTw5HxpLOhHQvYJw_bMkPqh8b";

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabasePublishableKey);
}

export function getSupabaseBrowserClient() {
  if (!isSupabaseConfigured()) return null;
  if (!browserClient)
    browserClient = createBrowserClient(supabaseUrl, supabasePublishableKey);
  return browserClient;
}
