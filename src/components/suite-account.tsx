"use client";

import { Cloud, LogOut, UserRound, X } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";

type Mode = "sign-in" | "create" | "recovery";

export function SuiteAccountButton() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    let mounted = true;
    void supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
      if (mounted) setUserEmail(data.session?.user.email ?? null);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
      if (!mounted) return;
      setUserEmail(session?.user.email ?? null);
      if (event === "PASSWORD_RECOVERY") {
        setMode("recovery");
        setOpen(true);
      }
      window.dispatchEvent(new CustomEvent("buildr:auth-change"));
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  if (!isSupabaseConfigured()) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    setMessage("");
    try {
      if (mode === "recovery") {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setMessage("Password updated.");
        setMode("sign-in");
        setPassword("");
      } else if (mode === "create") {
        const redirect = process.env.NEXT_PUBLIC_AUTH_REDIRECT_URL || window.location.origin;
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
        if (error) throw error;
        setMessage(data.session ? "Account created and signed in." : "Check your email to confirm your account.");
        if (data.session) setOpen(false);
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setOpen(false);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Account action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function sendReset() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !email.trim()) {
      setMessage("Enter your email first.");
      return;
    }
    setBusy(true);
    const redirect = process.env.NEXT_PUBLIC_AUTH_REDIRECT_URL || window.location.origin;
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirect });
    setMessage(error?.message || "Password reset email sent.");
    setBusy(false);
  }

  async function signOut() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    await supabase.auth.signOut();
    setOpen(false);
  }

  return <>
    <button className="icon-button" onClick={() => setOpen(true)} aria-label={userEmail ? `Account: ${userEmail}` : "Sign in to Buildr account"} title={userEmail || "Buildr account"}>
      {userEmail ? <Cloud size={18} /> : <UserRound size={18} />}
    </button>
    {open && <div className="account-backdrop" onPointerDown={() => setOpen(false)}>
      <section className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="suite-account-title" onPointerDown={(event) => event.stopPropagation()}>
        <div className="account-heading">
          <div><span className="eyebrow">Buildr suite</span><h2 id="suite-account-title">{userEmail ? "Account & sync" : mode === "create" ? "Create account" : mode === "recovery" ? "Choose a new password" : "Sign in"}</h2></div>
          <button onClick={() => setOpen(false)} aria-label="Close account"><X size={18} /></button>
        </div>
        {userEmail && mode !== "recovery" ? <>
          <p>Signed in as <strong>{userEmail}</strong>. Layouts save on this device first and synchronize when service is available.</p>
          <button className="account-secondary" onClick={signOut}><LogOut size={16} /> Sign out</button>
        </> : <form onSubmit={submit}>
          {mode !== "recovery" && <label><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
          <label><span>{mode === "recovery" ? "New password" : "Password"}</span><input type="password" minLength={8} autoComplete={mode === "sign-in" ? "current-password" : "new-password"} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {message && <p className="account-message">{message}</p>}
          <button className="account-primary" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "create" ? "Create account" : mode === "recovery" ? "Update password" : "Sign in"}</button>
          {mode === "sign-in" && <button className="account-link" type="button" disabled={busy} onClick={sendReset}>Forgot password?</button>}
          {mode !== "recovery" && <button className="account-link" type="button" onClick={() => { setMode(mode === "create" ? "sign-in" : "create"); setMessage(""); }}>{mode === "create" ? "Already have an account? Sign in" : "Need an account? Create one"}</button>}
        </form>}
      </section>
    </div>}
  </>;
}
