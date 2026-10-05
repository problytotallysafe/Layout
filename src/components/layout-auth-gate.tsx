"use client";

import { FormEvent, useEffect, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import {
  ArrowRight,
  Check,
  DoorOpen,
  Grid2X2,
  Ruler,
  RotateCw,
} from "lucide-react";
import { LayoutShell } from "@/components/layout-shell";
import {
  getSupabaseBrowserClient,
  isSupabaseConfigured,
} from "@/lib/supabase/client";

type AccountMode = "signup" | "signin" | "recovery";

const workflow = [
  {
    step: "01",
    title: "Draw the space",
    detail: "Outline the room, then add walls and openings where the cuts matter.",
    icon: Ruler,
  },
  {
    step: "02",
    title: "Set your tile",
    detail: "Enter tile size, grout width, and waste to preview the pattern at scale.",
    icon: Grid2X2,
  },
  {
    step: "03",
    title: "Find a better start",
    detail: "Balance edge cuts, compare rotations, and fine-tune the layout before setting tile.",
    icon: RotateCw,
  },
  {
    step: "04",
    title: "Keep it with the job",
    detail: "Save layouts to your Buildr account and use the same login in Buildr and Floorplan.",
    icon: DoorOpen,
  },
];

export default function LayoutAuthGate() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<AccountMode>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setChecking(false);
      return;
    }

    let mounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setChecking(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (event: AuthChangeEvent, nextSession: Session | null) => {
        if (!mounted) return;
        if (event === "PASSWORD_RECOVERY") {
          setMode("recovery");
          setMessage("Choose a new password for your Buildr account.");
        }
        setSession(nextSession);
        setChecking(false);
      },
    );

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setMessage("Account sign-in is unavailable right now. Please try again shortly.");
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      if (mode === "recovery") {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setPassword("");
        setMode("signin");
        setMessage("Password updated. Sign in with your new password.");
        setSession(null);
        return;
      }

      if (mode === "signup") {
        const redirectTo = `${window.location.origin}${window.location.pathname}${window.location.search}`;
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: redirectTo },
        });
        if (error) throw error;
        if (data.session) {
          setSession(data.session);
        } else {
          setMessage("Check your email to confirm your account. The confirmation link will bring you back to Layout.");
        }
        return;
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;
      setSession(data.session);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "We couldn't complete that account request.");
    } finally {
      setBusy(false);
    }
  }

  async function sendPasswordReset() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    if (!email.trim()) {
      setMessage("Enter your email address first.");
      return;
    }

    setBusy(true);
    setMessage("");
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    });
    setMessage(error?.message || "Password reset email sent. Open the link to choose a new password.");
    setBusy(false);
  }

  if (checking) {
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-[#183d32] text-[#f7f4ec]">
        <p className="animate-pulse text-sm font-semibold tracking-wide">Opening Layout…</p>
      </main>
    );
  }

  if (session && mode !== "recovery") return <LayoutShell />;

  const creating = mode === "signup";
  const recovering = mode === "recovery";

  return (
    <main className="min-h-[100dvh] overflow-auto bg-[#f4f5f1] text-[#183d32]">
      <div className="mx-auto grid min-h-[100dvh] max-w-7xl lg:grid-cols-[minmax(0,1fr)_440px]">
        <section className="flex flex-col justify-center px-6 py-10 sm:px-10 lg:px-14 lg:py-14">
          <div className="mb-12 flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-[#183d32] text-[#d6ad67] shadow-sm">
              <Grid2X2 size={22} strokeWidth={2.3} />
            </div>
            <div>
              <div className="text-lg font-black tracking-[0.12em]">LAYOUT</div>
              <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#8a6a33]">A Buildr Suite tool</div>
            </div>
          </div>

          <div className="max-w-3xl">
            <p className="mb-4 text-xs font-extrabold uppercase tracking-[0.2em] text-[#9b7638]">
              Plan the pattern before the first cut
            </p>
            <h1 className="max-w-2xl text-4xl font-black leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
              Get your tile layout right before you set a single tile.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[#53645c] sm:text-lg">
              Draw the room, place walls and openings, and see how tile lands at every edge.
              A little planning up front can make the whole install feel more intentional.
            </p>
          </div>

          <div className="mt-10 grid max-w-3xl gap-3 sm:grid-cols-2">
            {workflow.map(({ step, title, detail, icon: Icon }) => (
              <article key={step} className="rounded-2xl border border-[#dce2dc] bg-white p-5 shadow-[0_8px_24px_rgba(24,61,50,0.045)]">
                <div className="mb-4 flex items-center justify-between">
                  <span className="text-xs font-black tracking-[0.16em] text-[#a47d3e]">{step}</span>
                  <Icon size={19} className="text-[#8a6a33]" aria-hidden="true" />
                </div>
                <h2 className="font-bold">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-[#617168]">{detail}</p>
              </article>
            ))}
          </div>

          <p className="mt-7 flex items-center gap-2 text-sm font-semibold text-[#53645c]">
            <Check size={17} className="text-[#8a6a33]" aria-hidden="true" />
            One account works across Layout, Buildr, and Floorplan.
          </p>
        </section>

        <aside className="flex items-center px-5 pb-10 sm:px-10 lg:px-8 lg:py-14">
          <section className="mx-auto w-full max-w-md rounded-3xl border border-[#e1e5df] bg-white p-6 shadow-[0_24px_70px_rgba(24,61,50,0.12)] sm:p-8">
            <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[#9b7638]">
              {recovering ? "Account recovery" : creating ? "Get started" : "Welcome back"}
            </p>
            <h2 className="mt-2 text-3xl font-black tracking-tight">
              {recovering ? "Choose a new password" : creating ? "Create your free account" : "Sign in to Layout"}
            </h2>
            <p className="mt-3 text-sm leading-6 text-[#617168]">
              {recovering
                ? "Set a new password for the account you use across the Buildr Suite."
                : creating
                  ? "Make one Buildr Suite account, then use the same email and password in Layout, Buildr, and Floorplan."
                  : "Use your existing Buildr Suite email and password to open your saved layouts."}
            </p>

            {!isSupabaseConfigured() ? (
              <p className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                Account sign-in is not configured for this deployment. Please try again later.
              </p>
            ) : (
              <>
                <form className="mt-7 grid gap-4" onSubmit={submit}>
                  <label className="grid gap-2 text-sm font-bold">
                    Email
                    <input
                      className="h-12 rounded-xl border border-[#ccd6d1] bg-white px-3 font-normal outline-none transition focus:border-[#c59a52] focus:ring-4 focus:ring-[#c59a52]/15"
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                  <label className="grid gap-2 text-sm font-bold">
                    Password
                    <input
                      className="h-12 rounded-xl border border-[#ccd6d1] bg-white px-3 font-normal outline-none transition focus:border-[#c59a52] focus:ring-4 focus:ring-[#c59a52]/15"
                      type="password"
                      minLength={8}
                      autoComplete={recovering ? "new-password" : creating ? "new-password" : "current-password"}
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                    {creating && <span className="text-xs font-normal text-[#738078]">Use at least 8 characters.</span>}
                  </label>

                  {message && (
                    <p role="status" className="rounded-xl border border-[#eadcbf] bg-[#fbf7ee] p-3 text-sm leading-5 text-[#5e4a25]">
                      {message}
                    </p>
                  )}

                  <button
                    className="flex h-12 items-center justify-center gap-2 rounded-xl bg-[#183d32] px-4 font-bold text-white transition hover:bg-[#245343] disabled:cursor-wait disabled:opacity-65"
                    type="submit"
                    disabled={busy}
                  >
                    {busy
                      ? "Please wait…"
                      : recovering
                        ? "Save new password"
                        : creating
                          ? "Create account"
                          : "Sign in"}
                    {!busy && !recovering && <ArrowRight size={17} aria-hidden="true" />}
                  </button>
                </form>

                {!recovering && (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
                    {creating ? (
                      <button className="font-semibold text-[#426255] underline-offset-4 hover:underline" type="button" onClick={() => { setMode("signin"); setMessage(""); }}>
                        Already have an account? Sign in
                      </button>
                    ) : (
                      <>
                        <button className="font-semibold text-[#426255] underline-offset-4 hover:underline" type="button" onClick={() => { setMode("signup"); setMessage(""); }}>
                          Create an account
                        </button>
                        <button className="font-semibold text-[#426255] underline-offset-4 hover:underline" type="button" onClick={() => { setMode("recovery"); setMessage(""); }}>
                          Forgot password?
                        </button>
                      </>
                    )}
                  </div>
                )}

                {recovering && (
                  <button className="mt-4 text-sm font-semibold text-[#426255] underline-offset-4 hover:underline" type="button" onClick={() => { setMode("signin"); setMessage(""); }}>
                    Back to sign in
                  </button>
                )}
              </>
            )}

            <p className="mt-7 border-t border-[#e9ede8] pt-5 text-xs leading-5 text-[#718077]">
              Layout drafts save on this device. Sign in to synchronize layouts and continue using the same account in the rest of the Buildr Suite.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
