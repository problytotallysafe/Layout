import type { SavedLayout } from "../components/layout-planner";
import { parseSuiteProject } from "./suite-contract.ts";
import { getSupabaseBrowserClient } from "./supabase/client.ts";

export type BuildrReturnTarget =
  | { kind: "project"; id: string; path: string }
  | {
      kind: "context";
      type: "estimate" | "site_visit" | "customer";
      id: string;
      path: string;
    };

type ExtendedContext = NonNullable<SavedLayout["suiteContext"]> & {
  suiteDrawingId?: string;
  sourceEnvelope?: unknown;
};

function contextPath(type: string, id: string) {
  if (type === "estimate") return `/estimates/${encodeURIComponent(id)}`;
  if (type === "site_visit") return `/site-visits/${encodeURIComponent(id)}`;
  if (type === "customer") return `/customers/${encodeURIComponent(id)}`;
  return null;
}

function sourceFallback(layout: SavedLayout): BuildrReturnTarget | null {
  const context = layout.suiteContext as ExtendedContext | undefined;
  if (context?.buildrProjectId) {
    const id = context.buildrProjectId;
    return { kind: "project", id, path: `/projects/${encodeURIComponent(id)}` };
  }
  if (!context?.sourceEnvelope) return null;
  const parsed = parseSuiteProject(context.sourceEnvelope);
  if (!parsed.ok) return null;
  if (parsed.value.project.buildrProjectId) {
    const id = parsed.value.project.buildrProjectId;
    return { kind: "project", id, path: `/projects/${encodeURIComponent(id)}` };
  }
  const raw = parsed.value.project.extensions?.buildrContext;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const type = String(record.type || "");
  const id = String(record.id || "");
  if (!id || !["estimate", "site_visit", "customer"].includes(type)) return null;
  const path = contextPath(type, id);
  if (!path) return null;
  return {
    kind: "context",
    type: type as "estimate" | "site_visit" | "customer",
    id,
    path,
  };
}

export async function resolveBuildrReturnTarget(
  layout: SavedLayout,
): Promise<BuildrReturnTarget | null> {
  const context = layout.suiteContext as ExtendedContext | undefined;
  const drawingId = context?.suiteDrawingId;
  const fallback = sourceFallback(layout);
  if (!drawingId) return fallback;

  const supabase = getSupabaseBrowserClient();
  if (!supabase) return fallback;
  const session = await supabase.auth.getSession();
  if (!session.data.session?.user) return fallback;

  const drawing = await supabase
    .from("suite_drawings")
    .select("suite_project_id")
    .eq("id", drawingId)
    .is("deleted_at", null)
    .maybeSingle();
  if (drawing.error || !drawing.data?.suite_project_id) return fallback;
  const workspaceId = String(drawing.data.suite_project_id);

  const workspace = await supabase
    .from("suite_projects")
    .select("buildr_project_id")
    .eq("id", workspaceId)
    .is("deleted_at", null)
    .maybeSingle();
  if (workspace.data?.buildr_project_id) {
    const id = String(workspace.data.buildr_project_id);
    return { kind: "project", id, path: `/projects/${encodeURIComponent(id)}` };
  }

  const links = await supabase
    .from("suite_context_links")
    .select("context_type,context_id,created_at")
    .eq("suite_project_id", workspaceId);
  if (links.error) return fallback;
  const priority = new Map([
    ["project", 0],
    ["estimate", 1],
    ["site_visit", 2],
    ["customer", 3],
  ]);
  const selected = [...(links.data || [])]
    .filter((row) => priority.has(String(row.context_type)))
    .sort(
      (a, b) =>
        (priority.get(String(a.context_type)) ?? 99) -
          (priority.get(String(b.context_type)) ?? 99) ||
        new Date(b.created_at || 0).getTime() -
          new Date(a.created_at || 0).getTime(),
    )[0];
  if (!selected) return fallback;
  const type = String(selected.context_type);
  const id = String(selected.context_id);
  if (type === "project") {
    return { kind: "project", id, path: `/projects/${encodeURIComponent(id)}` };
  }
  const path = contextPath(type, id);
  if (!path) return fallback;
  return {
    kind: "context",
    type: type as "estimate" | "site_visit" | "customer",
    id,
    path,
  };
}
