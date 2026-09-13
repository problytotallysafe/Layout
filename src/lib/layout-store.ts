import type { SavedLayout } from "@/components/layout-planner";
import type { LayoutConflict } from "@/lib/layout-sync";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

const DELETION_QUEUE_KEY = "layout-cloud-deletion-queue-v1";

export function pendingCloudDeletions() {
  if (typeof window === "undefined") return [] as string[];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DELETION_QUEUE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch { return [] as string[]; }
}

export function queueCloudDeletion(id: string) {
  const next = [...new Set([...pendingCloudDeletions(), id])];
  window.localStorage.setItem(DELETION_QUEUE_KEY, JSON.stringify(next));
}

async function currentUser() {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

export async function loadCloudLayouts(): Promise<SavedLayout[]> {
  const supabase = getSupabaseBrowserClient(), user = await currentUser();
  if (!supabase || !user) return [];
  const { data, error } = await supabase.from("layout_documents").select("document").is("deleted_at", null).order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: { document: unknown }) => row.document as SavedLayout);
}

export async function saveCloudLayouts(layouts: SavedLayout[]) {
  const supabase = getSupabaseBrowserClient(), user = await currentUser();
  if (!supabase || !user || !layouts.length) return { cloudSaved: false, conflicts: [] as LayoutConflict[] };
  const { data: existing, error: loadError } = await supabase.from("layout_documents").select("id,document").in("id", layouts.map((layout) => layout.id));
  if (loadError) throw loadError;
  const byId = new Map<string, SavedLayout>((existing ?? []).map((row: { id: string; document: unknown }) => [row.id, row.document as SavedLayout]));
  const conflicts: LayoutConflict[] = [];
  const safe = layouts.filter((local) => {
    const cloud = byId.get(local.id);
    if (!cloud) return true;
    if (JSON.stringify(cloud) !== JSON.stringify(local) && cloud.revision >= local.revision) {
      conflicts.push({ id: local.id, local, cloud });
      return false;
    }
    return true;
  });
  if (safe.length) {
    const { error } = await supabase.from("layout_documents").upsert(safe.map((document) => ({
      id: document.id, owner_id: user.id, name: document.projectName, schema_version: "layout.plan.v1", revision: document.revision,
      organization_id: document.suiteContext?.organizationId ?? null, document, updated_at: new Date(document.updatedAt).toISOString(),
    })), { onConflict: "id" });
    if (error) throw error;
  }
  return { cloudSaved: true, conflicts };
}

export async function deleteCloudLayout(id: string) {
  const supabase = getSupabaseBrowserClient(), user = await currentUser();
  if (!supabase || !user) return false;
  const { error } = await supabase.from("layout_documents").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("owner_id", user.id);
  if (error) throw error;
  return true;
}

export async function flushCloudDeletions() {
  const queued = pendingCloudDeletions();
  if (!queued.length) return true;
  const remaining: string[] = [];
  for (const id of queued) {
    try {
      const deleted = await deleteCloudLayout(id);
      if (!deleted) remaining.push(id);
    } catch { remaining.push(id); }
  }
  window.localStorage.setItem(DELETION_QUEUE_KEY, JSON.stringify(remaining));
  return remaining.length === 0;
}
