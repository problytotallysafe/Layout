"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutPlanner, type SavedLayout } from "@/components/layout-planner";
import { layoutToSuite, suiteLink } from "@/lib/suite-exchange";
import {
  loadSuiteDrawingReference,
  saveSuiteDrawingReference,
  type SuiteReferenceSave,
} from "@/lib/suite-reference";

const LIBRARY_KEY = "layout-library-v1";
const ACTIVE_KEY = "layout-active-id-v1";
const SYNC_KEY = "layout-suite-sync-v1";

type ExtendedContext = NonNullable<SavedLayout["suiteContext"]> & {
  suiteDrawingId?: string;
  suiteDrawingRevision?: number;
  readOnly?: boolean;
};
type SyncMark = { remoteRevision: number; localSignature: string };
type SyncMarks = Record<string, SyncMark>;
type Conflict = Extract<SuiteReferenceSave, { ok: false }> & {
  drawingId: string;
  localLayout: SavedLayout;
};
type NativeWindow = Window & {
  Capacitor?: { isNativePlatform?: () => boolean };
};

function layouts(): SavedLayout[] {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]") as SavedLayout[];
  } catch {
    return [];
  }
}

function activeLayout(): SavedLayout | null {
  const all = layouts();
  const activeId = localStorage.getItem(ACTIVE_KEY);
  return all.find((layout) => layout.id === activeId) || all[0] || null;
}

function writeLayout(layout: SavedLayout) {
  const all = layouts();
  const next = all.some((item) => item.id === layout.id)
    ? all.map((item) => (item.id === layout.id ? layout : item))
    : [layout, ...all];
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(next));
  localStorage.setItem(ACTIVE_KEY, layout.id);
}

function signature(layout: SavedLayout) {
  const normalized = JSON.stringify({
    projectName: layout.projectName,
    room: layout.room,
    items: layout.items,
    tileWidth: layout.tileWidth,
    tileHeight: layout.tileHeight,
    grout: layout.grout,
    materialUnit: layout.materialUnit,
    tileAppearance: layout.tileAppearance,
    wastePercent: layout.wastePercent,
    wallThickness: layout.wallThickness,
    origin: layout.origin,
    rotation: layout.rotation,
    showTile: layout.showTile,
    archivedAt: layout.archivedAt,
  });
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${layout.revision}:${(hash >>> 0).toString(36)}`;
}

function marks(): SyncMarks {
  try {
    return JSON.parse(localStorage.getItem(SYNC_KEY) || "{}") as SyncMarks;
  } catch {
    return {};
  }
}

function markFor(drawingId: string, fallbackRevision = 1): SyncMark {
  return (
    marks()[drawingId] || {
      remoteRevision: fallbackRevision,
      localSignature: "",
    }
  );
}

function writeMark(drawingId: string, mark: SyncMark) {
  const next = marks();
  next[drawingId] = mark;
  localStorage.setItem(SYNC_KEY, JSON.stringify(next));
}

function openBuildrProject(projectId: string, webTarget: string) {
  const native = Boolean(
    (window as NativeWindow).Capacitor?.isNativePlatform?.(),
  );
  if (!native) {
    window.location.href = webTarget;
    return;
  }
  window.location.href = `buildr://project/${encodeURIComponent(projectId)}`;
  window.setTimeout(() => {
    if (document.visibilityState === "visible") window.location.href = webTarget;
  }, 900);
}

const overlayStyle = {
  position: "fixed" as const,
  inset: 0,
  zIndex: 1000,
  background: "rgba(0,0,0,.38)",
  display: "grid",
  placeItems: "center",
  padding: 20,
};
const cardStyle = {
  width: "min(520px, 100%)",
  borderRadius: 16,
  background: "var(--panel, #fff)",
  color: "var(--text, #17231f)",
  padding: 20,
  boxShadow: "0 18px 55px rgba(0,0,0,.25)",
};

