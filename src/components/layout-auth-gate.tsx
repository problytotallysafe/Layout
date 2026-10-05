"use client";

import { FormEvent, useEffect, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import {
  ArrowDownRight,
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
    title: "Map the room",
    detail: "Draw the outline. Add walls, doorways, and openings.",
    icon: Ruler,
  },
  {
    step: "02",
    title: "Set the tile",
    detail: "Enter tile and grout sizes to preview the pattern at scale.",
    icon: Grid2X2,
  },
  {
    step: "03",
    title: "Tune the start",
    detail: "Balance edge cuts, compare rotation, and fine-tune the offset.",
    icon: RotateCw,
  },
  {
    step: "04",
    title: "Take it to the job",
    detail: "Save your plan and use one account across Buildr and Floorplan.",
    icon: DoorOpen,
  },
];

function PlanShowcase() {
  return (
    <div className="relative mx-auto w-full max-w-[600px]">
      <div className="absolute -right-2 top-3 z-10 flex items-center gap-2 rounded-full border border-[#d8bd83] bg-[#fffaf0] px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-[#5b4b2b] shadow-lg sm:-right-4 sm:top-8 sm:px-4 sm:text-xs">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-[#c59a52] text-white">
          <Check size={12} strokeWidth={3} />
        </span>
        Cuts balanced
      </div>
      <div className="overflow-hidden rounded-[1.7rem] border border-white/70 bg-[#f3f0e7] p-3 shadow-[0_26px_70px_rgba(3,20,14,0.35)] sm:p-5">
        <div className="mb-3 flex items-center justify-between px-1 sm:mb-4 sm:px-2">
          <div>
            <p className="text-[9px] font-black uppercase tracking-[0.18em] text-[#97763e] sm:text-[10px]">Layout preview</p>
            <p className="mt-1 text-sm font-extrabold text-[#183d32] sm:text-base">Primary bathroom</p>
          </div>
          <div className="rounded-full bg-[#e2e9e2] px-2.5 py-1 text-[9px] font-bold text-[#426255] sm:px-3 sm:text-[10px]">
            FLOOR · 119 SQ FT
          </div>
        </div>

        <svg
          className="block h-auto w-full"
          viewBox="0 0 620 330"
          role="img"
          aria-label="Illustrated bathroom tile plan with a balanced tile grid, vanity, tub, and doorway"
        >
          <defs>
            <clipPath id="layout-room-clip">
              <path d="M112 62 H528 V268 H112 Z" />
            </clipPath>
            <pattern id="layout-paper-dots" width="18" height="18" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="#dbe1d9" />
            </pattern>
          </defs>
          <rect width="620" height="330" rx="22" fill="#fbfaf6" />
          <rect width="620" height="330" rx="22" fill="url(#layout-paper-dots)" opacity=".58" />

          <g stroke="#b9c9bd" strokeWidth="1.35" clipPath="url(#layout-room-clip)">
            <path d="M164 50V278 M216 50V278 M268 50V278 M320 50V278 M372 50V278 M424 50V278 M476 50V278" />
            <path d="M100 114H542 M100 166H542 M100 218H542" />
          </g>
          <path d="M112 62H528V268H112Z" fill="none" stroke="#183d32" strokeWidth="9" strokeLinejoin="round" />

          <g>
            <rect x="132" y="81" width="101" height="55" rx="8" fill="#dce6de" stroke="#52705f" strokeWidth="2" />
            <rect x="143" y="92" width="79" height="33" rx="5" fill="#f8f7f1" stroke="#8fa394" strokeWidth="1.5" />
            <circle cx="182" cy="108.5" r="8" fill="none" stroke="#8fa394" strokeWidth="2" />
            <text x="182" y="151" textAnchor="middle" fontSize="10" fontWeight="800" letterSpacing="1.4" fill="#5c7064">VANITY</text>

            <rect x="379" y="174" width="125" height="73" rx="9" fill="#e7e3d8" stroke="#8c8b7d" strokeWidth="2" />
            <rect x="389" y="184" width="105" height="53" rx="7" fill="#fbfaf6" stroke="#aaa696" strokeWidth="1.5" />
            <path d="M442 190v40M436 210h12" stroke="#aaa696" strokeWidth="1.5" />
            <text x="442" y="260" textAnchor="middle" fontSize="10" fontWeight="800" letterSpacing="1.4" fill="#6e6b5f">TUB</text>
          </g>

          <path d="M320 62V268" stroke="#c59a52" strokeWidth="3.5" strokeDasharray="7 6" />
          <circle cx="320" cy="62" r="6" fill="#c59a52" stroke="#fffaf0" strokeWidth="3" />
          <path d="M381 268h74" stroke="#fbfaf6" strokeWidth="12" />
          <path d="M381 268a74 74 0 0 1 74 74" fill="none" stroke="#8a9b8f" strokeWidth="2" strokeDasharray="5 5" />
          <path d="M381 268v-74" stroke="#52705f" strokeWidth="3" />
          <circle cx="381" cy="268" r="4" fill="#c59a52" />

          <path d="M112 38h416" stroke="#8a9b8f" strokeWidth="1.5" />
          <path d="M112 33v10M528 33v10" stroke="#8a9b8f" strokeWidth="1.5" />
          <rect x="271" y="25" width="98" height="25" rx="12.5" fill="#fbfaf6" />
          <text x="320" y="42" textAnchor="middle" fontSize="11" fontWeight="800" fill="#51665a">12′ 4″</text>

          <rect x="258" y="276" width="124" height="27" rx="13.5" fill="#183d32" />
          <text x="320" y="294" textAnchor="middle" fontSize="10" fontWeight="800" letterSpacing="1.1" fill="#f9f5e9">START LINE</text>
        </svg>

        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[#e3e5dc] pt-3 sm:mt-4 sm:gap-3 sm:pt-4">
          <div>
            <p className="text-[8px] font-bold uppercase tracking-[0.12em] text-[#7d8a80] sm:text-[9px]">Grout</p>
            <p className="mt-1 text-[11px] font-extrabold text-[#183d32] sm:text-xs">⅛ in</p>
          </div>
          <div>
            <p className="text-[8px] font-bold uppercase tracking-[0.12em] text-[#7d8a80] sm:text-[9px]">Starting point</p>
            <p className="mt-1 text-[11px] font-extrabold text-[#183d32] sm:text-xs">Balanced</p>
          </div>
          <div>
            <p className="text-[8px] font-bold uppercase tracking-[0.12em] text-[#7d8a80] sm:text-[9px]">Plan status</p>
            <p className="mt-1 flex items-center gap-1 text-[11px] font-extrabold text-[#486b53] sm:text-xs">
              <span className="h-1.5 w-1.5 rounded-full bg-[#769a69]" /> Ready to review
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

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
    void supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
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
    <main className="min-h-[100dvh] overflow-auto bg-[#183d32] text-[#183d32]">
      <div className="mx-auto grid min-h-[100dvh] max-w-[1480px] lg:grid-cols-[minmax(0,1fr)_440px]">
        <section className="flex flex-col justify-center px-5 py-8 sm:px-9 sm:py-10 xl:px-14">
          <div className="mb-8 flex items-center gap-3 sm:mb-10">
            <div className="grid h-11 w-11 place-items-center rounded-xl border border-white/15 bg-white/10 text-[#e3bd72]">
              <Grid2X2 size={22} strokeWidth={2.3} />
            </div>
            <div>
              <div className="text-lg font-black tracking-[0.12em] text-white">LAYOUT</div>
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#d6ad67]">A Buildr Suite tool</div>
            </div>
          </div>

          <div className="grid items-center gap-8 xl:grid-cols-[minmax(250px,.82fr)_minmax(350px,1.18fr)] xl:gap-9">
            <div className="max-w-xl">
              <p className="mb-4 flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.19em] text-[#e3bd72] sm:text-xs">
                <span className="h-px w-6 bg-[#c59a52]" />
                Plan the pattern before the first cut
              </p>
              <h1 className="max-w-xl text-4xl font-black leading-[1.04] tracking-tight text-[#fffdf7] sm:text-5xl xl:text-[3.5rem]">
                Make the first cut with a plan.
              </h1>
              <p className="mt-5 max-w-lg text-sm leading-6 text-[#d0dbd1] sm:text-base sm:leading-7">
                See how tile lands at the walls, around openings, and across the whole room—before the thinset is mixed.
              </p>
              <div className="mt-6 hidden items-center gap-2 text-xs font-bold text-[#e8d7ac] sm:flex">
                <ArrowDownRight size={15} />
                From room sketch to a layout you can take to the job
              </div>
            </div>

            <PlanShowcase />
          </div>

          <div className="mt-9 sm:mt-11">
            <div className="mb-3 flex items-center gap-3">
              <p className="text-[10px] font-extrabold uppercase tracking-[0.19em] text-[#d6ad67]">A simple four-step workflow</p>
              <div className="h-px flex-1 bg-white/15" />
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {workflow.map(({ step, title, detail, icon: Icon }) => (
                <article key={step} className="rounded-2xl border border-white/10 bg-white/[0.055] p-3.5 sm:p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black tracking-[0.16em] text-[#d6ad67]">{step}</span>
                    <Icon size={16} className="text-[#e3bd72]" aria-hidden="true" />
                  </div>
                  <h2 className="mt-2 text-sm font-bold text-white">{title}</h2>
                  <p className="mt-1.5 text-[11px] leading-5 text-[#c1d0c4]">{detail}</p>
                </article>
              ))}
            </div>
          </div>

          <p className="mt-5 flex items-center gap-2 text-xs font-semibold text-[#cfdbd0] sm:text-sm">
            <Check size={16} className="text-[#e3bd72]" aria-hidden="true" />
            One account works across Layout, Buildr, and Floorplan.
          </p>
        </section>

        <aside className="flex items-center bg-[#f3f3ed] px-4 py-7 sm:px-8 sm:py-10 lg:px-7 lg:py-14">
          <section className="mx-auto w-full max-w-md rounded-[1.8rem] border border-[#e1e5df] bg-white p-6 shadow-[0_24px_70px_rgba(24,61,50,0.14)] sm:p-8">
            <div className="mb-5 flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#edf2ed] text-[#183d32]">
                <Grid2X2 size={19} />
              </div>
              <span className="text-[10px] font-extrabold uppercase tracking-[0.17em] text-[#97763e]">Buildr Suite account</span>
            </div>
            <h2 className="text-3xl font-black tracking-tight text-[#183d32]">
              {recovering ? "Choose a new password" : creating ? "Start planning for free" : "Welcome back"}
            </h2>
            <p className="mt-3 text-sm leading-6 text-[#617168]">
              {recovering
                ? "Set a new password for the account you use across the Buildr Suite."
                : creating
                  ? "Create one account for Layout, Buildr, and Floorplan. No separate tool logins to keep track of."
                  : "Use your existing Buildr Suite email and password to open your saved layouts."}
            </p>

            {!isSupabaseConfigured() ? (
              <p className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                Account sign-in is not configured for this deployment. Please try again later.
              </p>
            ) : (
              <>
                <form className="mt-7 grid gap-4" onSubmit={submit}>
                  <label className="grid gap-2 text-sm font-bold text-[#273d32]">
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
                  <label className="grid gap-2 text-sm font-bold text-[#273d32]">
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
                          ? "Create my account"
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
              Your layouts stay connected to your account, so you can pick up the plan in the Buildr Suite.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
