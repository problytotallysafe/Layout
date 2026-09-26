import type { NextConfig } from "next";

const isBuildrStaging =
  process.env.VERCEL_GIT_COMMIT_REF === "staging/paid-pilot-2026-09-26";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  env: isBuildrStaging
    ? {
        NEXT_PUBLIC_SUPABASE_URL: "https://tiaorlqufshpklgevcsr.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_2HYI9YlV7DPMo9Z5aPj9og_FgBBlOjw",
        NEXT_PUBLIC_BUILDR_URL: "https://buildr-git-staging-paid-pilo-6e7ed4-problytotallysafes-projects.vercel.app",
      }
    : {},
};

export default nextConfig;
