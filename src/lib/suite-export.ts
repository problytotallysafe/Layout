import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type SuiteSnapshotResult =
  | { ok: true; exportId: string; storagePath: string; revision: number; existing: boolean }
  | { ok: false; error: string };

const STYLE_PROPERTIES = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "vector-effect",
  "visibility",
] as const;

function safeName(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "layout";
}

function inlineComputedStyles(source: SVGSVGElement, clone: SVGSVGElement) {
  const sources = [source, ...Array.from(source.querySelectorAll("*"))];
  const clones = [clone, ...Array.from(clone.querySelectorAll("*"))];
  for (let index = 0; index < Math.min(sources.length, clones.length); index += 1) {
    const computed = getComputedStyle(sources[index] as Element);
    const target = clones[index] as Element;
    for (const property of STYLE_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value) (target as HTMLElement).style.setProperty(property, value);
    }
  }
}

function snapshotBlob(selector: string) {
  const source = document.querySelector<SVGSVGElement>(selector);
  if (!source) throw new Error("The drawing is not available to publish yet.");
  const clone = source.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(source, clone);
  const box = source.getBBox();
  const span = Math.max(box.width, box.height, 1);
  const padding = Math.max(6, span * 0.04);
  const width = Math.max(1, box.width + padding * 2);
  const height = Math.max(1, box.height + padding * 2);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute(
    "viewBox",
    `${box.x - padding} ${box.y - padding} ${width} ${height}`,
  );
  clone.setAttribute("preserveAspectRatio", "xMidYMid meet");
  clone.setAttribute("width", "1600");
  clone.setAttribute("height", String(Math.max(640, Math.round((1600 * height) / width))));
  clone.removeAttribute("onpointerdown");
  clone.removeAttribute("onpointermove");
  clone.removeAttribute("onpointerup");
  const xml = new XMLSerializer().serializeToString(clone);
  return new Blob([xml], { type: "image/svg+xml" });
}

async function checksum(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function publishSuiteSnapshot(
  drawingId: string,
  selector = "svg.drawing-canvas",
): Promise<SuiteSnapshotResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { ok: false, error: "Buildr cloud sync is not configured." };
  const session = await supabase.auth.getSession();
  if (!session.data.session?.user)
    return { ok: false, error: "Sign in with your Buildr account before publishing a snapshot." };

  const drawing = await supabase
    .from("suite_drawings")
    .select("id,organization_id,suite_project_id,room_id,current_revision,title,deleted_at")
    .eq("id", drawingId)
    .is("deleted_at", null)
    .maybeSingle();
  if (drawing.error) return { ok: false, error: drawing.error.message };
  if (!drawing.data)
    return { ok: false, error: "The linked Buildr drawing is no longer available." };

  const existing = await supabase
    .from("suite_exports")
    .select("id,storage_path")
    .eq("organization_id", drawing.data.organization_id)
    .eq("source_drawing_id", drawingId)
    .eq("source_revision", drawing.data.current_revision)
    .eq("export_type", "image")
    .maybeSingle();
  if (existing.error) return { ok: false, error: existing.error.message };
  if (existing.data)
    return {
      ok: true,
      exportId: existing.data.id,
      storagePath: existing.data.storage_path,
      revision: drawing.data.current_revision,
      existing: true,
    };

  const suiteProject = await supabase
    .from("suite_projects")
    .select("buildr_project_id")
    .eq("id", drawing.data.suite_project_id)
    .eq("organization_id", drawing.data.organization_id)
    .maybeSingle();
  if (suiteProject.error) return { ok: false, error: suiteProject.error.message };
  const buildrProjectId = suiteProject.data?.buildr_project_id;
  if (!buildrProjectId)
    return { ok: false, error: "This drawing is not linked to a Buildr project yet." };

  let blob: Blob;
  try {
    blob = snapshotBlob(selector);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not prepare the Layout snapshot.",
    };
  }
  const hash = await checksum(blob);
  const baseName = safeName(String(drawing.data.title || "layout"));
  const fileName = `${baseName}-layout-r${drawing.data.current_revision}.svg`;
  const storagePath = `${drawing.data.organization_id}/${buildrProjectId}/suite/${drawingId}/${fileName}`;
  const upload = await supabase.storage.from("project-media").upload(storagePath, blob, {
    contentType: "image/svg+xml",
    cacheControl: "31536000",
    upsert: true,
  });
  if (upload.error) return { ok: false, error: upload.error.message };

  let projectMediaId: string | null = null;
  const mediaRow = await supabase
    .from("project_media")
    .select("id")
    .eq("organization_id", drawing.data.organization_id)
    .eq("project_id", buildrProjectId)
    .eq("storage_path", storagePath)
    .maybeSingle();
  if (mediaRow.error) return { ok: false, error: mediaRow.error.message };
  projectMediaId = mediaRow.data?.id || null;
  if (!projectMediaId) {
    const insertedMedia = await supabase
      .from("project_media")
      .insert({
        organization_id: drawing.data.organization_id,
        project_id: buildrProjectId,
        storage_path: storagePath,
        file_name: fileName,
        category: "document",
        room_location: drawing.data.title || null,
        caption: `Layout revision ${drawing.data.current_revision}`,
        customer_visible: false,
      })
      .select("id")
      .single();
    if (insertedMedia.error) return { ok: false, error: insertedMedia.error.message };
    projectMediaId = insertedMedia.data.id;
  }

  const inserted = await supabase
    .from("suite_exports")
    .insert({
      organization_id: drawing.data.organization_id,
      suite_project_id: drawing.data.suite_project_id,
      room_id: drawing.data.room_id,
      source_drawing_id: drawingId,
      source_revision: drawing.data.current_revision,
      project_media_id: projectMediaId,
      export_type: "image",
      storage_path: storagePath,
      file_name: fileName,
      mime_type: "image/svg+xml",
      checksum: hash,
    })
    .select("id")
    .single();
  if (inserted.error) {
    const raced = await supabase
      .from("suite_exports")
      .select("id,storage_path")
      .eq("organization_id", drawing.data.organization_id)
      .eq("source_drawing_id", drawingId)
      .eq("source_revision", drawing.data.current_revision)
      .eq("export_type", "image")
      .maybeSingle();
    if (!raced.data) return { ok: false, error: inserted.error.message };
    return {
      ok: true,
      exportId: raced.data.id,
      storagePath: raced.data.storage_path,
      revision: drawing.data.current_revision,
      existing: true,
    };
  }
  return {
    ok: true,
    exportId: inserted.data.id,
    storagePath,
    revision: drawing.data.current_revision,
    existing: false,
  };
}
