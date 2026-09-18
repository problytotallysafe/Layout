"use client";

import {
  Archive, ArchiveRestore, BrickWall, Check, ChevronDown, CloudOff, Copy, DoorOpen, FolderOpen, Grid3X3, Hand, MousePointer2, Move,
  PencilRuler, Plus, Printer, Redo2, RotateCw, Save, Sparkles, SquareDashedMousePointer, Trash2, Undo2, X, Download, Upload, ExternalLink,
  ZoomIn, ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeSuiteHash, downloadSuite, layoutToSuite, suiteLink, suiteToLayout } from "@/lib/suite-exchange";
import { mergeLayouts, type LayoutConflict } from "@/lib/layout-sync";
import { flushCloudDeletions, loadCloudLayouts, pendingCloudDeletions, queueCloudDeletion, saveCloudLayouts } from "@/lib/layout-store";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { SuiteAccountButton } from "@/components/suite-account";
import {
  constrainPointToPolygon,
  constrainPointToPolygonInset,
  constrainSegmentToPolygonInset,
  constrainSegmentTranslationToPolygonInset,
  endpointAtAngle,
  horizontalPolygonSpanAtY,
  nearestGridIntersectionInsidePolygon,
  nearestSnapPoint,
  roundToIncrement,
  segmentAngleDegrees,
  snapToCommonAngle,
  verticalPolygonSpanAtX,
} from "@/lib/layout-geometry";
import {
  assessObstacleCuts,
  assessPolygonLayout,
  optimizePolygonLayout,
  type CutObstacle,
} from "@/lib/layout-engine";
import { formatInchesInput, formatLength, parseLength } from "@/lib/layout-measurements";
import {
  attachOpeningToNearestHost,
  moveHostedOpening,
  removeItemWithDependents,
  reflowRoomHostedOpenings,
  reflowWallHostedOpenings,
} from "@/lib/layout-hosting";

export type Point = { x: number; y: number };
export type DrawItem = {
  id: string;
  type: "wall" | "opening";
  start: Point;
  end: Point;
  thickness: number;
  hostId?: string;
  hostEdgeIndex?: number;
  hostT?: number;
};
type Tool = "select" | "pan" | "floor" | "room" | "wall" | "opening";
type MaterialUnit = "in" | "mm" | "cm";
type MaterialType = "tile" | "plank";
type TileAppearance = "transparent" | "porcelain" | "stone" | "marble" | "concrete" | "wood";
type LayoutPattern = "straight" | "half-offset" | "third-offset";
type DragState =
  | { kind: "draw"; start: Point; current: Point }
  | { kind: "room-tap"; start: Point; current: Point }
  | { kind: "endpoint"; id: string; endpoint: "start" | "end" }
  | { kind: "item"; id: string; anchor: Point; originalStart: Point; originalEnd: Point }
  | { kind: "pan"; clientX: number; clientY: number; origin: Point }
  | { kind: "tile"; anchor: Point; originalOrigin: Point }
  | null;
type Snapshot = {
  room: Point[];
  items: DrawItem[];
  tileWidth: number;
  tileHeight: number;
  grout: number;
  materialUnit: MaterialUnit;
  materialType: MaterialType;
  tileAppearance: TileAppearance;
  pattern: LayoutPattern;
  wastePercent: number;
  wallThickness: number;
  origin: Point;
  rotation: 0 | 90;
  showTile: boolean;
  snapEnabled: boolean;
};
type PinchState = { distance: number; zoom: number; canvasCenter: Point };
export type LayoutData = Snapshot & {
  projectName: string;
  roomName?: string;
  tileWidth: number;
  tileHeight: number;
  grout: number;
  materialUnit: MaterialUnit;
  tileAppearance: TileAppearance;
  wastePercent: number;
  wallThickness: number;
  origin: Point;
  rotation: 0 | 90;
  showTile: boolean;
  snapEnabled: boolean;
  notes?: string;
  archivedAt?: number;
  suiteContext?: { organizationId: string | null; buildrProjectId: string | null; importKey: string };
};
export type SavedLayout = LayoutData & { id: string; revision: number; updatedAt: number };
type SyncState = "device" | "saving" | "saved" | "offline" | "failed" | "conflict";

const VIEW_W = 240;
const VIEW_H = 160;
const LIBRARY_KEY = "layout-library-v1";
const ACTIVE_LAYOUT_KEY = "layout-active-id-v1";
const LEGACY_DRAFT_KEY = "layout-draft-v1";
const DEFAULT_ROOM: Point[] = [
  { x: 48, y: 20 }, { x: 192, y: 20 }, { x: 192, y: 140 }, { x: 48, y: 140 },
];
const uid = () => `layout_${crypto.randomUUID()}`;
const blankLayout = (id = uid(), projectName = "Untitled layout"): SavedLayout => ({
  id,
  revision: 1,
  updatedAt: Date.now(),
  projectName,
  roomName: "Room 1",
  room: DEFAULT_ROOM.map((point) => ({ ...point })),
  items: [],
  tileWidth: 12,
  tileHeight: 24,
  grout: 0.125,
  materialUnit: "in",
  materialType: "tile",
  tileAppearance: "transparent",
  pattern: "straight",
  wastePercent: 10,
  wallThickness: 4.5,
  origin: { x: 0, y: 0 },
  rotation: 0,
  showTile: true,
  snapEnabled: true,
  notes: "",
});
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const displayUnit = (inches: number, unit: MaterialUnit) => unit === "in" ? inches : unit === "mm" ? inches * 25.4 : inches * 2.54;
const inchesFromUnit = (value: number, unit: MaterialUnit) => unit === "in" ? value : unit === "mm" ? value / 25.4 : value / 2.54;
const polygonArea = (points: Point[]) => Math.abs(points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length];
  return sum + point.x * next.y - next.x * point.y;
}, 0)) / 2;
const polygonCenter = (points: Point[]) => ({
  x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
  y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
});
const outsideDimensionPoint = (start: Point, end: Point, center: Point): Point => {
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const dx = midpoint.x - center.x;
  const dy = midpoint.y - center.y;
  const magnitude = Math.hypot(dx, dy) || 1;
  return {
    x: clamp(midpoint.x + dx / magnitude * 8, 12, VIEW_W - 12),
    y: clamp(midpoint.y + dy / magnitude * 8, 5, VIEW_H - 5),
  };
};
const roomBounds = (room: Point[]) => {
  const xs = room.map((point) => point.x);
  const ys = room.map((point) => point.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};
type Bounds = ReturnType<typeof roomBounds>;
const clampWallPoint = (point: Point, thickness: number, bounds: Bounds): Point => {
  const halfThickness = thickness / 2;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const minX = Math.min(bounds.minX + halfThickness, centerX);
  const maxX = Math.max(bounds.maxX - halfThickness, centerX);
  const minY = Math.min(bounds.minY + halfThickness, centerY);
  const maxY = Math.max(bounds.maxY - halfThickness, centerY);
  return { x: clamp(point.x, minX, maxX), y: clamp(point.y, minY, maxY) };
};
const constrainWallToBounds = (item: DrawItem, bounds: Bounds): DrawItem => item.type === "wall" ? {
  ...item,
  start: clampWallPoint(item.start, item.thickness, bounds),
  end: clampWallPoint(item.end, item.thickness, bounds),
} : item;
const constrainWallPointToRoom = (point: Point, thickness: number, room: Point[], bounds: Bounds) =>
  constrainPointToPolygonInset(
    clampWallPoint(constrainPointToPolygon(point, room), thickness, bounds),
    room,
    thickness / 2,
  );
const constrainWallToRoom = (item: DrawItem, room: Point[], bounds: Bounds): DrawItem => {
  if (item.type !== "wall") return item;
  const bounded = constrainWallToBounds(item, bounds);
  const segment = constrainSegmentToPolygonInset(
    bounded.start,
    bounded.end,
    room,
    bounded.thickness / 2,
  );
  return { ...bounded, start: segment.start, end: segment.end };
};
const constrainWallTranslation = (item: DrawItem, dx: number, dy: number, bounds: Bounds) => {
  if (item.type !== "wall") return { dx, dy };
  const halfThickness = item.thickness / 2;
  const minDx = bounds.minX + halfThickness - Math.min(item.start.x, item.end.x);
  const maxDx = bounds.maxX - halfThickness - Math.max(item.start.x, item.end.x);
  const minDy = bounds.minY + halfThickness - Math.min(item.start.y, item.end.y);
  const maxDy = bounds.maxY - halfThickness - Math.max(item.start.y, item.end.y);
  return { dx: clamp(dx, minDx, maxDx), dy: clamp(dy, minDy, maxDy) };
};
const constrainWallTranslationToRoom = (item: DrawItem, dx: number, dy: number, room: Point[], bounds: Bounds) => {
  const bounded = constrainWallTranslation(item, dx, dy, bounds);
  return item.type === "wall"
    ? constrainSegmentTranslationToPolygonInset(item.start, item.end, bounded.dx, bounded.dy, room, item.thickness / 2)
    : bounded;
};
const reconcileItemsWithRoom = (items: DrawItem[], nextRoom: Point[]) => {
  const nextBounds = roomBounds(nextRoom);
  let next = items.map((item) => item.type === "wall" ? constrainWallToRoom(item, nextRoom, nextBounds) : item);
  next.filter((item) => item.type === "wall").forEach((wall) => {
    next = reflowWallHostedOpenings(next, wall.id, wall);
  });
  return reflowRoomHostedOpenings(next, nextRoom);
};
const isRectangle = (room: Point[]) => room.length === 4 && room.every((point, index) => {
  const next = room[(index + 1) % room.length];
  return point.x === next.x || point.y === next.y;
});

function NumberField({ label, value, onChange, suffix, min = 0, step = 1, disabled = false }: {
  label: string; value: number; onChange: (value: number) => void; suffix: string; min?: number; step?: number; disabled?: boolean;
}) {
  const fractionalInches = suffix === "in";
  const displayValue = fractionalInches
    ? formatInchesInput(value)
    : Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
  const commit = (input: HTMLInputElement) => {
    if (disabled) return;
    const parsed = fractionalInches ? parseLength(input.value) : Number(input.value);
    if (parsed == null || !Number.isFinite(parsed) || parsed < min) {
      input.value = displayValue;
      return;
    }
    const next = Math.max(min, parsed);
    input.value = fractionalInches ? formatInchesInput(next) : String(Number(next.toFixed(3)));
    if (Math.abs(next - value) > 0.0005) onChange(next);
  };

  return (
    <label className="field">
      <span>{label}</span>
      <span className="number-input">
        <input
          key={`${label}-${displayValue}-${disabled ? "disabled" : "editable"}`}
          aria-label={label}
          min={min}
          step={step}
          type={fractionalInches ? "text" : "number"}
          disabled={disabled}
          defaultValue={displayValue}
          inputMode={fractionalInches ? "text" : "decimal"}
          autoComplete="off"
          onBlur={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = displayValue;
              event.currentTarget.blur();
            }
          }}
        />
        <small>{suffix}</small>
      </span>
    </label>
  );
}

function OffsetField({ inches, label, onCommit }: { inches: number; label: string; onCommit: (inches: number) => void }) {
  const rounded = Math.max(0, Math.round(inches * 8) / 8);
  return (
    <label className="field offset-field">
      <span>{label}</span>
      <span className="number-input">
        <input
          key={`${label}-${rounded}`}
          aria-label={label}
          defaultValue={formatLength(rounded)}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          onBlur={(event) => {
            const parsed = parseLength(event.currentTarget.value);
            if (parsed !== null && parsed >= 0) onCommit(parsed);
            else event.currentTarget.value = formatLength(rounded);
          }}
        />
      </span>
    </label>
  );
}

function LengthField({ label, value, onChange, min = 0, disabled = false }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  disabled?: boolean;
}) {
  const rounded = Math.round(value * 8) / 8;
  const displayValue = formatLength(rounded);
  const commit = (input: HTMLInputElement) => {
    if (disabled) return;
    const parsed = parseLength(input.value);
    if (parsed == null || parsed < min) {
      input.value = displayValue;
      return;
    }
    const next = Math.round(parsed * 8) / 8;
    input.value = formatLength(next);
    if (Math.abs(next - value) > 0.0005) onChange(next);
  };

  return (
    <label className="field">
      <span>{label}</span>
      <span className="number-input">
        <input
          key={`${label}-${rounded}-${disabled ? "disabled" : "editable"}`}
          aria-label={label}
          disabled={disabled}
          defaultValue={displayValue}
          inputMode="text"
          autoComplete="off"
          onBlur={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = displayValue;
              event.currentTarget.blur();
            }
          }}
        />
      </span>
    </label>
  );
}

function WallOffsetLabel({ x, y, inches, side }: { x: number; y: number; inches: number; side: "left" | "right" | "top" | "bottom" }) {
  return (
    <g className="wall-offset-label" transform={`translate(${x} ${y})`}>
      <rect x="-17" y="-3.4" width="34" height="6.8" rx="2" />
      <text y="1.25">{formatLength(inches)} from {side}</text>
    </g>
  );
}

