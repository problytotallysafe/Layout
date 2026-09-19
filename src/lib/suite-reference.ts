import type { SavedLayout } from "@/components/layout-planner";
import { layoutToSuite, suiteToLayout } from "@/lib/suite-exchange";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type ExtendedContext = NonNullable<SavedLayout["suiteContext"]> & {
  suiteDrawingId?: string;
  suiteDrawingRevision?: number;
  sourceEnvelope?: unknown;
  sourceRoomId?: string;
  readOnly?: boolean;
};

export type SuiteReferenceLoad =
  | { ok: true; layout: SavedLayout; remoteRevision: number; readOnly: boolean }
  | { ok: false; authRequired?: boolean; error: string };

export type SuiteReferenceSave =
  | { ok: true; remoteRevision: number }
  | {
      ok: false;
      authRequired?: boolean;
      conflict?: boolean;
      remoteRevision?: number;
      remoteLayout?: SavedLayout;
      error: string;
    };

async function signedInClient() {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { supabase: null, user: null };
  const { data } = await supabase.auth.getSession();
  return { supabase, user: data.session?.user ?? null };
}

export async function loadSuiteDrawingReference(
  drawingId: string,
): Promise<SuiteReferenceLoad> {
  const { supabase, user } = await signedInClient();
  if (!supabase || !user)
    return {
      ok: false,
      authRequired: true,
      error: "Sign in with your Buildr account to open this drawing.",
    };
  const { data, error } = await supabase
    .from("suite_drawings")
    .select("id,current_revision,document,deleted_at")
    .eq("id", drawingId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error)
    return {
      ok: false,
      error: error.message.includes("suite_drawings")
        ? "Shared suite storage is not enabled in this environment yet."
        : error.message,
    };
  if (!data)
    return {
      ok: false,
      error:
        "This drawing was not found or your company account does not have access to it.",
    };
  const imported = suiteToLayout(data.document);
  if (!imported.layout)
    return {
      ok: false,
      error: imported.error || "The shared drawing could not be opened.",
    };
  imported.layout.id = `suite_${data.id}`;
  const context = (imported.layout.suiteContext || {
    organizationId: null,
    buildrProjectId: null,
    importKey: `suite:${drawingId}`,
  }) as ExtendedContext;
  context.suiteDrawingId = data.id;
  context.suiteDrawingRevision = data.current_revision;
  context.readOnly = Boolean(imported.readOnly);
  imported.layout.suiteContext = context;
  return {
    ok: true,
    layout: imported.layout,
    remoteRevision: data.current_revision,
    readOnly: Boolean(imported.readOnly),
  };
}

export async function saveSuiteDrawingReference(
  layout: SavedLayout,
  expectedRemoteRevision: number,
): Promise<SuiteReferenceSave> {
  const context = layout.suiteContext as ExtendedContext | undefined;
  const drawingId = context?.suiteDrawingId;
  if (!drawingId)
    return { ok: false, error: "This Layout is not linked to a suite drawing." };
  if (context?.readOnly)
    return {
      ok: false,
      error: "This newer shared drawing is read-only until Layout is updated.",
    };
  const { supabase, user } = await signedInClient();
  if (!supabase || !user)
    return {
      ok: false,
      authRequired: true,
      error: "Sign in with your Buildr account to synchronize this drawing.",
    };

  const envelope = layoutToSuite(layout);
  const nextSharedRevision = expectedRemoteRevision + 1;
  envelope.source.revision = nextSharedRevision;
  envelope.exportedAt = new Date().toISOString();
  envelope.project.modifiedAt = envelope.exportedAt;
  const mutation = `layout:${drawingId}:${nextSharedRevision}:${crypto.randomUUID()}`;
  const { data, error } = await supabase
    .from("suite_drawings")
    .update({
      schema_version: envelope.schemaVersion,
      document: envelope,
      last_mutation_id: mutation,
      updated_by: user.id,
    })
    .eq("id", drawingId)
    .eq("current_revision", expectedRemoteRevision)
    .select("current_revision")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (data) return { ok: true, remoteRevision: data.current_revision };

  const latest = await supabase
    .from("suite_drawings")
    .select("current_revision,document")
    .eq("id", drawingId)
    .is("deleted_at", null)
    .maybeSingle();
  if (latest.error) return { ok: false, error: latest.error.message };
  if (!latest.data)
    return {
      ok: false,
      error:
        "This drawing was removed or your company account no longer has access.",
    };
  const imported = suiteToLayout(latest.data.document);
  if (imported.layout) {
    imported.layout.id = layout.id;
    const remoteContext = (imported.layout.suiteContext || {
      organizationId: null,
      buildrProjectId: null,
      importKey: `suite:${drawingId}`,
    }) as ExtendedContext;
    remoteContext.suiteDrawingId = drawingId;
    remoteContext.suiteDrawingRevision = latest.data.current_revision;
    remoteContext.readOnly = Boolean(imported.readOnly);
    imported.layout.suiteContext = remoteContext;
  }
  return {
    ok: false,
    conflict: true,
    remoteRevision: latest.data.current_revision,
    remoteLayout: imported.layout,
    error:
      "This layout changed on another device. Choose which version to keep before synchronizing.",
  };
}