export function LayoutShell() {
  const [plannerKey, setPlannerKey] = useState(0);
  const [current, setCurrent] = useState<SavedLayout | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const loadingReference = useRef(false);
  const savingReference = useRef(false);

  const refresh = useCallback(() => setCurrent(activeLayout()), []);

  useEffect(() => {
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 900);
    const authChanged = () => setPlannerKey((value) => value + 1);
    window.addEventListener("buildr:auth-change", authChanged);
    window.addEventListener("storage", refresh);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener("buildr:auth-change", authChanged);
      window.removeEventListener("storage", refresh);
    };
  }, [refresh]);

  useEffect(() => {
    const drawingId = new URLSearchParams(window.location.search).get(
      "suiteDrawing",
    );
    if (!drawingId || loadingReference.current) return;
    loadingReference.current = true;
    setMessage("Opening Buildr drawing…");
    void loadSuiteDrawingReference(drawingId)
      .then((result) => {
        if (!result.ok) {
          setMessage(result.error);
          return;
        }
        writeLayout(result.layout);
        writeMark(drawingId, {
          remoteRevision: result.remoteRevision,
          localSignature: signature(result.layout),
        });
        const url = new URL(window.location.href);
        url.searchParams.delete("suiteDrawing");
        window.history.replaceState(
          null,
          "",
          url.pathname + url.search + url.hash,
        );
        setMessage("Buildr drawing opened");
        setPlannerKey((value) => value + 1);
        refresh();
      })
      .finally(() => {
        loadingReference.current = false;
      });
  }, [plannerKey, refresh]);

  const context = current?.suiteContext as ExtendedContext | undefined;
  const readOnly = Boolean(context?.readOnly);

  const syncNow = useCallback(
    async (layout: SavedLayout, expectedOverride?: number, force = false) => {
      const linked = layout.suiteContext as ExtendedContext | undefined;
      const drawingId = linked?.suiteDrawingId;
      if (!drawingId || linked?.readOnly) return true;
      const mark = markFor(
        drawingId,
        linked.suiteDrawingRevision || 1,
      );
      const currentSignature = signature(layout);
      if (!force && currentSignature === mark.localSignature) return true;
      if (!navigator.onLine) {
        setMessage("Offline · Buildr copy will sync when service returns");
        return false;
      }
      if (savingReference.current) return false;
      savingReference.current = true;
      setSaving(true);
      const result = await saveSuiteDrawingReference(
        layout,
        expectedOverride ?? mark.remoteRevision,
      );
      savingReference.current = false;
      setSaving(false);
      if (result.ok) {
        writeMark(drawingId, {
          remoteRevision: result.remoteRevision,
          localSignature: currentSignature,
        });
        setConflict(null);
        setMessage("Synced to Buildr");
        return true;
      }
      if (result.conflict) {
        setConflict({ ...result, drawingId, localLayout: layout });
      }
      setMessage(result.error);
      return false;
    },
    [],
  );

  useEffect(() => {
    if (!current || !context?.suiteDrawingId || conflict || readOnly) return;
    const timer = window.setTimeout(() => void syncNow(current), 1200);
    return () => window.clearTimeout(timer);
  }, [current, context?.suiteDrawingId, conflict, readOnly, syncNow]);

  useEffect(() => {
    const online = () => {
      const layout = activeLayout();
      const linked = layout?.suiteContext as ExtendedContext | undefined;
      if (layout && linked?.suiteDrawingId) void syncNow(layout);
    };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [syncNow]);

  const returnToBuildr = useCallback(async () => {
    const layout = activeLayout();
    const linked = layout?.suiteContext as ExtendedContext | undefined;
    const projectId = linked?.buildrProjectId;
    if (!layout || !projectId) return;
    const base =
      process.env.NEXT_PUBLIC_BUILDR_URL || "https://buildr-orcin.vercel.app";
    const target = `${base.replace(/\/$/, "")}/projects/${encodeURIComponent(projectId)}`;
    if (linked?.suiteDrawingId) {
      const synced = await syncNow(layout, undefined, true);
      if (!synced) return;
      openBuildrProject(projectId, target);
      return;
    }
    window.location.href = suiteLink(target, layoutToSuite(layout));
  }, [syncNow]);

  // LayoutPlanner predates the secure suite reference shell and still exposes a
  // header return button. Capture that click for linked Buildr drawings so every
  // visible return path saves the protected revision before navigation. A true
  // standalone layout keeps LayoutPlanner's portable suite-link behavior.
  useEffect(() => {
    const intercept = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest(
        'button[aria-label="Return result to Buildr"]',
      );
      const layout = activeLayout();
      const linked = layout?.suiteContext as ExtendedContext | undefined;
      if (!button || !linked?.buildrProjectId || !linked.suiteDrawingId) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void returnToBuildr();
    };
    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, [returnToBuildr]);

  // Printing must not inherit a fixed 240×160 editor viewport. Fit the rendered
  // SVG content to its actual bounds at print time, preserving one uniform scale
  // in both axes. This keeps large Floorplan imports from being cropped and keeps
  // a 10-foot wall visually longer than an 8-foot wall on paper/PDF.
  useEffect(() => {
    let previousViewBox: string | null = null;
    let previousPreserveAspectRatio: string | null = null;
    const beforePrint = () => {
      const svg = document.querySelector<SVGSVGElement>("svg.drawing-canvas");
      if (!svg) return;
      previousViewBox = svg.getAttribute("viewBox");
      previousPreserveAspectRatio = svg.getAttribute("preserveAspectRatio");
      try {
        const box = svg.getBBox();
        const span = Math.max(box.width, box.height, 1);
        const padding = Math.max(6, span * 0.04);
        svg.setAttribute(
          "viewBox",
          `${box.x - padding} ${box.y - padding} ${Math.max(1, box.width + padding * 2)} ${Math.max(1, box.height + padding * 2)}`,
        );
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      } catch {
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      }
    };
    const afterPrint = () => {
      const svg = document.querySelector<SVGSVGElement>("svg.drawing-canvas");
      if (!svg) return;
      if (previousViewBox) svg.setAttribute("viewBox", previousViewBox);
      if (previousPreserveAspectRatio)
        svg.setAttribute("preserveAspectRatio", previousPreserveAspectRatio);
      else svg.removeAttribute("preserveAspectRatio");
    };
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
    };
  }, []);

  const keepCloud = () => {
    if (!conflict?.remoteLayout || conflict.remoteRevision == null) return;
    writeLayout(conflict.remoteLayout);
    writeMark(conflict.drawingId, {
      remoteRevision: conflict.remoteRevision,
      localSignature: signature(conflict.remoteLayout),
    });
    setConflict(null);
    setMessage("Cloud version restored");
    setPlannerKey((value) => value + 1);
    refresh();
  };

  const keepDevice = async () => {
    if (!conflict || conflict.remoteRevision == null) return;
    const ok = await syncNow(
      conflict.localLayout,
      conflict.remoteRevision,
      true,
    );
    if (ok) setMessage("This device version kept as a new revision");
  };

  return (
    <>
      <LayoutPlanner key={plannerKey} />
      {(message || context?.buildrProjectId) && (
        <div
          style={{
            position: "fixed",
            right: 12,
            bottom: 12,
            zIndex: 800,
            display: "flex",
            gap: 8,
            alignItems: "center",
            maxWidth: "calc(100vw - 24px)",
            padding: "6px",
            borderRadius: 14,
            background: "rgba(24,61,50,.94)",
            color: "white",
            fontSize: 12,
            boxShadow: "0 8px 24px rgba(0,0,0,.2)",
          }}
        >
          {message && (
            <span style={{ padding: "0 6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {saving ? "Syncing to Buildr…" : message}
            </span>
          )}
          {context?.buildrProjectId && (
            <button
              type="button"
              onClick={() => void returnToBuildr()}
              disabled={saving}
              style={{ whiteSpace: "nowrap" }}
            >
              Return to Buildr
            </button>
          )}
        </div>
      )}
      {conflict && (
        <div style={overlayStyle}>
          <section style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Layout changed on two devices</h2>
            <p>
              Layout stopped instead of overwriting either copy. Choose which
              version you want to continue with.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={keepCloud} disabled={!conflict.remoteLayout}>
                Use cloud version
              </button>
              <button onClick={() => void keepDevice()} disabled={saving}>
                Keep this device
              </button>
            </div>
          </section>
        </div>
      )}
      {readOnly && !conflict && (
        <div style={overlayStyle}>
          <section style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Newer shared layout</h2>
            <p>
              This drawing was created by a newer suite format. Layout is
              keeping the original record intact and editing is disabled until
              this app is updated.
            </p>
            {context?.buildrProjectId && (
              <button type="button" onClick={() => void returnToBuildr()}>
                Return to Buildr
              </button>
            )}
          </section>
        </div>
      )}
    </>
  );
}