function mortarRecommendation(tileWidth: number, tileHeight: number) {
  const longest = Math.max(tileWidth, tileHeight);
  if (longest <= 2) return { trowel: "3/16″ V-notch", coverage: 90 };
  if (longest <= 6) return { trowel: "1/4″ × 1/4″ square-notch", coverage: 70 };
  if (longest <= 15) return { trowel: "1/4″ × 3/8″ square-notch", coverage: 55 };
  if (longest <= 24) return { trowel: "1/2″ × 1/2″ square-notch", coverage: 40 };
  return { trowel: "1/2″ × 1/2″ or larger", coverage: 32 };
}

export function LayoutPlanner() {
  const [projectName, setProjectName] = useState("Untitled layout");
  const [roomName, setRoomName] = useState("Room 1");
  const [room, setRoom] = useState<Point[]>(DEFAULT_ROOM);
  const [draftRoom, setDraftRoom] = useState<Point[]>([]);
  const [items, setItems] = useState<DrawItem[]>([
    { id: "sample-wall", type: "wall", start: { x: 101, y: 20 }, end: { x: 101, y: 58 }, thickness: 4.5 },
    { id: "sample-opening", type: "opening", start: { x: 48, y: 62 }, end: { x: 48, y: 98 }, thickness: 4.5 },
  ]);
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRoomEdge, setSelectedRoomEdge] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [tileWidth, setTileWidth] = useState(12);
  const [tileHeight, setTileHeight] = useState(24);
  const [grout, setGrout] = useState(0.125);
  const [materialUnit, setMaterialUnit] = useState<MaterialUnit>("in");
  const [materialType, setMaterialType] = useState<MaterialType>("tile");
  const [tileAppearance, setTileAppearance] = useState<TileAppearance>("transparent");
  const [pattern, setPattern] = useState<LayoutPattern>("straight");
  const [wastePercent, setWastePercent] = useState(10);
  const [wallThickness, setWallThickness] = useState(4.5);
  const [origin, setOrigin] = useState<Point>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState<0 | 90>(0);
  const [showTile, setShowTile] = useState(true);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [notes, setNotes] = useState("");
  const [optimizationMessage, setOptimizationMessage] = useState<string | null>(null);
  const [suiteContext, setSuiteContext] = useState<LayoutData["suiteContext"]>();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [saved, setSaved] = useState(true);
  const [deviceSaveFailed, setDeviceSaveFailed] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("device");
  const [conflicts, setConflicts] = useState<LayoutConflict[]>([]);
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null);
  const [savedLayouts, setSavedLayouts] = useState<SavedLayout[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [cloudHydrated, setCloudHydrated] = useState(false);
  const [authVersion, setAuthVersion] = useState(0);
  const [printing, setPrinting] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  const savedLayoutsRef = useRef<SavedLayout[]>([]);
  const touchPointsRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<PinchState | null>(null);
  const pinchPointerIdsRef = useRef(new Set<number>());
  const importInputRef = useRef<HTMLInputElement>(null);
  const deepLinkHandledRef = useRef(false);

  useEffect(() => {
    const changed = () => {
      setCloudHydrated(false);
      setAuthVersion((value) => value + 1);
    };
    window.addEventListener("buildr:auth-change", changed);
    return () => window.removeEventListener("buildr:auth-change", changed);
  }, []);

  const bounds = useMemo(() => roomBounds(room), [room]);
  const actualTileW = rotation === 0 ? tileWidth : tileHeight;
  const actualTileH = rotation === 0 ? tileHeight : tileWidth;
  const pitchX = actualTileW + grout;
  const pitchY = actualTileH + grout;
  const patternRows = pattern === "half-offset" ? 2 : pattern === "third-offset" ? 3 : 1;
  const patternPhasesX = useMemo(
    () => Array.from({ length: patternRows }, (_, index) => index * pitchX / patternRows),
    [patternRows, pitchX],
  );
  const roomWidth = bounds.maxX - bounds.minX;
  const roomHeight = bounds.maxY - bounds.minY;
  const areaSqFt = polygonArea(room) / 144;
  const tileSqFt = (tileWidth * tileHeight) / 144;
  const wasteMultiplier = 1 + wastePercent / 100;
  const tileCount = tileSqFt ? Math.ceil((areaSqFt / tileSqFt) * wasteMultiplier) : 0;
  const mortar = mortarRecommendation(tileWidth, tileHeight);
  const mortarBags = Math.max(1, Math.ceil((areaSqFt * wasteMultiplier) / mortar.coverage));
  const { xObstacles, yObstacles } = useMemo(() => {
    const nextX: CutObstacle[] = [];
    const nextY: CutObstacle[] = [];
    const addBoth = (target: CutObstacle[], coordinate: number) => {
      target.push({ coordinate, side: "before" }, { coordinate, side: "after" });
    };
    items.forEach((item) => {
      const horizontal = Math.abs(item.end.x - item.start.x) >= Math.abs(item.end.y - item.start.y);
      if (item.type === "wall") {
        if (horizontal) {
          const center = (item.start.y + item.end.y) / 2 - bounds.minY;
          nextY.push(
            { coordinate: center - item.thickness / 2, side: "before" },
            { coordinate: center + item.thickness / 2, side: "after" },
          );
          addBoth(nextX, item.start.x - bounds.minX);
          addBoth(nextX, item.end.x - bounds.minX);
        } else {
          const center = (item.start.x + item.end.x) / 2 - bounds.minX;
          nextX.push(
            { coordinate: center - item.thickness / 2, side: "before" },
            { coordinate: center + item.thickness / 2, side: "after" },
          );
          addBoth(nextY, item.start.y - bounds.minY);
          addBoth(nextY, item.end.y - bounds.minY);
        }
      } else if (horizontal) {
        addBoth(nextX, item.start.x - bounds.minX);
        addBoth(nextX, item.end.x - bounds.minX);
      } else {
        addBoth(nextY, item.start.y - bounds.minY);
        addBoth(nextY, item.end.y - bounds.minY);
      }
    });
    return {
      xObstacles: nextX.filter(({ coordinate }) => coordinate > 0 && coordinate < roomWidth),
      yObstacles: nextY.filter(({ coordinate }) => coordinate > 0 && coordinate < roomHeight),
    };
  }, [items, bounds.minX, bounds.minY, roomWidth, roomHeight]);
  const currentXObstacleCut = useMemo(
    () => assessObstacleCuts(actualTileW, grout, origin.x, xObstacles, patternPhasesX),
    [actualTileW, grout, origin.x, patternPhasesX, xObstacles],
  );
  const currentYObstacleCut = useMemo(
    () => assessObstacleCuts(actualTileH, grout, origin.y, yObstacles),
    [actualTileH, grout, origin.y, yObstacles],
  );
  const currentPolygonCuts = useMemo(
    () => assessPolygonLayout(
      room,
      actualTileW,
      actualTileH,
      grout,
      { x: bounds.minX + origin.x, y: bounds.minY + origin.y },
      patternRows,
    ),
    [actualTileH, actualTileW, bounds.minX, bounds.minY, grout, origin.x, origin.y, patternRows, room],
  );
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const selectedOpeningHosted = Boolean(selected?.type === "opening" && (selected.hostId || selected.hostEdgeIndex != null));
  const selectedEdgeStart = selectedRoomEdge == null ? null : room[selectedRoomEdge] ?? null;
  const selectedEdgeEnd = selectedRoomEdge == null ? null : room[(selectedRoomEdge + 1) % room.length] ?? null;
  const dimensionedWall = tool === "select" && selected?.type === "wall" ? selected : null;
  const minimumCut = Math.min(
    currentXObstacleCut,
    currentYObstacleCut,
    currentPolygonCuts.minimumBoundaryCut,
  );
  const cutWarning = minimumCut < Math.min(actualTileW, actualTileH) / 2;
  const hasAngledBoundary = room.some((point, index) => {
    const next = room[(index + 1) % room.length];
    return Math.abs(next.x - point.x) > 0.001 && Math.abs(next.y - point.y) > 0.001;
  });
  const layoutNeedsReview = cutWarning;

  const currentSnapshot = useCallback((): Snapshot => ({
    room,
    items,
    tileWidth,
    tileHeight,
    grout,
    materialUnit,
    materialType,
    tileAppearance,
    pattern,
    wastePercent,
    wallThickness,
    origin,
    rotation,
    showTile,
    snapEnabled,
  }), [grout, items, materialType, materialUnit, origin, pattern, room, rotation, showTile, snapEnabled, tileAppearance, tileHeight, tileWidth, wallThickness, wastePercent]);

  const snapshot = useCallback(() => {
    setHistory((current) => [...current.slice(-29), currentSnapshot()]);
    setFuture([]);
    setOptimizationMessage(null);
    setSaved(false);
  }, [currentSnapshot]);

  const restoreSnapshot = useCallback((state: Snapshot) => {
    setRoom(state.room);
    setItems(state.items);
    setTileWidth(state.tileWidth);
    setTileHeight(state.tileHeight);
    setGrout(state.grout);
    setMaterialUnit(state.materialUnit);
    setMaterialType(state.materialType);
    setTileAppearance(state.tileAppearance);
    setPattern(state.pattern);
    setWastePercent(state.wastePercent);
    setWallThickness(state.wallThickness);
    setOrigin(state.origin);
    setRotation(state.rotation);
    setShowTile(state.showTile);
    setSnapEnabled(state.snapEnabled);
    setSelectedId(null);
    setDrag(null);
    setSaved(false);
  }, []);

  const applyLayout = useCallback((layout: SavedLayout) => {
    setProjectName(layout.projectName);
    setRoomName(layout.roomName || "Room 1");
    setRoom(layout.room);
    setItems(reconcileItemsWithRoom(layout.items, layout.room));
    setTileWidth(layout.tileWidth);
    setTileHeight(layout.tileHeight);
    setGrout(layout.grout);
    setMaterialUnit(layout.materialUnit);
    setMaterialType(layout.materialType || "tile");
    setTileAppearance(layout.tileAppearance);
    setPattern(layout.pattern || "straight");
    setWastePercent(layout.wastePercent);
    setWallThickness(layout.wallThickness);
    setOrigin(layout.origin);
    setRotation(layout.rotation);
    setShowTile(layout.showTile);
    setSnapEnabled(layout.snapEnabled !== false);
    setNotes(layout.notes || "");
    setSuiteContext(layout.suiteContext);
    setSelectedId(null);
    setSelectedRoomEdge(null);
    setDraftRoom([]);
    setTool("select");
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setHistory([]);
    setFuture([]);
  }, []);

  const persistLibrary = useCallback((layouts: SavedLayout[], activeId: string) => {
    savedLayoutsRef.current = layouts;
    setSavedLayouts(layouts);
    try {
      window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(layouts));
      window.localStorage.setItem(ACTIVE_LAYOUT_KEY, activeId);
      window.dispatchEvent(new CustomEvent("buildr:layout-saved", { detail: { activeId } }));
      setDeviceSaveFailed(false);
      return true;
    } catch {
      setDeviceSaveFailed(true);
      setSaved(false);
      return false;
    }
  }, []);

  const saveCurrentLayout = useCallback(() => {
    if (!activeLayoutId) return null;
    const existing = savedLayoutsRef.current.find((layout) => layout.id === activeLayoutId);
    const document: SavedLayout = {
      id: activeLayoutId,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      projectName: projectName.trim() || "Untitled layout",
      roomName: roomName.trim() || "Room 1",
      room,
      items,
      tileWidth,
      tileHeight,
      grout,
      materialUnit,
      materialType,
      tileAppearance,
      pattern,
      wastePercent,
      wallThickness,
      origin,
      rotation,
      showTile,
      snapEnabled,
      notes,
      suiteContext,
    };
    const existingIndex = savedLayoutsRef.current.findIndex((layout) => layout.id === activeLayoutId);
    const next = existingIndex >= 0
      ? savedLayoutsRef.current.map((layout) => layout.id === activeLayoutId ? document : layout)
      : [document, ...savedLayoutsRef.current];
    if (!persistLibrary(next, activeLayoutId)) return null;
    try {
      window.localStorage.setItem(LEGACY_DRAFT_KEY, JSON.stringify(document));
    } catch {
      // The primary library write succeeded; the legacy recovery copy is best-effort only.
    }
    setSaved(true);
    return document;
  }, [activeLayoutId, grout, items, materialType, materialUnit, notes, origin, pattern, persistLibrary, projectName, room, roomName, rotation, showTile, snapEnabled, suiteContext, tileAppearance, tileHeight, tileWidth, wallThickness, wastePercent]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      let recoveryRaw: string | null = null;
      try {
        const storedLibrary = window.localStorage.getItem(LIBRARY_KEY);
        recoveryRaw = storedLibrary;
        const parsedLibrary = storedLibrary ? JSON.parse(storedLibrary) as Partial<SavedLayout>[] : [];
        let layouts = Array.isArray(parsedLibrary) ? parsedLibrary.filter((layout) => layout.id && layout.room?.length && Array.isArray(layout.items)).map((layout) => {
          const defaults = blankLayout(layout.id, layout.projectName || "Untitled layout");
          const restoredRoom = layout.room && layout.room.length >= 3 ? layout.room : defaults.room;
          const restoredBounds = roomBounds(restoredRoom);
          return {
            ...defaults,
            ...layout,
            id: layout.id as string,
            room: restoredRoom,
            items: (layout.items || []).map((item) => constrainWallToRoom(item, restoredRoom, restoredBounds)),
          } as SavedLayout;
        }) : [];
        if (!layouts.length) {
          const legacyValue = window.localStorage.getItem(LEGACY_DRAFT_KEY);
          if (legacyValue) {
            const legacy = JSON.parse(legacyValue) as Partial<LayoutData>;
            const migrated = blankLayout(uid(), legacy.projectName || "Untitled layout");
            const restoredRoom = legacy.room && legacy.room.length >= 3 ? legacy.room : migrated.room;
            layouts = [{
              ...migrated,
              ...legacy,
              room: restoredRoom,
              items: (legacy.items || []).map((item) => constrainWallToRoom(item, restoredRoom, roomBounds(restoredRoom))),
            }];
          } else layouts = [blankLayout()];
        }
        const requestedId = window.localStorage.getItem(ACTIVE_LAYOUT_KEY);
        const active = layouts.find((layout) => layout.id === requestedId) || layouts[0];
        persistLibrary(layouts, active.id);
        setActiveLayoutId(active.id);
        applyLayout(active);
      } catch {
        if (recoveryRaw) {
          try {
            window.localStorage.setItem(`layout-library-recovery-${Date.now()}`, recoveryRaw);
          } catch {
            // If storage itself is unavailable, keep the in-memory fallback and surface the save failure.
          }
        }
        const fallback = blankLayout();
        persistLibrary([fallback], fallback.id);
        setActiveLayoutId(fallback.id);
        applyLayout(fallback);
      }
      setSaved(true);
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [applyLayout, persistLibrary]);

  useEffect(() => {
    const saveNow = () => { saveCurrentLayout(); };
    window.addEventListener("buildr:save-now", saveNow);
    return () => window.removeEventListener("buildr:save-now", saveNow);
  }, [saveCurrentLayout]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!isSupabaseConfigured() || !navigator.onLine) {
        setSyncState(navigator.onLine ? "device" : "offline");
        setCloudHydrated(true);
        return;
      }
      setSyncState("saving");
      void flushCloudDeletions().then(() => loadCloudLayouts()).then((cloudLayouts) => {
        if (cancelled) return;
        const pending = new Set(pendingCloudDeletions());
        const merged = mergeLayouts(savedLayoutsRef.current, cloudLayouts.filter((layout) => !pending.has(layout.id)));
        const currentId = window.localStorage.getItem(ACTIVE_LAYOUT_KEY) || merged.layouts[0]?.id;
        const active = merged.layouts.find((layout) => layout.id === currentId) || merged.layouts[0];
        if (active) {
          persistLibrary(merged.layouts, active.id);
          setActiveLayoutId(active.id);
          applyLayout(active);
        }
        setConflicts(merged.conflicts);
        setSyncState(merged.conflicts.length ? "conflict" : cloudLayouts.length ? "saved" : "device");
      }).catch(() => {
        if (!cancelled) setSyncState("failed");
      }).finally(() => {
        if (!cancelled) setCloudHydrated(true);
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [applyLayout, authVersion, hydrated, persistLibrary]);

  useEffect(() => {
    if (!hydrated || deepLinkHandledRef.current) return;
    deepLinkHandledRef.current = true;
    const shared=decodeSuiteHash(window.location.hash);if(!shared)return;
    const imported=suiteToLayout(shared);if(!imported.layout){window.alert(imported.error||"The shared room could not be opened.");return}
    const next=savedLayoutsRef.current.some(item=>item.id===imported.layout!.id)?savedLayoutsRef.current.map(item=>item.id===imported.layout!.id?imported.layout!:item):[imported.layout!,...savedLayoutsRef.current];
    persistLibrary(next,imported.layout.id);setActiveLayoutId(imported.layout.id);applyLayout(imported.layout);setReadOnly(Boolean(imported.readOnly));window.history.replaceState(null,"",window.location.pathname+window.location.search);if(imported.warning)window.alert(imported.warning);
  },[applyLayout,hydrated,persistLibrary]);

  useEffect(() => {
    if (!hydrated || !cloudHydrated || !activeLayoutId) return;
    const pendingTimer = window.setTimeout(() => setSaved(false), 0);
    const timer = window.setTimeout(async () => {
      const document = saveCurrentLayout();
      if (!document) return;
      if (!navigator.onLine) { setSyncState("offline"); return; }
      setSyncState("saving");
      try {
        const result = await saveCloudLayouts([document]);
        setConflicts(result.conflicts);
        setSyncState(result.conflicts.length ? "conflict" : result.cloudSaved ? "saved" : "device");
      } catch { setSyncState("failed"); }
    }, 650);
    return () => {
      window.clearTimeout(pendingTimer);
      window.clearTimeout(timer);
    };
  }, [activeLayoutId, cloudHydrated, hydrated, saveCurrentLayout]);

  useEffect(() => {
    if (!hydrated) return;
    const offline = () => setSyncState("offline");
    const online = () => {
      setSyncState("saving");
      void flushCloudDeletions().then(() => saveCloudLayouts(savedLayoutsRef.current)).then((result) => {
        setConflicts(result.conflicts);
        setSyncState(result.conflicts.length ? "conflict" : result.cloudSaved ? "saved" : "device");
      }).catch(() => setSyncState("failed"));
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => { window.removeEventListener("offline", offline); window.removeEventListener("online", online); };
  }, [hydrated]);

  const createNewLayout = () => {
    saveCurrentLayout();
    const nextLayout = blankLayout();
    const next = [nextLayout, ...savedLayoutsRef.current];
    const stored = persistLibrary(next, nextLayout.id);
    setActiveLayoutId(nextLayout.id);
    applyLayout(nextLayout);
    setLibraryOpen(false);
    setSaved(stored);
  };

  const openSavedLayout = (id: string) => {
    saveCurrentLayout();
    const layout = savedLayoutsRef.current.find((candidate) => candidate.id === id);
    if (!layout) return;
    setActiveLayoutId(layout.id);
    const stored = persistLibrary(savedLayoutsRef.current, layout.id);
    applyLayout(layout);
    setLibraryOpen(false);
    setSaved(stored);
  };

  const duplicateSavedLayout = (id: string) => {
    saveCurrentLayout();
    const source = savedLayoutsRef.current.find((layout) => layout.id === id);
    if (!source) return;
    const duplicate: SavedLayout = {
      ...source,
      id: uid(),
      revision: 1,
      projectName: `${source.projectName} copy`,
      room: source.room.map((point) => ({ ...point })),
      items: source.items.map((item) => ({ ...item, id: uid(), start: { ...item.start }, end: { ...item.end } })),
      origin: { ...source.origin },
      updatedAt: Date.now(),
    };
    const next = [duplicate, ...savedLayoutsRef.current];
    const stored = persistLibrary(next, duplicate.id);
    setActiveLayoutId(duplicate.id);
    applyLayout(duplicate);
    setLibraryOpen(false);
    setSaved(stored);
  };

  const deleteSavedLayout = (id: string) => {
    const target = savedLayoutsRef.current.find((layout) => layout.id === id);
    if (!target || !window.confirm(`Delete “${target.projectName}”? This cannot be undone.`)) return;
    let next = savedLayoutsRef.current.filter((layout) => layout.id !== id);
    if (!next.length) next = [blankLayout()];
    const nextActive = id === activeLayoutId ? next[0] : next.find((layout) => layout.id === activeLayoutId) || next[0];
    const stored = persistLibrary(next, nextActive.id);
    queueCloudDeletion(id);
    if (navigator.onLine) void flushCloudDeletions().then((complete) => {
      if (!complete) setSyncState("failed");
    });
    if (id === activeLayoutId) {
      setActiveLayoutId(nextActive.id);
      applyLayout(nextActive);
    }
    setSaved(stored);
  };

  const toggleArchivedLayout = (id: string) => {
    saveCurrentLayout();
    const next = savedLayoutsRef.current.map((layout) => layout.id === id ? {
      ...layout,
      archivedAt: layout.archivedAt ? undefined : Date.now(),
      revision: layout.revision + 1,
      updatedAt: Date.now(),
    } : layout);
    const changed = next.find((layout) => layout.id === id);
    if (!changed) return;
    let nextActive = next.find((layout) => layout.id === activeLayoutId && !layout.archivedAt)
      || next.find((layout) => !layout.archivedAt);
    if (!nextActive) {
      nextActive = blankLayout();
      next.unshift(nextActive);
    }
    const stored = persistLibrary(next, nextActive.id);
    setActiveLayoutId(nextActive.id);
    applyLayout(nextActive);
    setSaved(stored);
    if (navigator.onLine) void saveCloudLayouts([changed]).then((result) => {
      setSyncState(result.conflicts.length ? "conflict" : result.cloudSaved ? "saved" : "device");
    }).catch(() => setSyncState("failed"));
  };

  const printLayout = () => {
    saveCurrentLayout();
    setPrinting(true);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      window.print();
      setPrinting(false);
    }));
  };

  const exportShared=()=>{const savedLayout=saveCurrentLayout();if(savedLayout)downloadSuite(layoutToSuite(savedLayout),savedLayout.projectName)};
  const importShared=async(file?:File)=>{if(!file)return;try{const imported=suiteToLayout(JSON.parse(await file.text()));if(!imported.layout)throw new Error(imported.error);const next=savedLayoutsRef.current.some(item=>item.id===imported.layout!.id)?savedLayoutsRef.current.map(item=>item.id===imported.layout!.id?imported.layout!:item):[imported.layout!,...savedLayoutsRef.current];persistLibrary(next,imported.layout.id);setActiveLayoutId(imported.layout.id);applyLayout(imported.layout);setReadOnly(Boolean(imported.readOnly));if(imported.warning)window.alert(imported.warning)}catch(error){window.alert(error instanceof Error?error.message:"This shared file could not be opened.")}};
  const returnToBuildr=()=>{const savedLayout=saveCurrentLayout();if(!savedLayout)return;const base=process.env.NEXT_PUBLIC_BUILDR_URL||"https://buildr-orcin.vercel.app";const target=savedLayout.suiteContext?.buildrProjectId?`${base.replace(/\/$/,"")}/projects/${savedLayout.suiteContext.buildrProjectId}`:base;window.location.href=suiteLink(target,layoutToSuite(savedLayout))};

  const resolveConflict = (choice: "device" | "cloud") => {
    const conflict = conflicts[0];
    if (!conflict) return;
    const winner = choice === "cloud" ? conflict.cloud : { ...conflict.local, revision: Math.max(conflict.local.revision, conflict.cloud.revision) + 1, updatedAt: Date.now() };
    const next = savedLayoutsRef.current.map((layout) => layout.id === conflict.id ? winner : layout);
    persistLibrary(next, activeLayoutId || winner.id);
    if (activeLayoutId === winner.id) applyLayout(winner);
    setConflicts((current) => current.slice(1));
    setSyncState(conflicts.length > 1 ? "conflict" : "saving");
    if (choice === "device" && navigator.onLine) {
      void saveCloudLayouts([winner]).then((result) => setSyncState(result.conflicts.length ? "conflict" : "saved")).catch(() => setSyncState("failed"));
    } else if (conflicts.length <= 1) setSyncState("saved");
  };

  const clientPoint = (clientX: number, clientY: number): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const visibleW = VIEW_W / zoom;
    const visibleH = VIEW_H / zoom;
    return {
      x: roundToIncrement(clamp(pan.x + (clientX - rect.left) * visibleW / rect.width, 0, VIEW_W)),
      y: roundToIncrement(clamp(pan.y + (clientY - rect.top) * visibleH / rect.height, 0, VIEW_H)),
    };
  };
  const pointerPoint = (event: React.PointerEvent<SVGSVGElement>) => clientPoint(event.clientX, event.clientY);

  const changeZoom = (nextZoom: number, anchorClient?: Point) => {
    const clampedZoom = clamp(nextZoom, 0.75, 2.5);
    const rect = svgRef.current?.getBoundingClientRect();
    const currentVisible = { x: VIEW_W / zoom, y: VIEW_H / zoom };
    const nextVisible = { x: VIEW_W / clampedZoom, y: VIEW_H / clampedZoom };
    if (anchorClient && rect) {
      const fractionX = clamp((anchorClient.x - rect.left) / rect.width, 0, 1);
      const fractionY = clamp((anchorClient.y - rect.top) / rect.height, 0, 1);
      const anchor = {
        x: pan.x + fractionX * currentVisible.x,
        y: pan.y + fractionY * currentVisible.y,
      };
      setPan({
        x: clamp(anchor.x - fractionX * nextVisible.x, 0, Math.max(0, VIEW_W - nextVisible.x)),
        y: clamp(anchor.y - fractionY * nextVisible.y, 0, Math.max(0, VIEW_H - nextVisible.y)),
      });
    } else {
      const center = {
        x: pan.x + currentVisible.x / 2,
        y: pan.y + currentVisible.y / 2,
      };
      setPan({
        x: clamp(center.x - nextVisible.x / 2, 0, Math.max(0, VIEW_W - nextVisible.x)),
        y: clamp(center.y - nextVisible.y / 2, 0, Math.max(0, VIEW_H - nextVisible.y)),
      });
    }
    setZoom(clampedZoom);
  };

  const fitRoom = () => {
    const margin = 10;
    const width = Math.max(1, roomWidth + margin * 2);
    const height = Math.max(1, roomHeight + margin * 2);
    const nextZoom = clamp(Math.min(VIEW_W / width, VIEW_H / height), 0.75, 2.5);
    const visibleW = VIEW_W / nextZoom;
    const visibleH = VIEW_H / nextZoom;
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    setZoom(nextZoom);
    setPan({
      x: clamp(centerX - visibleW / 2, 0, Math.max(0, VIEW_W - visibleW)),
      y: clamp(centerY - visibleH / 2, 0, Math.max(0, VIEW_H - visibleH)),
    });
  };

  const beginPointerTracking = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== "touch") return;
    touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touchPointsRef.current.size !== 2) return;
    const [first, second] = [...touchPointsRef.current.entries()];
    const rect = event.currentTarget.getBoundingClientRect();
    const centerClient = { x: (first[1].x + second[1].x) / 2, y: (first[1].y + second[1].y) / 2 };
    pinchPointerIdsRef.current.add(first[0]);
    pinchPointerIdsRef.current.add(second[0]);
    pinchRef.current = {
      distance: Math.max(1, distance(first[1], second[1])),
      zoom,
      canvasCenter: {
        x: pan.x + (centerClient.x - rect.left) / rect.width * VIEW_W / zoom,
        y: pan.y + (centerClient.y - rect.top) / rect.height * VIEW_H / zoom,
      },
    };
    setDrag(null);
  };

  const movePointerTracking = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== "touch" || !touchPointsRef.current.has(event.pointerId)) return;
    touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (!pinch || touchPointsRef.current.size < 2) return;
    event.preventDefault();
    const [first, second] = [...touchPointsRef.current.values()];
    const rect = event.currentTarget.getBoundingClientRect();
    const centerClient = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const nextZoom = clamp(pinch.zoom * distance(first, second) / pinch.distance, 0.75, 2.5);
    const visibleW = VIEW_W / nextZoom;
    const visibleH = VIEW_H / nextZoom;
    const fractionX = (centerClient.x - rect.left) / rect.width;
    const fractionY = (centerClient.y - rect.top) / rect.height;
    setZoom(nextZoom);
    setPan({
      x: clamp(pinch.canvasCenter.x - fractionX * visibleW, 0, Math.max(0, VIEW_W - visibleW)),
      y: clamp(pinch.canvasCenter.y - fractionY * visibleH, 0, Math.max(0, VIEW_H - visibleH)),
    });
  };

  const endPointerTracking = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== "touch") return;
    touchPointsRef.current.delete(event.pointerId);
    if (touchPointsRef.current.size < 2) pinchRef.current = null;
  };

  const startDrawing = (event: React.PointerEvent<SVGSVGElement>) => {
    if (pinchRef.current) return;
    setSelectedRoomEdge(null);
    const rawPoint = pointerPoint(event);
    const roomPoint = constrainPointToPolygon(rawPoint, room);
    const point = tool === "wall" ? constrainWallPointToRoom(roomPoint, wallThickness, room, bounds) : rawPoint;
    if (tool === "pan") {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ kind: "pan", clientX: event.clientX, clientY: event.clientY, origin: pan });
      return;
    }
    if (tool === "floor") {
      snapshot();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ kind: "tile", anchor: point, originalOrigin: origin });
      return;
    }
    if (tool === "room") {
      if (event.pointerType === "touch") {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ kind: "room-tap", start: point, current: point });
        return;
      }
      setDraftRoom((current) => {
        const previous = current.at(-1);
        if (!previous || !snapEnabled || event.altKey) return [...current, point];
        const closeToStart = current.length >= 3 ? nearestSnapPoint(point, [current[0]], 3) : { point, snapped: false };
        return [...current, closeToStart.snapped ? closeToStart.point : snapToCommonAngle(previous, point)];
      });
      return;
    }
    if (tool === "wall" || tool === "opening") {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ kind: "draw", start: point, current: point });
      setSelectedId(null);
    } else setSelectedId(null);
  };

  const movePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (pinchRef.current) return;
    if (!drag) return;
    if (drag.kind === "pan") {
      const rect = event.currentTarget.getBoundingClientRect();
      const visibleW = VIEW_W / zoom;
      const visibleH = VIEW_H / zoom;
      setPan({
        x: clamp(drag.origin.x - (event.clientX - drag.clientX) * visibleW / rect.width, 0, Math.max(0, VIEW_W - visibleW)),
        y: clamp(drag.origin.y - (event.clientY - drag.clientY) * visibleH / rect.height, 0, Math.max(0, VIEW_H - visibleH)),
      });
      return;
    }
    const rawPoint = pointerPoint(event);
    const roomPoint = constrainPointToPolygon(rawPoint, room);
    const point = drag.kind === "draw" && tool === "wall" ? constrainWallPointToRoom(roomPoint, wallThickness, room, bounds) : rawPoint;
    if (drag.kind === "room-tap") {
      const previous = draftRoom.at(-1);
      const closeToStart = draftRoom.length >= 3
        ? nearestSnapPoint(point, [draftRoom[0]], 3)
        : { point, snapped: false };
      const snapped = !previous || !snapEnabled
        ? point
        : closeToStart.snapped
          ? closeToStart.point
          : snapToCommonAngle(previous, point);
      setDrag({ ...drag, current: snapped });
      return;
    }
    if (drag.kind === "tile") {
      setOrigin({
        x: drag.originalOrigin.x + point.x - drag.anchor.x,
        y: drag.originalOrigin.y + point.y - drag.anchor.y,
      });
      return;
    }
    if (drag.kind === "draw") {
      const candidates = [
        ...room,
        ...items.flatMap((item) => [item.start, item.end]),
      ];
      const nearby = snapEnabled && !event.altKey
        ? nearestSnapPoint(point, candidates, 3)
        : { point, snapped: false };
      const rawSnapped = nearby.snapped
        ? nearby.point
        : snapEnabled && !event.altKey
          ? snapToCommonAngle(drag.start, point)
          : point;
      const snapped = tool === "wall"
        ? constrainSegmentToPolygonInset(drag.start, rawSnapped, room, wallThickness / 2).end
        : rawSnapped;
      setDrag({ ...drag, current: snapped });
      return;
    }
    if (drag.kind === "item") {
      const requestedDx = point.x - drag.anchor.x;
      const requestedDy = point.y - drag.anchor.y;
      setItems((current) => {
        const moving = current.find((item) => item.id === drag.id);
        if (!moving) return current;
        if (moving.type === "opening" && (moving.hostId || moving.hostEdgeIndex != null)) {
          const requestedCenter = {
            x: (drag.originalStart.x + drag.originalEnd.x) / 2 + requestedDx,
            y: (drag.originalStart.y + drag.originalEnd.y) / 2 + requestedDy,
          };
          const updated = moveHostedOpening(moving, current, room, requestedCenter);
          return current.map((item) => item.id === moving.id ? updated : item);
        }
        const original = { ...moving, start: drag.originalStart, end: drag.originalEnd };
        const delta = moving.type === "wall"
          ? constrainWallTranslationToRoom(original, requestedDx, requestedDy, room, bounds)
          : constrainWallTranslation(original, requestedDx, requestedDy, bounds);
        const updated = {
          ...moving,
          start: { x: drag.originalStart.x + delta.dx, y: drag.originalStart.y + delta.dy },
          end: { x: drag.originalEnd.x + delta.dx, y: drag.originalEnd.y + delta.dy },
        };
        return moving.type === "wall"
          ? reflowWallHostedOpenings(current, moving.id, updated)
          : current.map((item) => item.id === moving.id ? updated : item);
      });
      return;
    }
    setItems((current) => {
      const item = current.find((candidate) => candidate.id === drag.id);
      if (!item) return current;
      const other = drag.endpoint === "start" ? item.end : item.start;
      const polygonPoint = item.type === "wall" ? constrainPointToPolygon(point, room) : point;
      const boundedPoint = item.type === "wall" ? clampWallPoint(polygonPoint, item.thickness, bounds) : point;
      const candidates = [
        ...room,
        ...current.filter((candidate) => candidate.id !== item.id).flatMap((candidate) => [candidate.start, candidate.end]),
      ];
      const nearby = snapEnabled && !event.altKey
        ? nearestSnapPoint(boundedPoint, candidates, 3)
        : { point: boundedPoint, snapped: false };
      const rawSnapped = nearby.snapped
        ? nearby.point
        : snapEnabled && !event.altKey
          ? snapToCommonAngle(other, boundedPoint)
          : boundedPoint;
      const snapped = item.type === "wall"
        ? constrainSegmentToPolygonInset(other, rawSnapped, room, item.thickness / 2).end
        : rawSnapped;
      let updated: DrawItem = { ...item, [drag.endpoint]: snapped };
      if (item.type === "opening" && (item.hostId || item.hostEdgeIndex != null)) {
        updated = moveHostedOpening(
          updated,
          current,
          room,
          {
            x: (updated.start.x + updated.end.x) / 2,
            y: (updated.start.y + updated.end.y) / 2,
          },
        );
      }
      return item.type === "wall"
        ? reflowWallHostedOpenings(current, item.id, updated)
        : current.map((candidate) => candidate.id === item.id ? updated : candidate);
    });
  };

  const endPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (pinchPointerIdsRef.current.has(event.pointerId)) {
      pinchPointerIdsRef.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      setDrag(null);
      return;
    }
    if (!drag) return;
    if (drag.kind === "room-tap") {
      setDraftRoom((current) => [...current, drag.current]);
    }
    if (drag.kind === "draw" && distance(drag.start, drag.current) >= 3) {
      snapshot();
      const rawNext: DrawItem = { id: uid(), type: tool === "opening" ? "opening" : "wall", start: drag.start, end: drag.current, thickness: wallThickness };
      const next = rawNext.type === "opening"
        ? attachOpeningToNearestHost(rawNext, items, room)
        : constrainWallToRoom(rawNext, room, bounds);
      setItems((current) => [...current, next]);
      setSelectedId(next.id);
      setTool("select");
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  };

  const beginEndpointDrag = (event: React.PointerEvent<SVGCircleElement>, id: string, endpoint: "start" | "end") => {
    if (pinchRef.current) return;
    event.stopPropagation(); snapshot();
    svgRef.current?.setPointerCapture(event.pointerId); setDrag({ kind: "endpoint", id, endpoint });
  };
  const beginItemDrag = (event: React.PointerEvent<SVGGElement>, item: DrawItem) => {
    if (tool !== "select" || pinchRef.current) return;
    event.stopPropagation();
    snapshot();
    setSelectedId(item.id);
    setSelectedRoomEdge(null);
    svgRef.current?.setPointerCapture(event.pointerId);
    setDrag({ kind: "item", id: item.id, anchor: clientPoint(event.clientX, event.clientY), originalStart: item.start, originalEnd: item.end });
  };
  const finishRoom = () => {
    if (draftRoom.length < 3) return;
    snapshot();
    setRoom(draftRoom);
    setItems((current) => reconcileItemsWithRoom(current, draftRoom));
    setDraftRoom([]);
    setTool("select");
  };
  const cancelRoom = () => { setDraftRoom([]); setTool("select"); };
  const autoBalance = () => {
    snapshot();
    const optimized = optimizePolygonLayout(
      room,
      actualTileW,
      actualTileH,
      grout,
      { x: bounds.minX, y: bounds.minY },
      xObstacles,
      yObstacles,
      patternRows,
    );
    const deltaX = optimized.offset.x - origin.x;
    const deltaY = optimized.offset.y - origin.y;
    const improvement = optimized.minimum - minimumCut;
    setOrigin(optimized.offset);
    if (improvement > 0.0625) {
      setOptimizationMessage(
        `Shifted reference ${formatLength(Math.abs(deltaX))} ${deltaX < 0 ? "left" : "right"} and ${formatLength(Math.abs(deltaY))} ${deltaY < 0 ? "up" : "down"}. Smallest planned cut improves from ${formatLength(minimumCut)} to ${formatLength(optimized.minimum)}.`,
      );
    } else {
      setOptimizationMessage(
        `This reference position is already close to the best balanced result. Smallest planned cut is about ${formatLength(optimized.minimum)}.`,
      );
    }
  };
  const favorOpening = () => {
    if (!selected || selected.type !== "opening") return;
    snapshot();
    const horizontal = Math.abs(selected.end.x - selected.start.x) >= Math.abs(selected.end.y - selected.start.y);
    const midpoint = {
      x: (selected.start.x + selected.end.x) / 2,
      y: (selected.start.y + selected.end.y) / 2,
    };
    setOrigin((current) => horizontal
      ? { ...current, x: midpoint.x - bounds.minX - actualTileW / 2 }
      : { ...current, y: midpoint.y - bounds.minY - actualTileH / 2 });
  };

  const updateSelectedLength = (nextLength: number) => {
    if (!selected || nextLength <= 0) return;
    snapshot();
    setItems((current) => {
      const item = current.find((candidate) => candidate.id === selected.id);
      if (!item) return current;
      const currentLength = distance(item.start, item.end) || 1;
      const scale = nextLength / currentLength;
      const rawEnd = {
        x: item.start.x + (item.end.x - item.start.x) * scale,
        y: item.start.y + (item.end.y - item.start.y) * scale,
      };
      const wallSegment = item.type === "wall"
        ? constrainSegmentToPolygonInset(item.start, rawEnd, room, item.thickness / 2)
        : null;
      let updated: DrawItem = {
        ...item,
        start: wallSegment?.start ?? item.start,
        end: wallSegment?.end ?? rawEnd,
      };
      if (item.type === "opening" && (item.hostId || item.hostEdgeIndex != null)) {
        updated = moveHostedOpening(updated, current, room, {
          x: (item.start.x + item.end.x) / 2,
          y: (item.start.y + item.end.y) / 2,
        });
      }
      return item.type === "wall"
        ? reflowWallHostedOpenings(current, item.id, updated)
        : current.map((candidate) => candidate.id === item.id ? updated : candidate);
    });
  };
  const detachSelectedOpening = () => {
    if (!selected || selected.type !== "opening" || !selectedOpeningHosted) return;
    snapshot();
    setItems((current) => current.map((item) => item.id === selected.id ? {
      ...item,
      hostId: undefined,
      hostEdgeIndex: undefined,
      hostT: undefined,
    } : item));
  };

  const updateSelectedThickness = (value: number) => {
    if (!selected || selectedOpeningHosted) return;
    snapshot();
    setItems((current) => {
      const item = current.find((candidate) => candidate.id === selected.id);
      if (!item) return current;
      const updated = item.type === "wall"
        ? constrainWallToRoom({ ...item, thickness: value }, room, bounds)
        : { ...item, thickness: value };
      return item.type === "wall"
        ? reflowWallHostedOpenings(current, item.id, updated)
        : current.map((candidate) => candidate.id === item.id ? updated : candidate);
    });
  };

  const updateSelectedAngle = (degrees: number) => {
    if (!selected) return;
    snapshot();
    setItems((current) => {
      const item = current.find((candidate) => candidate.id === selected.id);
      if (!item) return current;
      const rawEnd = endpointAtAngle(item.start, distance(item.start, item.end), degrees);
      const wallSegment = item.type === "wall"
        ? constrainSegmentToPolygonInset(item.start, rawEnd, room, item.thickness / 2)
        : null;
      const updated: DrawItem = {
        ...item,
        start: wallSegment?.start ?? item.start,
        end: wallSegment?.end ?? rawEnd,
        ...(item.type === "opening"
          ? { hostId: undefined, hostEdgeIndex: undefined, hostT: undefined }
          : {}),
      };
      return item.type === "wall"
        ? reflowWallHostedOpenings(current, item.id, updated)
        : current.map((candidate) => candidate.id === item.id ? updated : candidate);
    });
  };
  const resizeRectangle = (axis: "width" | "height", value: number) => {
    if (!isRectangle(room) || value < 24) return;
    snapshot();
    const b = roomBounds(room);
    const nextRoom = room.map((point) => ({
      x: axis === "width" && point.x === b.maxX ? b.minX + value : point.x,
      y: axis === "height" && point.y === b.maxY ? b.minY + value : point.y,
    }));
    setRoom(nextRoom);
    setItems((current) => reconcileItemsWithRoom(current, nextRoom));
  };

  const updateRoomEdgeLength = (value: number) => {
    if (selectedRoomEdge == null || value <= 0 || !room[selectedRoomEdge]) return;
    const start = room[selectedRoomEdge];
    const nextIndex = (selectedRoomEdge + 1) % room.length;
    const end = room[nextIndex];
    if (isRectangle(room)) {
      const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
      resizeRectangle(horizontal ? "width" : "height", value);
      return;
    }
    snapshot();
    const nextPoint = endpointAtAngle(start, value, segmentAngleDegrees(start, end));
    const nextRoom = room.map((point, index) => index === nextIndex ? nextPoint : point);
    setRoom(nextRoom);
    setItems((current) => reconcileItemsWithRoom(current, nextRoom));
  };

  const updateRoomEdgeAngle = (degrees: number) => {
    if (selectedRoomEdge == null || !room[selectedRoomEdge]) return;
    const start = room[selectedRoomEdge];
    const nextIndex = (selectedRoomEdge + 1) % room.length;
    const end = room[nextIndex];
    snapshot();
    const nextPoint = endpointAtAngle(start, distance(start, end), degrees);
    const nextRoom = room.map((point, index) => index === nextIndex ? nextPoint : point);
    setRoom(nextRoom);
    setItems((current) => reconcileItemsWithRoom(current, nextRoom));
  };
  const undo = useCallback(() => {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((current) => [currentSnapshot(), ...current]);
    setHistory((current) => current.slice(0, -1));
    restoreSnapshot(previous);
  }, [currentSnapshot, history, restoreSnapshot]);
  const redo = useCallback(() => {
    const next = future[0];
    if (!next) return;
    setHistory((current) => [...current.slice(-29), currentSnapshot()]);
    setFuture((current) => current.slice(1));
    restoreSnapshot(next);
  }, [currentSnapshot, future, restoreSnapshot]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (typing) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        event.preventDefault();
        snapshot();
        setItems((current) => removeItemWithDependents(current, selectedId));
        setSelectedId(null);
        return;
      }
      if (event.key === "Escape") {
        setSelectedId(null);
        setSelectedRoomEdge(null);
        setDraftRoom([]);
        setDrag(null);
        setTool("select");
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [redo, selectedId, snapshot, undo]);

  const roomPath = room.map((point) => `${point.x},${point.y}`).join(" ");
  const draftPath = draftRoom.map((point) => `${point.x},${point.y}`).join(" ");
  const roomCenter = polygonCenter(room);
  const patternX = bounds.minX + origin.x;
  const patternY = bounds.minY + origin.y;
  const referenceCross = nearestGridIntersectionInsidePolygon(
    room,
    { x: patternX, y: patternY },
    pitchX,
    pitchY,
    { x: patternX, y: patternY },
  );
  const startX = referenceCross.x;
  const startY = referenceCross.y;
  const horizontalReferenceSpan =
    horizontalPolygonSpanAtY(room, startY, startX) ?? { min: bounds.minX, max: bounds.maxX };
  const verticalReferenceSpan =
    verticalPolygonSpanAtX(room, startX, startY) ?? { min: bounds.minY, max: bounds.maxY };
  const startLeftReference = Math.max(0, startX - horizontalReferenceSpan.min);
  const startRightReference = Math.max(0, horizontalReferenceSpan.max - startX);
  const startTopReference = Math.max(0, startY - verticalReferenceSpan.min);
  const startBottomReference = Math.max(0, verticalReferenceSpan.max - startY);
  const setReferenceOffset = (axis: "x" | "y", value: number) => {
    snapshot();
    if (axis === "x") {
      const target = clamp(
        horizontalReferenceSpan.min + value,
        horizontalReferenceSpan.min,
        horizontalReferenceSpan.max,
      );
      setOrigin({
        x: target - bounds.minX,
        y: startY - bounds.minY,
      });
    } else {
      const target = clamp(
        verticalReferenceSpan.min + value,
        verticalReferenceSpan.min,
        verticalReferenceSpan.max,
      );
      setOrigin({
        x: startX - bounds.minX,
        y: target - bounds.minY,
      });
    }
  };
  const guideWallOrientation = dimensionedWall
    ? Math.abs(dimensionedWall.end.x - dimensionedWall.start.x) < 1
      ? "vertical"
      : Math.abs(dimensionedWall.end.y - dimensionedWall.start.y) < 1
        ? "horizontal"
        : null
    : null;
  const guideWallMidpoint = dimensionedWall ? {
    x: (dimensionedWall.start.x + dimensionedWall.end.x) / 2,
    y: (dimensionedWall.start.y + dimensionedWall.end.y) / 2,
  } : null;
  const guideHalfThickness = dimensionedWall ? dimensionedWall.thickness / 2 : 0;
  const guideHorizontalSpan = guideWallMidpoint
    ? horizontalPolygonSpanAtY(room, guideWallMidpoint.y, guideWallMidpoint.x)
    : null;
  const guideVerticalSpan = guideWallMidpoint
    ? verticalPolygonSpanAtX(room, guideWallMidpoint.x, guideWallMidpoint.y)
    : null;
  const guideLeftBoundary = guideHorizontalSpan?.min ?? bounds.minX;
  const guideRightBoundary = guideHorizontalSpan?.max ?? bounds.maxX;
  const guideTopBoundary = guideVerticalSpan?.min ?? bounds.minY;
  const guideBottomBoundary = guideVerticalSpan?.max ?? bounds.maxY;
  const guideLeftFace = guideWallMidpoint ? guideWallMidpoint.x - guideHalfThickness : 0;
  const guideRightFace = guideWallMidpoint ? guideWallMidpoint.x + guideHalfThickness : 0;
  const guideTopFace = guideWallMidpoint ? guideWallMidpoint.y - guideHalfThickness : 0;
  const guideBottomFace = guideWallMidpoint ? guideWallMidpoint.y + guideHalfThickness : 0;
  const setWallOffset = (side: "left" | "right" | "top" | "bottom", value: number) => {
    if (!dimensionedWall || !guideWallMidpoint) return;
    snapshot();
    const halfThickness = dimensionedWall.thickness / 2;
    if (side === "left" || side === "right") {
      const rawTarget = side === "left"
        ? guideLeftBoundary + value + halfThickness
        : guideRightBoundary - value - halfThickness;
      const target = clamp(
        rawTarget,
        guideLeftBoundary + halfThickness,
        guideRightBoundary - halfThickness,
      );
      const delta = target - guideWallMidpoint.x;
      setItems((current) => {
        const wall = current.find((item) => item.id === dimensionedWall.id);
        if (!wall) return current;
        const safeDelta = constrainWallTranslationToRoom(wall, delta, 0, room, bounds);
        const updated = {
          ...wall,
          start: { ...wall.start, x: wall.start.x + safeDelta.dx, y: wall.start.y + safeDelta.dy },
          end: { ...wall.end, x: wall.end.x + safeDelta.dx, y: wall.end.y + safeDelta.dy },
        };
        return reflowWallHostedOpenings(current, wall.id, updated);
      });
    } else {
      const rawTarget = side === "top"
        ? guideTopBoundary + value + halfThickness
        : guideBottomBoundary - value - halfThickness;
      const target = clamp(
        rawTarget,
        guideTopBoundary + halfThickness,
        guideBottomBoundary - halfThickness,
      );
      const delta = target - guideWallMidpoint.y;
      setItems((current) => {
        const wall = current.find((item) => item.id === dimensionedWall.id);
        if (!wall) return current;
        const safeDelta = constrainWallTranslationToRoom(wall, 0, delta, room, bounds);
        const updated = {
          ...wall,
          start: { ...wall.start, x: wall.start.x + safeDelta.dx, y: wall.start.y + safeDelta.dy },
          end: { ...wall.end, x: wall.end.x + safeDelta.dx, y: wall.end.y + safeDelta.dy },
        };
        return reflowWallHostedOpenings(current, wall.id, updated);
      });
    }
  };
  const draftWallMidpoint =
    drag?.kind === "draw" && tool === "wall"
      ? {
          x: (drag.start.x + drag.current.x) / 2,
          y: (drag.start.y + drag.current.y) / 2,
        }
      : null;
  const draftHorizontalSpan = draftWallMidpoint
    ? horizontalPolygonSpanAtY(room, draftWallMidpoint.y, draftWallMidpoint.x)
    : null;
  const draftVerticalSpan = draftWallMidpoint
    ? verticalPolygonSpanAtX(room, draftWallMidpoint.x, draftWallMidpoint.y)
    : null;
  const draftLeftBoundary = draftHorizontalSpan?.min ?? bounds.minX;
  const draftRightBoundary = draftHorizontalSpan?.max ?? bounds.maxX;
  const draftTopBoundary = draftVerticalSpan?.min ?? bounds.minY;
  const draftBottomBoundary = draftVerticalSpan?.max ?? bounds.maxY;
  const tileFill = {
    transparent: "#d4b477",
    porcelain: "#ece9df",
    stone: "url(#stone-fill)",
    marble: "url(#marble-fill)",
    concrete: "url(#concrete-fill)",
    wood: "url(#wood-fill)",
  }[tileAppearance];
  const tileOpacity = tileAppearance === "transparent" ? .2 : .88;
  const materialMin = materialUnit === "in" ? 1 : materialUnit === "mm" ? 25.4 : 2.54;
  const materialStep = materialUnit === "in" ? .125 : materialUnit === "mm" ? 1 : .1;
  const groutMin = materialUnit === "in" ? .0625 : materialUnit === "mm" ? 1 : .1;
  const groutStep = materialUnit === "in" ? .0625 : materialUnit === "mm" ? .5 : .05;

  return (
    <main className="app-shell">
      <input ref={importInputRef} hidden type="file" accept=".json,.buildr.json,application/json" onChange={(event)=>{void importShared(event.target.files?.[0]);event.currentTarget.value=""}}/>
      <header className="topbar">
        <div className="brand" aria-label="Layout by Buildr">
          <span className="brand-mark"><PencilRuler size={22} strokeWidth={2.25} /></span>
          <span className="brand-name">Layout</span><span className="brand-family">by Buildr</span>
        </div>
        <label className="project-name">
          <input aria-label="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} />
          <ChevronDown size={15} aria-hidden="true" />
        </label>
        <div className="header-actions">
          <span className={`save-state ${saved && syncState === "saved" && !deviceSaveFailed ? "is-saved" : ""} ${syncState} ${deviceSaveFailed ? "device-error" : ""}`}>
            {deviceSaveFailed || syncState === "offline" || syncState === "failed" ? <CloudOff size={14} /> : saved ? <Check size={14} /> : <Save size={14} />}
            {deviceSaveFailed ? "Device save failed" : !saved ? "Saving" : { device: "Device saved", saving: "Syncing", saved: "Cloud saved", offline: "Offline · device saved", failed: "Sync failed · device saved", conflict: "Needs review" }[syncState]}
          </span>
          <button className="icon-button" onClick={() => { saveCurrentLayout(); setLibraryOpen(true); }} aria-label="Saved layouts" title="Saved layouts"><FolderOpen size={18} /></button>
          <button className="icon-button desktop-action" onClick={()=>importInputRef.current?.click()} aria-label="Import shared project" title="Import shared project"><Upload size={18}/></button>
          <button className="icon-button desktop-action" onClick={exportShared} aria-label="Export shared project" title="Export shared project"><Download size={18}/></button>
          <button className="icon-button desktop-action" onClick={returnToBuildr} aria-label="Return result to Buildr" title="Return result to Buildr"><ExternalLink size={18}/></button>
          <SuiteAccountButton />
          <button className="icon-button desktop-action" onClick={printLayout} aria-label="Print layout" title="Print layout"><Printer size={18} /></button>
          <button className="icon-button" onClick={undo} disabled={!history.length} aria-label="Undo"><Undo2 size={18} /></button>
          <button className="icon-button" onClick={redo} disabled={!future.length} aria-label="Redo"><Redo2 size={18} /></button>
        </div>
      </header>
      {readOnly&&<div className="readonly-banner">Created by a newer Buildr app version · view, print, and export only</div>}

      {conflicts[0] && <div className="conflict-backdrop">
        <section className="conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="layout-conflict-title">
          <span className="eyebrow">Sync conflict</span>
          <h2 id="layout-conflict-title">Choose which layout to keep</h2>
          <p>This layout changed on two devices. Nothing will be overwritten until you choose.</p>
          <div className="conflict-options">
            <button onClick={() => resolveConflict("device")}><strong>This device</strong><span>Revision {conflicts[0].local.revision} · {new Date(conflicts[0].local.updatedAt).toLocaleString()}</span></button>
            <button onClick={() => resolveConflict("cloud")}><strong>Cloud copy</strong><span>Revision {conflicts[0].cloud.revision} · {new Date(conflicts[0].cloud.updatedAt).toLocaleString()}</span></button>
          </div>
        </section>
      </div>}

      {libraryOpen && <div className="library-backdrop" role="presentation" onPointerDown={() => setLibraryOpen(false)}>
        <section className="layout-library" role="dialog" aria-modal="true" aria-labelledby="layout-library-title" onPointerDown={(event) => event.stopPropagation()}>
          <div className="library-heading">
            <span><span className="eyebrow">Saved work</span><strong id="layout-library-title">Layouts</strong></span>
            <button className="library-close" onClick={() => setLibraryOpen(false)} aria-label="Close saved layouts"><X size={19} /></button>
          </div>
          <div className="library-meta-fields">
            <label className="library-name-field"><span>Layout / project name</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
            <label className="library-name-field"><span>Room / area</span><input value={roomName} onChange={(event) => setRoomName(event.target.value)} /></label>
          </div>
          <button className="primary new-layout-button" onClick={createNewLayout}><Plus size={17} /> New layout</button>
          <div className="library-utility-actions" aria-label="Layout actions">
            <button onClick={() => importInputRef.current?.click()}><Upload size={16} /> Import</button>
            <button onClick={exportShared}><Download size={16} /> Export</button>
            <button onClick={printLayout}><Printer size={16} /> Print / PDF</button>
            <button onClick={returnToBuildr}><ExternalLink size={16} /> Buildr</button>
          </div>
          <div className="layout-list">
            {[...savedLayouts].sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || b.updatedAt - a.updatedAt).map((layout) => <article className={`layout-card ${layout.id === activeLayoutId ? "active" : ""} ${layout.archivedAt ? "archived" : ""}`} key={layout.id}>
              <button className="layout-open" onClick={() => openSavedLayout(layout.id)}>
                <strong>{layout.projectName}</strong>
                <span>{layout.roomName || "Room"} · {formatLength(roomBounds(layout.room).maxX - roomBounds(layout.room).minX)} × {formatLength(roomBounds(layout.room).maxY - roomBounds(layout.room).minY)}</span>
                <small>{layout.archivedAt ? "Archived · " : layout.id === activeLayoutId ? "Currently editing · " : ""}{layout.suiteContext?.buildrProjectId ? "Buildr linked · " : ""}Saved {new Date(layout.updatedAt).toLocaleString()}</small>
              </button>
              <div className="layout-card-actions">
                <button onClick={() => duplicateSavedLayout(layout.id)} aria-label={`Duplicate ${layout.projectName}`}><Copy size={16} /></button>
                <button onClick={() => toggleArchivedLayout(layout.id)} aria-label={`${layout.archivedAt ? "Restore" : "Archive"} ${layout.projectName}`}>{layout.archivedAt ? <ArchiveRestore size={16} /> : <Archive size={16} />}</button>
                <button className="danger" onClick={() => deleteSavedLayout(layout.id)} aria-label={`Delete ${layout.projectName}`}><Trash2 size={16} /></button>
              </div>
            </article>)}
          </div>
          <p className="library-note">Every change is automatically saved on this device. Use Print to create a paper copy or PDF.</p>
        </section>
      </div>}

      <section className={readOnly?"workspace workspace-readonly":"workspace"}>
        <nav className="toolrail" aria-label="Drawing tools">
          {([ ["select", MousePointer2, "Select"], ["pan", Hand, "Pan"], ["floor", Move, "Floor"], ["room", SquareDashedMousePointer, "Room"], ["wall", BrickWall, "Wall"], ["opening", DoorOpen, "Opening"] ] as const).map(([value, Icon, label]) => (
            <button key={value} className={tool === value ? "active" : ""} onClick={() => { setTool(value); setDraftRoom([]); setSelectedId(null); setSelectedRoomEdge(null); }} aria-pressed={tool === value}>
              <Icon size={21} /><span>{label}</span>
            </button>
          ))}
        </nav>

        <section className="canvas-column">
          <header className="print-only print-header">
            <div><span>LAYOUT</span><strong>{projectName}</strong><small>{roomName}</small></div>
            <dl>
              <div><dt>Room</dt><dd>{formatLength(roomWidth)} × {formatLength(roomHeight)}</dd></div>
              <div><dt>Material</dt><dd>{materialType === "tile" ? "Tile" : "Plank"} · {formatLength(tileWidth)} × {formatLength(tileHeight)}</dd></div>
              <div><dt>{materialType === "tile" ? "Grout" : "Piece gap"}</dt><dd>{formatLength(grout)}</dd></div>
              <div><dt>Pattern</dt><dd>{{ straight: "Straight", "half-offset": "1/2 offset", "third-offset": "1/3 offset" }[pattern]} · {rotation}°</dd></div>
              <div><dt>Floor area</dt><dd>{areaSqFt.toFixed(1)} ft²</dd></div>
              <div><dt>Smallest cut</dt><dd>{formatLength(minimumCut)}{hasAngledBoundary ? " · angled boundaries included" : ""}</dd></div>
            </dl>
          </header>
          <div className="canvas-toolbar">
            <div className="mode-copy">
              <strong>{{ select: "Select and adjust", pan: "Move around the plan", floor: "Move the material field", wall: "Draw a straight wall", opening: "Mark an opening", room: "Draw the room perimeter" }[tool]}</strong>
              <span>{{ select: "Tap a dimension, wall, or opening to edit it exactly.", pan: "Drag the work area after zooming in.", floor: "Drag the reference cross and material grid together.", wall: "Snap helps with endpoints and common 45° angles. Hold Alt on desktop to bypass Snap.", opening: "Snap helps align openings to endpoints and common angles.", room: "Tap each corner. Snap helps keep common angles and closes to the first point." }[tool]}</span>
            </div>
            {tool === "room" && <div className="draft-actions"><button className="text-button" onClick={cancelRoom}>Cancel</button><button className="primary small" disabled={draftRoom.length < 3} onClick={finishRoom}>Finish room</button></div>}
            <button
              className={`snap-toggle ${snapEnabled ? "active" : ""}`}
              onClick={() => { snapshot(); setSnapEnabled((value) => !value); }}
              aria-pressed={snapEnabled}
              title="Snap to endpoints and common 45° angles"
            >
              <Grid3X3 size={16} /> Snap {snapEnabled ? "On" : "Off"}
            </button>
            <div className="zoom-controls">
              <button onClick={() => changeZoom(zoom - 0.2)} aria-label="Zoom out"><ZoomOut size={17} /></button>
              <span>{Math.round(zoom * 100)}%</span>
              <button onClick={() => changeZoom(zoom + 0.2)} aria-label="Zoom in"><ZoomIn size={17} /></button>
              <button className="fit-button" onClick={fitRoom} aria-label="Fit room in view">Fit</button>
            </div>
          </div>

          <div className={`canvas-wrap tool-${tool}`}>
            <svg ref={svgRef} className="drawing-canvas" viewBox={printing ? `0 0 ${VIEW_W} ${VIEW_H}` : `${pan.x} ${pan.y} ${VIEW_W / zoom} ${VIEW_H / zoom}`}
              onPointerDownCapture={beginPointerTracking} onPointerMoveCapture={movePointerTracking}
              onPointerUpCapture={endPointerTracking} onPointerCancelCapture={endPointerTracking}
              onPointerDown={startDrawing} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer}
              onWheel={(event) => { event.preventDefault(); changeZoom(zoom * (event.deltaY > 0 ? .9 : 1.1), { x: event.clientX, y: event.clientY }); }}
              role="application" aria-label="Interactive floor plan and material layout">
              <defs>
                <pattern id="minor-grid" width="3" height="3" patternUnits="userSpaceOnUse"><path d="M 3 0 L 0 0 0 3" fill="none" stroke="#d9dfdb" strokeWidth=".25" /></pattern>
                <pattern id="major-grid" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="url(#minor-grid)" /><path d="M 12 0 L 0 0 0 12" fill="none" stroke="#b9c4bd" strokeWidth=".45" /></pattern>
                <pattern id="stone-fill" width="8" height="8" patternUnits="userSpaceOnUse">
                  <rect width="8" height="8" fill="#d7d1c3" />
                  <circle cx="1.2" cy="2" r=".35" fill="#a9a091" /><circle cx="6.4" cy="5.7" r=".45" fill="#bbb2a3" /><path d="M1 7 3 6.2M5 .8 7 1.5" stroke="#c2baad" strokeWidth=".3" />
                </pattern>
                <pattern id="marble-fill" width="16" height="12" patternUnits="userSpaceOnUse">
                  <rect width="16" height="12" fill="#f0efeb" /><path d="M-2 10C3 8 5 2 10 1s5-4 9-3M-3 12C2 10 5 5 9 4s5-3 9-3" fill="none" stroke="#b9c5c1" strokeWidth=".45" opacity=".8" />
                </pattern>
                <pattern id="concrete-fill" width="7" height="7" patternUnits="userSpaceOnUse">
                  <rect width="7" height="7" fill="#c9cbc8" /><circle cx="1" cy="1.5" r=".25" fill="#999d99" /><circle cx="5.4" cy="3.5" r=".3" fill="#acafab" /><circle cx="2.8" cy="6" r=".2" fill="#8f948f" />
                </pattern>
                <pattern id="wood-fill" width="12" height="7" patternUnits="userSpaceOnUse">
                  <rect width="12" height="7" fill="#c8a978" /><path d="M0 2C3 1 6 3 12 1.8M0 5.5C4 4.2 7 6.5 12 5" fill="none" stroke="#9f7f55" strokeWidth=".35" opacity=".75" />
                </pattern>
                <pattern id="tile-pattern" x={patternX} y={patternY} width={pitchX} height={pitchY * patternRows} patternUnits="userSpaceOnUse">
                  {Array.from({ length: patternRows }, (_, row) => {
                    const shift = row * pitchX / patternRows;
                    return (
                      <g key={row}>
                        <rect x={shift - pitchX} y={row * pitchY} width={actualTileW} height={actualTileH} rx=".45" fill={tileFill} fillOpacity={tileOpacity} stroke="#9e7a35" strokeWidth=".45" />
                        <rect x={shift} y={row * pitchY} width={actualTileW} height={actualTileH} rx=".45" fill={tileFill} fillOpacity={tileOpacity} stroke="#9e7a35" strokeWidth=".45" />
                      </g>
                    );
                  })}
                </pattern>
                <clipPath id="room-clip"><polygon points={roomPath} /></clipPath>
              </defs>
              <rect width="100%" height="100%" fill="url(#major-grid)" />
              <polygon points={roomPath} fill="#fff" stroke="#173f32" strokeWidth="2.25" strokeLinejoin="round" />
              {showTile && <rect x={bounds.minX - actualTileW} y={bounds.minY - actualTileH} width={roomWidth + actualTileW * 2} height={roomHeight + actualTileH * 2} fill="url(#tile-pattern)" clipPath="url(#room-clip)" />}
              {items.map((item) => { const isSelected = selectedId === item.id; return (
                <g key={item.id} className={`plan-item ${item.type} ${isSelected ? "selected" : ""}`} onPointerDown={(event) => beginItemDrag(event, item)}>
                  <line className="item-hit" x1={item.start.x} y1={item.start.y} x2={item.end.x} y2={item.end.y} strokeWidth={Math.max(10, item.thickness + 5)} />
                  <line x1={item.start.x} y1={item.start.y} x2={item.end.x} y2={item.end.y} strokeWidth={item.type === "wall" ? item.thickness : Math.max(2.25, item.thickness * .55)} />
                  {item.type === "opening" && <line className="opening-center" x1={item.start.x} y1={item.start.y} x2={item.end.x} y2={item.end.y} />}
                  <text x={(item.start.x + item.end.x) / 2} y={(item.start.y + item.end.y) / 2 - item.thickness / 2 - 2}>{formatLength(distance(item.start, item.end))}</text>
                  {isSelected && <><circle className="endpoint-handle" cx={item.start.x} cy={item.start.y} r="4" onPointerDown={(event) => beginEndpointDrag(event, item.id, "start")} /><circle className="endpoint-handle" cx={item.end.x} cy={item.end.y} r="4" onPointerDown={(event) => beginEndpointDrag(event, item.id, "end")} /></>}
                </g>
              ); })}
              {showTile && <g className="chalk-guide" clipPath="url(#room-clip)" pointerEvents="none">
                <line className="chalk-axis" x1={startX} y1={verticalReferenceSpan.min} x2={startX} y2={verticalReferenceSpan.max} />
                <line className="chalk-axis" x1={horizontalReferenceSpan.min} y1={startY} x2={horizontalReferenceSpan.max} y2={startY} />
                <circle cx={startX} cy={startY} r="1.8" />
                <g className="chalk-measure">
                  <rect x={(horizontalReferenceSpan.min + startX) / 2 - 15} y={startY - 3.4} width="30" height="6.8" rx="2" />
                  <text x={(horizontalReferenceSpan.min + startX) / 2} y={startY + 1.25}>{formatLength(startLeftReference)} from left</text>
                </g>
                <g className="chalk-measure">
                  <rect x={(startX + horizontalReferenceSpan.max) / 2 - 15} y={startY - 3.4} width="30" height="6.8" rx="2" />
                  <text x={(startX + horizontalReferenceSpan.max) / 2} y={startY + 1.25}>{formatLength(startRightReference)} from right</text>
                </g>
                <g className="chalk-measure">
                  <rect x={startX - 15} y={(verticalReferenceSpan.min + startY) / 2 - 3.4} width="30" height="6.8" rx="2" />
                  <text x={startX} y={(verticalReferenceSpan.min + startY) / 2 + 1.25}>{formatLength(startTopReference)} from top</text>
                </g>
                <g className="chalk-measure">
                  <rect x={startX - 15} y={(startY + verticalReferenceSpan.max) / 2 - 3.4} width="30" height="6.8" rx="2" />
                  <text x={startX} y={(startY + verticalReferenceSpan.max) / 2 + 1.25}>{formatLength(startBottomReference)} from bottom</text>
                </g>
                <g className="chalk-label" transform={`translate(${startX + 12} ${startY - 7})`}><rect x="-11" y="-3" width="22" height="6" rx="2" /><text y="1">REFERENCE CROSS</text></g>
              </g>}
              <g className="dimensions">
                {room.map((point, index) => { const next = room[(index + 1) % room.length]; const midpoint = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 }; const labelPoint = outsideDimensionPoint(point, next, roomCenter); const edgeSelected = selectedRoomEdge === index; return (
                  <g
                    key={`${point.x}-${point.y}-${index}`}
                    className={edgeSelected ? "dimension-edge selected" : "dimension-edge"}
                    role="button"
                    tabIndex={tool === "select" ? 0 : -1}
                    aria-label={`Edit room edge ${index + 1}, ${formatLength(distance(point, next))}`}
                    onPointerDown={(event) => {
                      if (tool !== "select") return;
                      event.stopPropagation();
                      setSelectedId(null);
                      setSelectedRoomEdge(index);
                    }}
                    onKeyDown={(event) => {
                      if (tool === "select" && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        setSelectedId(null);
                        setSelectedRoomEdge(index);
                      }
                    }}
                  >
                    <line x1={midpoint.x} y1={midpoint.y} x2={labelPoint.x} y2={labelPoint.y} />
                    <rect className="dimension-hit" x={labelPoint.x - 13} y={labelPoint.y - 5.2} width="26" height="10.4" rx="3" />
                    <rect x={labelPoint.x - 9} y={labelPoint.y - 3.4} width="18" height="6.8" rx="2" />
                    <text x={labelPoint.x} y={labelPoint.y + 1.45}>{formatLength(distance(point, next))}</text>
                  </g>
                ); })}
              </g>
              {dimensionedWall && guideWallMidpoint && guideWallOrientation === "vertical" && <g className="wall-offset-guides">
                <line x1={guideLeftBoundary} y1={guideWallMidpoint.y} x2={guideLeftFace} y2={guideWallMidpoint.y} />
                <line x1={guideRightFace} y1={guideWallMidpoint.y} x2={guideRightBoundary} y2={guideWallMidpoint.y} />
                <WallOffsetLabel x={(guideLeftBoundary + guideLeftFace) / 2} y={guideWallMidpoint.y} inches={guideLeftFace - guideLeftBoundary} side="left" />
                <WallOffsetLabel x={(guideRightFace + guideRightBoundary) / 2} y={guideWallMidpoint.y} inches={guideRightBoundary - guideRightFace} side="right" />
              </g>}
              {dimensionedWall && guideWallMidpoint && guideWallOrientation === "horizontal" && <g className="wall-offset-guides">
                <line x1={guideWallMidpoint.x} y1={guideTopBoundary} x2={guideWallMidpoint.x} y2={guideTopFace} />
                <line x1={guideWallMidpoint.x} y1={guideBottomFace} x2={guideWallMidpoint.x} y2={guideBottomBoundary} />
                <WallOffsetLabel x={guideWallMidpoint.x} y={(guideTopBoundary + guideTopFace) / 2} inches={guideTopFace - guideTopBoundary} side="top" />
                <WallOffsetLabel x={guideWallMidpoint.x} y={(guideBottomFace + guideBottomBoundary) / 2} inches={guideBottomBoundary - guideBottomFace} side="bottom" />
              </g>}
              {drag?.kind === "draw" && <g className="draft-line" pointerEvents="none"><line x1={drag.start.x} y1={drag.start.y} x2={drag.current.x} y2={drag.current.y} strokeWidth={tool === "wall" ? wallThickness : 2.5} /><text x={(drag.start.x + drag.current.x) / 2} y={(drag.start.y + drag.current.y) / 2 - 4}>{formatLength(distance(drag.start, drag.current))}</text></g>}
              {drag?.kind === "draw" && tool === "wall" && Math.abs(drag.current.x - drag.start.x) < 1 && <g className="draft-offset-guides" pointerEvents="none">
                <line x1={draftLeftBoundary} y1={(drag.start.y + drag.current.y) / 2} x2={(drag.start.x + drag.current.x) / 2 - wallThickness / 2} y2={(drag.start.y + drag.current.y) / 2} />
                <line x1={(drag.start.x + drag.current.x) / 2 + wallThickness / 2} y1={(drag.start.y + drag.current.y) / 2} x2={draftRightBoundary} y2={(drag.start.y + drag.current.y) / 2} />
                <WallOffsetLabel x={(draftLeftBoundary + (drag.start.x + drag.current.x) / 2 - wallThickness / 2) / 2} y={(drag.start.y + drag.current.y) / 2} inches={(drag.start.x + drag.current.x) / 2 - wallThickness / 2 - draftLeftBoundary} side="left" />
                <WallOffsetLabel x={((drag.start.x + drag.current.x) / 2 + wallThickness / 2 + draftRightBoundary) / 2} y={(drag.start.y + drag.current.y) / 2} inches={draftRightBoundary - (drag.start.x + drag.current.x) / 2 - wallThickness / 2} side="right" />
              </g>}
              {drag?.kind === "draw" && tool === "wall" && Math.abs(drag.current.y - drag.start.y) < 1 && <g className="draft-offset-guides" pointerEvents="none">
                <line x1={(drag.start.x + drag.current.x) / 2} y1={draftTopBoundary} x2={(drag.start.x + drag.current.x) / 2} y2={(drag.start.y + drag.current.y) / 2 - wallThickness / 2} />
                <line x1={(drag.start.x + drag.current.x) / 2} y1={(drag.start.y + drag.current.y) / 2 + wallThickness / 2} x2={(drag.start.x + drag.current.x) / 2} y2={draftBottomBoundary} />
                <WallOffsetLabel x={(drag.start.x + drag.current.x) / 2} y={(draftTopBoundary + (drag.start.y + drag.current.y) / 2 - wallThickness / 2) / 2} inches={(drag.start.y + drag.current.y) / 2 - wallThickness / 2 - draftTopBoundary} side="top" />
                <WallOffsetLabel x={(drag.start.x + drag.current.x) / 2} y={((drag.start.y + drag.current.y) / 2 + wallThickness / 2 + draftBottomBoundary) / 2} inches={draftBottomBoundary - (drag.start.y + drag.current.y) / 2 - wallThickness / 2} side="bottom" />
              </g>}
              {draftRoom.length > 0 && <g className="draft-room" pointerEvents="none"><polyline points={draftPath} />{draftRoom.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="2" />)}</g>}
            </svg>
            <div className="scale-note">Each small square = 3 inches · Pinch to zoom</div>
          </div>
          <section className="print-only print-summary">
            <div><span>Vertical reference</span><strong>{formatLength(startLeftReference)} from left / {formatLength(startRightReference)} from right</strong></div>
            <div><span>Horizontal reference</span><strong>{formatLength(startTopReference)} from top / {formatLength(startBottomReference)} from bottom</strong></div>
            <div><span>Material estimate</span><strong>{tileCount} pieces including {wastePercent}% waste{materialType === "tile" ? ` · ${mortarBags} × 50 lb mortar bags` : ""}</strong></div>
            {notes.trim() && <div className="print-notes"><span>Install notes</span><strong>{notes.trim()}</strong></div>}
          </section>
        </section>

        <aside className="inspector">
          {selected ? <section className="panel selected-panel">
            <div className="panel-heading"><span className="eyebrow">Selected</span><strong>{selected.type === "wall" ? "Wall" : "Opening"}</strong></div>
            <div className="field-row">
              <LengthField label="Length" value={distance(selected.start, selected.end)} onChange={updateSelectedLength} min={1} />
              <NumberField label={selectedOpeningHosted ? "Angle (host)" : "Angle"} value={segmentAngleDegrees(selected.start, selected.end)} onChange={updateSelectedAngle} suffix="°" min={0} step={1} disabled={selectedOpeningHosted} />
            </div>
            <NumberField label={selected.type === "wall" ? "Thickness" : selectedOpeningHosted ? "Host wall thickness" : "Wall thickness"} value={selected.thickness} onChange={updateSelectedThickness} suffix="in" min={1} step={.5} disabled={selectedOpeningHosted} />
            {selected.type === "opening" && <div className={`host-status ${selectedOpeningHosted ? "attached" : "free"}`}>
              <strong>{selected.hostId ? "Attached to interior wall" : selected.hostEdgeIndex != null ? `Attached to room edge ${selected.hostEdgeIndex + 1}` : "Free opening"}</strong>
              <span>{selectedOpeningHosted ? "Moving or resizing this opening keeps it on its wall." : "Move this opening near a wall and redraw it there if you want a hosted relationship."}</span>
              {selectedOpeningHosted && <button className="text-button" onClick={detachSelectedOpening}>Detach from wall</button>}
            </div>}
            {selected.type === "wall" && guideWallOrientation === "vertical" && <div className="field-row wall-offset-fields">
              <OffsetField label="From left" inches={guideLeftFace - guideLeftBoundary} onCommit={(value) => setWallOffset("left", value)} />
              <OffsetField label="From right" inches={guideRightBoundary - guideRightFace} onCommit={(value) => setWallOffset("right", value)} />
            </div>}
            {selected.type === "wall" && guideWallOrientation === "horizontal" && <div className="field-row wall-offset-fields">
              <OffsetField label="From top" inches={guideTopFace - guideTopBoundary} onCommit={(value) => setWallOffset("top", value)} />
              <OffsetField label="From bottom" inches={guideBottomBoundary - guideBottomFace} onCommit={(value) => setWallOffset("bottom", value)} />
            </div>}
            {selected.type === "wall" && <p className="selection-hint">Drag the wall to reposition it. Gold dimensions measure from both room borders to the nearest wall face. Use the fields above to enter an exact offset. The guides are visible only while this wall is selected.</p>}
            {selected.type === "opening" && <button className="favor-button" onClick={favorOpening}><Sparkles size={16} /> Favor this opening</button>}
            <button className="delete-button" onClick={() => {
              snapshot();
              setItems((current) => removeItemWithDependents(current, selected.id));
              setSelectedId(null);
            }}>Delete {selected.type}{selected.type === "wall" && items.some((item) => item.hostId === selected.id) ? " + attached openings" : ""}</button>
          </section> : selectedEdgeStart && selectedEdgeEnd && selectedRoomEdge != null ? <section className="panel selected-panel">
            <div className="panel-heading"><span className="eyebrow">Selected dimension</span><strong>Room edge {selectedRoomEdge + 1}</strong></div>
            <div className="field-row">
              <LengthField label="Length" value={distance(selectedEdgeStart, selectedEdgeEnd)} onChange={updateRoomEdgeLength} min={1} />
              <NumberField label="Angle" value={segmentAngleDegrees(selectedEdgeStart, selectedEdgeEnd)} onChange={updateRoomEdgeAngle} suffix="°" min={0} step={1} />
            </div>
            <p className="selection-hint">{isRectangle(room) ? "Changing this edge length resizes the rectangle while keeping opposite sides aligned. Changing the angle converts the room to a custom shape." : "Length moves the next corner along this wall direction. Angle rotates this wall around its first corner. Verify adjacent dimensions after changing a custom shape."}</p>
            <button className="text-button room-edge-done" onClick={() => setSelectedRoomEdge(null)}>Done</button>
          </section> : <section className="panel">
            <div className="panel-heading"><span className="eyebrow">Room</span><strong>{isRectangle(room) ? `${formatLength(roomWidth)} × ${formatLength(roomHeight)}` : "Custom shape"}</strong></div>
            {isRectangle(room) && <div className="field-row"><LengthField label="Width" value={roomWidth} onChange={(value) => resizeRectangle("width", value)} min={24} /><LengthField label="Length" value={roomHeight} onChange={(value) => resizeRectangle("height", value)} min={24} /></div>}
            <NumberField label="New wall thickness" value={wallThickness} onChange={(value) => { snapshot(); setWallThickness(value); }} suffix="in" min={1} step={.5} />
          </section>}

          <section className="panel tile-panel">
            <div className="panel-heading inline-heading"><span><span className="eyebrow">Material</span><strong>{materialType === "tile" ? "Tile layout" : "Plank layout"}</strong></span><label className="switch"><input aria-label="Show material layout" type="checkbox" checked={showTile} onChange={(event) => { snapshot(); setShowTile(event.target.checked); }} /><span aria-hidden="true" /></label></div>
            <div className="material-kind" aria-label="Material type">
              {([["tile", "Tile"], ["plank", "Plank"]] as [MaterialType, string][]).map(([value, label]) => (
                <button key={value} className={materialType === value ? "active" : ""} onClick={() => { snapshot(); setMaterialType(value); }} aria-pressed={materialType === value}>{label}</button>
              ))}
            </div>
            <div className="material-units" aria-label="Material measurement unit">
              {(["in", "mm", "cm"] as MaterialUnit[]).map((unit) => <button key={unit} className={materialUnit === unit ? "active" : ""} onClick={() => { snapshot(); setMaterialUnit(unit); }} aria-pressed={materialUnit === unit}>{unit}</button>)}
            </div>
            <div className="field-row">
              <NumberField label="Material width" value={displayUnit(tileWidth, materialUnit)} onChange={(value) => { snapshot(); setTileWidth(inchesFromUnit(value, materialUnit)); }} suffix={materialUnit} min={materialMin} step={materialStep} />
              <NumberField label="Material length" value={displayUnit(tileHeight, materialUnit)} onChange={(value) => { snapshot(); setTileHeight(inchesFromUnit(value, materialUnit)); }} suffix={materialUnit} min={materialMin} step={materialStep} />
            </div>
            <NumberField label={materialType === "tile" ? "Grout joint" : "Piece gap"} value={displayUnit(grout, materialUnit)} onChange={(value) => { snapshot(); setGrout(inchesFromUnit(value, materialUnit)); }} suffix={materialUnit} min={materialType === "tile" ? groutMin : 0} step={groutStep} />
            <div className="pattern-field">
              <span>Pattern</span>
              <div className="pattern-options">
                {([
                  ["straight", "Straight"],
                  ["half-offset", "1/2 offset"],
                  ["third-offset", "1/3 offset"],
                ] as [LayoutPattern, string][]).map(([value, label]) => (
                  <button key={value} className={pattern === value ? "active" : ""} onClick={() => { snapshot(); setPattern(value); }} aria-pressed={pattern === value}>{label}</button>
                ))}
              </div>
            </div>
            <div className="appearance-field">
              <span>Display appearance</span>
              <div className="appearance-options">
                {(materialType === "tile"
                  ? ([ ["transparent", "Clear"], ["porcelain", "Porcelain"], ["stone", "Stone"], ["marble", "Marble"], ["concrete", "Concrete"] ] as [TileAppearance, string][])
                  : ([ ["transparent", "Clear"], ["wood", "Wood"] ] as [TileAppearance, string][])
                ).map(([value, label]) => (
                  <button key={value} className={tileAppearance === value ? `active appearance-${value}` : `appearance-${value}`} onClick={() => { snapshot(); setTileAppearance(value); }} aria-pressed={tileAppearance === value}><span aria-hidden="true" />{label}</button>
                ))}
              </div>
            </div>
            <div className="button-row"><button className="secondary" onClick={() => { snapshot(); setRotation((value) => value === 0 ? 90 : 0); }}><RotateCw size={16} /> Rotate 90°</button><button className="primary" onClick={autoBalance}><Sparkles size={16} /> Optimize cuts</button></div>
            <button className={`grab-floor-button ${tool === "floor" ? "active" : ""}`} onClick={() => { setShowTile(true); setTool("floor"); setSelectedId(null); setSelectedRoomEdge(null); }}><Move size={16} /> {tool === "floor" ? "Drag reference lines and material" : "Move reference lines / material"}</button>
            <div className="nudge-control"><span>Precision adjustment · 1/8″</span><div><button onClick={() => { snapshot(); setOrigin((point) => ({ ...point, x: point.x - .125 })); }} aria-label="Move layout left">←</button><button onClick={() => { snapshot(); setOrigin((point) => ({ ...point, y: point.y - .125 })); }} aria-label="Move layout up">↑</button><button onClick={() => { snapshot(); setOrigin((point) => ({ ...point, y: point.y + .125 })); }} aria-label="Move layout down">↓</button><button onClick={() => { snapshot(); setOrigin((point) => ({ ...point, x: point.x + .125 })); }} aria-label="Move layout right">→</button></div></div>
          </section>

          <section className="panel results-panel">
            <div className="panel-heading inline-heading"><span><span className="eyebrow">Layout check</span><strong>{cutWarning ? "Review small cuts" : hasAngledBoundary ? "Angled cuts look balanced" : "Cuts look balanced"}</strong></span><span className={`result-icon ${layoutNeedsReview ? "warning" : ""}`}>{layoutNeedsReview ? "!" : <Check size={17} />}</span></div>
            <div className="metrics"><div><span>Floor area</span><strong>{areaSqFt.toFixed(1)} ft²</strong></div><div><span>Material + {wastePercent}%</span><strong>{tileCount} pcs</strong></div><div><span>Smallest boundary cut</span><strong>{formatLength(minimumCut)}</strong></div></div>
            <div className="start-reference-card">
              <span>Exact reference position</span>
              <div className="reference-fields">
                <OffsetField label="Vertical from left" inches={startLeftReference} onCommit={(value) => setReferenceOffset("x", value)} />
                <OffsetField label="Horizontal from top" inches={startTopReference} onCommit={(value) => setReferenceOffset("y", value)} />
              </div>
              <small>{formatLength(startRightReference)} from right · {formatLength(startBottomReference)} from bottom</small>
            </div>
            <p>{cutWarning ? "A room boundary, wall, or opening creates a small planned cut. Optimize cuts, drag the reference cross, or nudge it precisely." : hasAngledBoundary ? "Angled room boundaries are included in the cut-depth calculation and optimization. Verify final field conditions and substrate geometry before setting material." : "The current material position avoids small cuts across the room boundaries, walls, and openings being checked."}</p>
            {optimizationMessage && <div className="optimization-feedback"><Sparkles size={15} /><span>{optimizationMessage}</span></div>}
          </section>

          <section className="panel notes-panel">
            <div className="panel-heading"><span className="eyebrow">Install notes</span><strong>Field notes</strong></div>
            <textarea
              aria-label="Installation notes"
              value={notes}
              maxLength={1200}
              placeholder="Center doorway, keep a full tile at vanity, verify cabinet location…"
              onChange={(event) => setNotes(event.target.value)}
            />
          </section>

          <section className="panel install-panel">
            <div className="panel-heading"><span className="eyebrow">Install setup</span><strong>{materialType === "tile" ? mortar.trowel : "Plank planning"}</strong></div>
            <div className="install-metrics">
              <div><span>{materialType === "tile" ? "Mortar estimate" : "Material takeoff"}</span><strong>{materialType === "tile" ? `${mortarBags} × 50 lb bags` : `${tileCount} pieces`}</strong></div>
              <div><span>Waste allowance</span><NumberField label="Waste allowance" value={wastePercent} onChange={(value) => { snapshot(); setWastePercent(value); }} suffix="%" min={0} step={1} /></div>
            </div>
            <p>{materialType === "tile" ? `Planning estimate based on about ${mortar.coverage} ft² per bag. Confirm the mortar manufacturer’s coverage and the trowel required for the tile back, substrate flatness, and required mortar coverage; back-buttering can increase usage.` : "Piece count is a planning estimate from room area, plank size, and waste. Confirm the flooring manufacturer’s expansion gap, acclimation, staggering, and installation requirements before installation."}</p>
          </section>
        </aside>
      </section>

      <nav className="mobile-tools" aria-label="Drawing tools">
        {([ ["select", MousePointer2, "Select"], ["pan", Hand, "Pan"], ["floor", Move, "Floor"], ["room", SquareDashedMousePointer, "Room"], ["wall", BrickWall, "Wall"], ["opening", DoorOpen, "Opening"], ["tile", Grid3X3, "Material"] ] as const).map(([value, Icon, label]) => (
          <button key={value} className={value !== "tile" && tool === value ? "active" : ""} onClick={() => { if (value === "tile") document.querySelector(".tile-panel")?.scrollIntoView({ behavior: "smooth" }); else { setTool(value); setDraftRoom([]); setSelectedId(null); setSelectedRoomEdge(null); } }}><Icon size={19} /><span>{label}</span></button>
        ))}
      </nav>
    </main>
  );
}
