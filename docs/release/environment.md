# Layout environment variables

Layout remains fully usable without cloud configuration. To enable shared Buildr credentials and cloud synchronization, set:

- `NEXT_PUBLIC_SUPABASE_URL` — the same Supabase project URL used by Buildr.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — the public/publishable client key only. Never use a service-role key in the app.
- `NEXT_PUBLIC_AUTH_REDIRECT_URL` — approved production recovery/confirmation URL. For Android release candidates this must resolve through the Layout app link or its HTTPS fallback.
- `NEXT_PUBLIC_BUILDR_URL` — Buildr web fallback used when returning a completed layout.

Every redirect URL must also be allow-listed in Supabase Auth. Preview and production values must be kept separate. Do not use localhost in a release build.
