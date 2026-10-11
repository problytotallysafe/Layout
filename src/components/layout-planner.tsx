"use client";

import {
  Archive, ArchiveRestore, BrickWall, Check, ChevronDown, CloudOff, Copy, DoorOpen, FolderOpen, Grid3X3, Hand, MousePointer2, Move,
  Plus, Printer, Redo2, RotateCw, Save, Sparkles, SquareDashedMousePointer, Trash2, Undo2, X, Download, Upload, ExternalLink,
  ZoomIn, ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeSuiteHash, downloadSuite, layoutToSuite, suiteLink, suiteToLayout } from "@/lib/suite-exchange";
import { mergeLayouts, type LayoutConflict } from "@/lib/layout-sync";
import { flushCloudDeletions, loadCloudLayouts, pendingCloudDeletions, queueCloudDeletion, saveCloudLayouts } from "@/lib/layout-store";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { SuiteAccountButton } from "@/components/suite-account";

export type Point = { x: number; y: number };
export type DrawItem = { id: string; type: "wall" | "opening"; start: Point; end: Point; thickness: number };
export type Niche = { id: string; x: number; y: number; width: number; height: number; depth: number; shelves: { id: string; fromBottom: number; thickness: number }[] };
export type LayoutSurface = "floor" | "wall";
type TilePattern = "stack" | "half" | "third" | "diagonal" | "herringbone";
type LayoutMethod = "center" | "edge" | "balanced";
type Tool = "select" | "pan" | "floor" | "room" | "wall" | "opening";
type MaterialUnit = "in" | "mm" | "cm";
type TileAppearance = "transparent" | "porcelain" | "stone" | "marble" | "concrete";
type CutObstacle = { coordinate: number; side: "before" | "after" };
type DragState =
  | { kind: "draw"; start: Point; current: Point }
  | { kind: "endpoint"; id: string; endpoint: "start" | "end" }
  | { kind: "item"; id: string; anchor: Point; originalStart: Point; originalEnd: Point }
  | { kind: "pan"; clientX: number; clientY: number; origin: Point }
  | { kind: "tile"; anchor: Point; originalOrigin: Point }
  | { kind: "niche"; id: string; anchor: Point; original: Niche }
  | { kind: "niche-resize"; id: string; anchor: Point; original: Niche }
  | { kind: "shelf"; nicheId: string; shelfId: string; anchor: Point; original: number }
  | null;
type Snapshot = {
  room: Point[]; items: DrawItem[]; niches?: Niche[]; surface: LayoutSurface;
  tileWidth: number; tileHeight: number; grout: number; materialUnit: MaterialUnit;
  tileAppearance: TileAppearance; wastePercent: number; wallThickness: number;
  origin: Point; rotation: 0 | 90; showTile: boolean; pattern?: TilePattern;
  method?: LayoutMethod; referenceLine?: string;
};
type PinchState = { distance: number; zoom: number; canvasCenter: Point };
export type LayoutData = Snapshot & {
  projectName: string;
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
  surface: "floor",
  room: DEFAULT_ROOM.map((point) => ({ ...point })),
  items: [],
  tileWidth: 12,
  tileHeight: 24,
  grout: 0.125,
  materialUnit: "in",
  tileAppearance: "transparent",
  wastePercent: 10,
  wallThickness: 4.5,
  origin: { x: 0, y: 0 },
  rotation: 0,
  showTile: true,
  niches: [],
  pattern: "stack",
  method: "edge",
  referenceLine: "",
});
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const formatLength = (inches: number) => {
  const eighths = Math.max(0, Math.round(inches * 8));
  const feet = Math.floor(eighths / 96);
  const remainder = eighths % 96;
  const wholeInches = Math.floor(remainder / 8);
  const fraction = remainder % 8;
  const divisor = fraction === 0 ? 1 : fraction % 4 === 0 ? 4 : fraction % 2 === 0 ? 2 : 1;
  const fractionLabel = fraction ? ` ${fraction / divisor}/${8 / divisor}` : "";
  return `${feet}′ ${wholeInches}${fractionLabel}″`;
};
const parseLength = (value: string) => {
  const metric = value.trim().toLowerCase().match(/^(-?\d+(?:\.\d+)?)\s*(mm|cm|m)$/);
  if (metric) return Number(metric[1]) / ({ mm: 25.4, cm: 2.54, m: 0.0254 }[metric[2] as "mm" | "cm" | "m"]);
  const normalized = value.trim().toLowerCase().replace(/feet|foot|ft/g, "'").replace(/inches|inch|in/g, '"');
  if (!normalized) return null;
  const mixed = normalized.match(/^(-?\d+)\s+(\d+)\/(\d+)\s*"?$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = normalized.match(/^(-?\d+)\/(\d+)\s*"?$/);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  if (!normalized.includes("'") && !normalized.includes('"')) {
    const plain = Number(normalized);
    return Number.isFinite(plain) ? plain : null;
  }
  const feetMatch = normalized.match(/(-?\d+(?:\.\d+)?)\s*'/);
  const afterFeet = feetMatch ? normalized.slice((feetMatch.index ?? 0) + feetMatch[0].length) : normalized;
  const inchMatch = afterFeet.match(/(-?\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?\s*"?/);
  const fractionOnly = afterFeet.match(/(\d+)\/(\d+)/);
  const feet = feetMatch ? Number(feetMatch[1]) : 0;
  let inches = inchMatch ? Number(inchMatch[1]) : 0;
  if (inchMatch?.[2] && inchMatch[3]) inches += Number(inchMatch[2]) / Number(inchMatch[3]);
  else if (!inchMatch && fractionOnly) inches += Number(fractionOnly[1]) / Number(fractionOnly[2]);
  const result = feet * 12 + inches;
  return Number.isFinite(result) && (!inchMatch?.[3] || Number(inchMatch[3]) !== 0) ? result : null;
};
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
const constrainWallTranslation = (item: DrawItem, dx: number, dy: number, bounds: Bounds) => {
  if (item.type !== "wall") return { dx, dy };
  const halfThickness = item.thickness / 2;
  const minDx = bounds.minX + halfThickness - Math.min(item.start.x, item.end.x);
  const maxDx = bounds.maxX - halfThickness - Math.max(item.start.x, item.end.x);
  const minDy = bounds.minY + halfThickness - Math.min(item.start.y, item.end.y);
  const maxDy = bounds.maxY - halfThickness - Math.max(item.start.y, item.end.y);
  return { dx: clamp(dx, minDx, maxDx), dy: clamp(dy, minDy, maxDy) };
};
const isRectangle = (room: Point[]) => room.length === 4 && room.every((point, index) => {
  const next = room[(index + 1) % room.length];
  return point.x === next.x || point.y === next.y;
});
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
function nicheError(niche: Niche, room: Point[], items: DrawItem[], others: Niche[]) {
  if (niche.width < 2 || niche.height < 2 || niche.depth <= 0) return "Niche width and height must be at least 2 inches, and depth must be positive.";
  if (![{ x: niche.x, y: niche.y }, { x: niche.x + niche.width, y: niche.y },
    { x: niche.x, y: niche.y + niche.height }, { x: niche.x + niche.width, y: niche.y + niche.height }]
    .some((point) => !pointInPolygon(point, room))) {
    if (others.some((other) => other.id !== niche.id && overlaps(niche, other))) return "This niche overlaps another niche.";
    if (items.some((item) => item.type === "opening" && overlaps(niche, {
      x: Math.min(item.start.x, item.end.x) - 1, y: Math.min(item.start.y, item.end.y) - 1,
      width: Math.abs(item.start.x - item.end.x) + 2, height: Math.abs(item.start.y - item.end.y) + 2,
    }))) return "This niche crosses an opening. Move or resize it first.";
    if (niche.shelves.some((shelf) => shelf.fromBottom < 0 || shelf.fromBottom + shelf.thickness > niche.height))
      return "A shelf would be outside the resized niche. Move the shelf first.";
    if (niche.shelves.some((shelf, index) => niche.shelves.some((other, otherIndex) =>
      otherIndex !== index && shelf.fromBottom < other.fromBottom + other.thickness
      && shelf.fromBottom + shelf.thickness > other.fromBottom)))
      return "Shelves cannot overlap. Move one shelf before entering this position.";
    return null;
  }
  return "The niche must fit inside the finished wall face.";
}


const pointOnSegment = (point: Point, start: Point, end: Point, tolerance = 0.05) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const cross = Math.abs((point.x - start.x) * dy - (point.y - start.y) * dx) / length;
  if (cross > tolerance) return false;
  const dot = (point.x - start.x) * dx + (point.y - start.y) * dy;
  return dot >= -tolerance && dot <= dx * dx + dy * dy + tolerance;
};

const pointInPolygon = (point: Point, polygon: Point[]) => {
  if (polygon.some((start, index) => pointOnSegment(point, start, polygon[(index + 1) % polygon.length]))) return true;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
};

const closestPointOnSegment = (point: Point, start: Point, end: Point) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return {
    point: { x: start.x + dx * t, y: start.y + dy * t },
    t,
    distance: Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t)),
    angle: Math.atan2(dy, dx),
  };
};

const nearestRoomEdge = (point: Point, polygon: Point[]) => {
  let best: (ReturnType<typeof closestPointOnSegment> & { index: number }) | null = null;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const candidate = { ...closestPointOnSegment(point, start, end), index };
    if (best === null || candidate.distance < best.distance) best = candidate;
  }
  return best;
};

const translateItem = (item: DrawItem, dx: number, dy: number): DrawItem => ({
  ...item,
  start: { x: item.start.x + dx, y: item.start.y + dy },
  end: { x: item.end.x + dx, y: item.end.y + dy },
});

const itemInsideRoom = (item: DrawItem, polygon: Point[]) =>
  pointInPolygon(item.start, polygon)
  && pointInPolygon(item.end, polygon);

const constrainTranslationToRoom = (item: DrawItem, dx: number, dy: number, polygon: Point[]) => {
  const requested = translateItem(item, dx, dy);
  if (itemInsideRoom(requested, polygon)) return { dx, dy };

  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const factor = (low + high) / 2;
    const candidate = translateItem(item, dx * factor, dy * factor);
    if (itemInsideRoom(candidate, polygon)) low = factor;
    else high = factor;
  }
  return { dx: dx * low, dy: dy * low };
};

const snapOpeningToBoundary = (item: DrawItem, polygon: Point[], threshold = 7): DrawItem => {
  if (item.type !== "opening") return item;
  const midpoint = {
    x: (item.start.x + item.end.x) / 2,
    y: (item.start.y + item.end.y) / 2,
  };
  const edge = nearestRoomEdge(midpoint, polygon);
  if (!edge || edge.distance > threshold) return item;

  const edgeStart = polygon[edge.index];
  const edgeEnd = polygon[(edge.index + 1) % polygon.length];
  const edgeDx = edgeEnd.x - edgeStart.x;
  const edgeDy = edgeEnd.y - edgeStart.y;
  const edgeLength = Math.hypot(edgeDx, edgeDy) || 1;
  const itemLength = distance(item.start, item.end);
  const half = Math.min(itemLength / 2, edgeLength / 2);
  const unitX = edgeDx / edgeLength;
  const unitY = edgeDy / edgeLength;

  const minCenter = half;
  const maxCenter = Math.max(half, edgeLength - half);
  const projectedCenter = clamp(edge.t * edgeLength, minCenter, maxCenter);
  const center = {
    x: edgeStart.x + unitX * projectedCenter,
    y: edgeStart.y + unitY * projectedCenter,
  };

  return {
    ...item,
    start: { x: center.x - unitX * half, y: center.y - unitY * half },
    end: { x: center.x + unitX * half, y: center.y + unitY * half },
  };
};

function cutAtBoundary(coordinate: number, tile: number, grout: number, rawOffset: number, side: CutObstacle["side"]) {
  const pitch = tile + grout;
  const phase = ((coordinate - rawOffset) % pitch + pitch) % pitch;
  if (phase < 0.001 || phase >= tile - 0.001) return tile;
  return side === "before" ? phase : tile - phase;
}

function assessAxis(span: number, tile: number, grout: number, rawOffset: number, obstacles: CutObstacle[]) {
  const edges = edgeCuts(span, tile, grout, rawOffset);
  const obstacleCuts = obstacles.map((obstacle) => cutAtBoundary(obstacle.coordinate, tile, grout, rawOffset, obstacle.side));
  return { ...edges, minimum: Math.min(edges.left, edges.right, ...obstacleCuts) };
}

function assessPatternX(span: number, tile: number, grout: number, rawOffset: number, obstacles: CutObstacle[], pattern: TilePattern) {
  const rows = pattern === "half" ? 2 : pattern === "third" ? 3 : 1;
  const assessments = Array.from({ length: rows }, (_, row) => assessAxis(span, tile, grout, rawOffset + row * (tile + grout) / rows, obstacles));
  return { left: Math.min(...assessments.map((value) => value.left)),
    right: Math.min(...assessments.map((value) => value.right)),
    minimum: Math.min(...assessments.map((value) => value.minimum)) };
}
function balancedOffset(span: number, tile: number, grout: number, obstacles: CutObstacle[], pattern: TilePattern = "stack") {
  const pitch = tile + grout;
  let best = { offset: 0, score: -Infinity, left: 0, right: 0, minimum: 0 };
  for (let offset = -pitch; offset <= 0; offset += 0.125) {
    const assessment = assessPatternX(span, tile, grout, offset, obstacles, pattern);
    const score = assessment.minimum * 100 - Math.abs(assessment.left - assessment.right);
    if (score > best.score) best = { offset, score, ...assessment };
  }
  return best;
}

function edgeCuts(span: number, tile: number, grout: number, rawOffset: number) {
  const pitch = tile + grout;
  const offset = ((rawOffset % pitch) + pitch) % pitch - pitch;
  const intersections: { start: number; end: number }[] = [];
  for (let start = offset; start < span; start += pitch) {
    const visibleStart = Math.max(0, start);
    const visibleEnd = Math.min(span, start + tile);
    if (visibleEnd > visibleStart) intersections.push({ start: visibleStart, end: visibleEnd });
  }
  if (!intersections.length) return { left: 0, right: 0 };
  const last = intersections[intersections.length - 1];
  return {
    left: intersections[0].end - intersections[0].start,
    right: last.end - last.start,
  };
}

function NumberField({ label, value, onChange, suffix, min = 0, step = 1 }: {
  label: string; value: number; onChange: (value: number) => void; suffix: string; min?: number; step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="number-input">
        <input aria-label={label} min={min} step={step} type="number" value={Number.isInteger(value) ? value : Number(value.toFixed(3))}
          onChange={(event) => onChange(Math.max(min, Number(event.target.value) || 0))} />
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

function DimensionBubble({ x, y, inches, label, onClick, width = 34 }: { x: number; y: number; inches: number; label: string; onClick: () => void; width?: number }) {
  return (
    <g className="wall-offset-label dimension-bubble" transform={`translate(${x} ${y})`} role="button" tabIndex={0}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label={`Edit ${label}: ${formatLength(inches)}`} onClick={(event) => { event.stopPropagation(); onClick(); }}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } }}>
      <rect x={-width / 2} y="-4.2" width={width} height="8.4" rx="2" />
      <text y="1.25">{formatLength(inches)} {label}</text>
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

export function LayoutPlanner({ previewOnly = false }: { previewOnly?: boolean }) {
  const LIBRARY_KEY = previewOnly ? "layout-review-library-v1" : "layout-library-v1";
  const ACTIVE_LAYOUT_KEY = previewOnly ? "layout-review-active-v1" : "layout-active-id-v1";
  const LEGACY_DRAFT_KEY = previewOnly ? "layout-review-draft-v1" : "layout-draft-v1";
  const [projectName, setProjectName] = useState("Untitled bathroom");
  const [surface, setSurface] = useState<LayoutSurface>("floor");
  const [room, setRoom] = useState<Point[]>(DEFAULT_ROOM);
  const [draftRoom, setDraftRoom] = useState<Point[]>([]);
  const [items, setItems] = useState<DrawItem[]>([
    { id: "sample-wall", type: "wall", start: { x: 101, y: 20 }, end: { x: 101, y: 58 }, thickness: 4.5 },
    { id: "sample-opening", type: "opening", start: { x: 48, y: 62 }, end: { x: 48, y: 98 }, thickness: 4.5 },
  ]);
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [tileWidth, setTileWidth] = useState(12);
  const [tileHeight, setTileHeight] = useState(24);
  const [grout, setGrout] = useState(0.125);
  const [materialUnit, setMaterialUnit] = useState<MaterialUnit>("in");
  const [tileAppearance, setTileAppearance] = useState<TileAppearance>("transparent");
  const [wastePercent, setWastePercent] = useState(10);
  const [wallThickness, setWallThickness] = useState(4.5);
  const [origin, setOrigin] = useState<Point>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState<0 | 90>(0);
  const [showTile, setShowTile] = useState(true);
  const [niches, setNiches] = useState<Niche[]>([]);
  const [selectedNicheId, setSelectedNicheId] = useState<string | null>(null);
  const [pattern, setPattern] = useState<TilePattern>("stack");
  const [method, setMethod] = useState<LayoutMethod>("edge");
  const [referenceLine, setReferenceLine] = useState("");
  const [snapNiche, setSnapNiche] = useState(true);
  const [dimensionEdit, setDimensionEdit] = useState<{ label: string; value: number; commit: (value: number) => string | void } | null>(null);
  const [dimensionInput, setDimensionInput] = useState("");
  const [dimensionError, setDimensionError] = useState("");
  const [suiteContext, setSuiteContext] = useState<LayoutData["suiteContext"]>();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [saved, setSaved] = useState(true);
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
  const xCuts = useMemo(() => balancedOffset(roomWidth, actualTileW, grout, xObstacles, pattern), [roomWidth, actualTileW, grout, xObstacles, pattern]);
  const yCuts = useMemo(() => balancedOffset(roomHeight, actualTileH, grout, yObstacles), [roomHeight, actualTileH, grout, yObstacles]);
  const currentXCuts = useMemo(() => assessPatternX(roomWidth, actualTileW, grout, origin.x, xObstacles, pattern), [roomWidth, actualTileW, grout, origin.x, xObstacles, pattern]);
  const currentYCuts = useMemo(() => assessAxis(roomHeight, actualTileH, grout, origin.y, yObstacles), [roomHeight, actualTileH, grout, origin.y, yObstacles]);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const selectedNiche = niches.find((niche) => niche.id === selectedNicheId) ?? null;
  const dimensionedWall = tool === "select" && selected?.type === "wall" ? selected : null;
  const minimumCut = Math.min(currentXCuts.minimum, currentYCuts.minimum);
  const estimatedCuts = pattern === "diagonal" || pattern === "herringbone";
  const cutWarning = minimumCut < Math.min(actualTileW, actualTileH) / 2;

  const currentSnapshot = useCallback((): Snapshot => ({
    room, items, niches, surface, tileWidth, tileHeight, grout, materialUnit, tileAppearance,
    wastePercent, wallThickness, origin, rotation, showTile, pattern, method, referenceLine,
  }), [room, items, niches, surface, tileWidth, tileHeight, grout, materialUnit, tileAppearance,
    wastePercent, wallThickness, origin, rotation, showTile, pattern, method, referenceLine]);
  const snapshot = useCallback(() => {
    setHistory((current) => [...current.slice(-49), currentSnapshot()]);
    setFuture([]);
    setSaved(false);
  }, [currentSnapshot]);
  const restoreSnapshot = (state: Snapshot) => {
    setRoom(state.room); setItems(state.items); setNiches(state.niches || []);
    setSurface(state.surface); setTileWidth(state.tileWidth); setTileHeight(state.tileHeight);
    setGrout(state.grout); setMaterialUnit(state.materialUnit); setTileAppearance(state.tileAppearance);
    setWastePercent(state.wastePercent); setWallThickness(state.wallThickness); setOrigin(state.origin);
    setRotation(state.rotation); setShowTile(state.showTile); setPattern(state.pattern || "stack");
    setMethod(state.method || "edge"); setReferenceLine(state.referenceLine || "");
    setSaved(false);
  };

  const applyLayout = useCallback((layout: SavedLayout) => {
    const restoredBounds = roomBounds(layout.room);
    setProjectName(layout.projectName);
    setSurface(layout.surface || "floor");
    setRoom(layout.room);
    setItems(layout.items.map((item) => constrainWallToBounds(item, restoredBounds)));
    setTileWidth(layout.tileWidth);
    setTileHeight(layout.tileHeight);
    setGrout(layout.grout);
    setMaterialUnit(layout.materialUnit);
    setTileAppearance(layout.tileAppearance);
    setWastePercent(layout.wastePercent);
    setWallThickness(layout.wallThickness);
    setOrigin(layout.origin);
    setRotation(layout.rotation);
    setShowTile(layout.showTile);
    setNiches(layout.niches || []);
    setPattern(layout.pattern || "stack");
    setMethod(layout.method || "edge");
    setReferenceLine(layout.referenceLine || "");
    setSuiteContext(layout.suiteContext);
    setSelectedId(null);
    setSelectedNicheId(null);
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
    window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(layouts));
    window.localStorage.setItem(ACTIVE_LAYOUT_KEY, activeId);
  }, []);

  const saveCurrentLayout = useCallback(() => {
    if (!activeLayoutId) return null;
    const existing = savedLayoutsRef.current.find((layout) => layout.id === activeLayoutId);
    const document: SavedLayout = {
      id: activeLayoutId,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      projectName: projectName.trim() || "Untitled layout",
      surface,
      room,
      items,
      tileWidth,
      tileHeight,
      grout,
      materialUnit,
      tileAppearance,
      wastePercent,
      wallThickness,
      origin,
      rotation,
      showTile,
      niches, pattern, method, referenceLine,
      suiteContext,
    };
    const existingIndex = savedLayoutsRef.current.findIndex((layout) => layout.id === activeLayoutId);
    const next = existingIndex >= 0
      ? savedLayoutsRef.current.map((layout) => layout.id === activeLayoutId ? document : layout)
      : [document, ...savedLayoutsRef.current];
    persistLibrary(next, activeLayoutId);
    window.localStorage.setItem(LEGACY_DRAFT_KEY, JSON.stringify(document));
    setSaved(true);
    return document;
  }, [activeLayoutId, grout, items, niches, pattern, method, referenceLine, materialUnit, origin, persistLibrary, projectName, room, rotation, showTile, suiteContext, surface, tileAppearance, tileHeight, tileWidth, wallThickness, wastePercent]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const storedLibrary = window.localStorage.getItem(LIBRARY_KEY);
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
            items: (layout.items || []).map((item) => constrainWallToBounds(item, restoredBounds)),
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
              items: (legacy.items || []).map((item) => constrainWallToBounds(item, roomBounds(restoredRoom))),
            }];
          } else layouts = [blankLayout()];
        }
        const requestedId = window.localStorage.getItem(ACTIVE_LAYOUT_KEY);
        const active = layouts.find((layout) => layout.id === requestedId) || layouts[0];
        persistLibrary(layouts, active.id);
        setActiveLayoutId(active.id);
        applyLayout(active);
      } catch {
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
    if (!hydrated) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (previewOnly || !isSupabaseConfigured() || !navigator.onLine) {
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
  }, [applyLayout, authVersion, hydrated, persistLibrary, previewOnly]);

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
      if (previewOnly) { setSyncState("device"); return; }
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
  }, [activeLayoutId, cloudHydrated, hydrated, saveCurrentLayout, previewOnly]);

  useEffect(() => {
    if (!hydrated || previewOnly) return;
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
  }, [hydrated, previewOnly]);

  const createNewLayout = () => {
    saveCurrentLayout();
    const nextLayout = blankLayout();
    const next = [nextLayout, ...savedLayoutsRef.current];
    persistLibrary(next, nextLayout.id);
    setActiveLayoutId(nextLayout.id);
    applyLayout(nextLayout);
    setLibraryOpen(false);
    setSaved(true);
  };

  const openSavedLayout = (id: string) => {
    saveCurrentLayout();
    const layout = savedLayoutsRef.current.find((candidate) => candidate.id === id);
    if (!layout) return;
    setActiveLayoutId(layout.id);
    window.localStorage.setItem(ACTIVE_LAYOUT_KEY, layout.id);
    applyLayout(layout);
    setLibraryOpen(false);
    setSaved(true);
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
      niches: (source.niches || []).map((niche) => ({ ...niche, id: uid(), shelves: niche.shelves.map((shelf) => ({ ...shelf, id: uid() })) })),
      origin: { ...source.origin },
      updatedAt: Date.now(),
    };
    const next = [duplicate, ...savedLayoutsRef.current];
    persistLibrary(next, duplicate.id);
    setActiveLayoutId(duplicate.id);
    applyLayout(duplicate);
    setLibraryOpen(false);
    setSaved(true);
  };

  const deleteSavedLayout = (id: string) => {
    const target = savedLayoutsRef.current.find((layout) => layout.id === id);
    if (!target || !window.confirm(`Delete “${target.projectName}”? This cannot be undone.`)) return;
    let next = savedLayoutsRef.current.filter((layout) => layout.id !== id);
    if (!next.length) next = [blankLayout()];
    const nextActive = id === activeLayoutId ? next[0] : next.find((layout) => layout.id === activeLayoutId) || next[0];
    persistLibrary(next, nextActive.id);
    if (!previewOnly) queueCloudDeletion(id);
    if (!previewOnly && navigator.onLine) void flushCloudDeletions().then((complete) => {
      if (!complete) setSyncState("failed");
    });
    if (id === activeLayoutId) {
      setActiveLayoutId(nextActive.id);
      applyLayout(nextActive);
    }
    setSaved(true);
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
    persistLibrary(next, nextActive.id);
    setActiveLayoutId(nextActive.id);
    applyLayout(nextActive);
    setSaved(true);
    if (!previewOnly && navigator.onLine) void saveCloudLayouts([changed]).then((result) => {
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
      x: Math.round(clamp(pan.x + (clientX - rect.left) * visibleW / rect.width, 0, VIEW_W)),
      y: Math.round(clamp(pan.y + (clientY - rect.top) * visibleH / rect.height, 0, VIEW_H)),
    };
  };
  const pointerPoint = (event: React.PointerEvent<SVGSVGElement>) => clientPoint(event.clientX, event.clientY);

  const changeZoom = (nextZoom: number) => {
    const clampedZoom = clamp(nextZoom, 0.75, 2.5);
    const center = { x: pan.x + VIEW_W / zoom / 2, y: pan.y + VIEW_H / zoom / 2 };
    const nextVisible = { x: VIEW_W / clampedZoom, y: VIEW_H / clampedZoom };
    setPan({
      x: clamp(center.x - nextVisible.x / 2, 0, Math.max(0, VIEW_W - nextVisible.x)),
      y: clamp(center.y - nextVisible.y / 2, 0, Math.max(0, VIEW_H - nextVisible.y)),
    });
    setZoom(clampedZoom);
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
    const rawPoint = pointerPoint(event);
    const point = tool === "wall" ? clampWallPoint(rawPoint, wallThickness, bounds) : rawPoint;
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
    if (tool === "room") { setDraftRoom((current) => [...current, point]); return; }
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
    const point = drag.kind === "draw" && tool === "wall" ? clampWallPoint(rawPoint, wallThickness, bounds) : rawPoint;
    if (drag.kind === "tile") {
      setOrigin({
        x: clamp(drag.originalOrigin.x + point.x - drag.anchor.x, 0, roomWidth),
        y: clamp(drag.originalOrigin.y + point.y - drag.anchor.y, 0, roomHeight),
      });
      return;
    }
    if (drag.kind === "niche" || drag.kind === "niche-resize") {
      const original = drag.original;
      const dx = point.x - drag.anchor.x, dy = point.y - drag.anchor.y;
      const snap = (value: number, axis: "x" | "y") => {
        if (!snapNiche || event.altKey) return Math.round(value * 8) / 8;
        const pitch = axis === "x" ? actualTileW + grout : actualTileH + grout;
        const line = axis === "x" ? bounds.minX + origin.x : bounds.minY + origin.y;
        const grid = line + Math.round((value - line) / pitch) * pitch;
        return Math.abs(grid - value) < 1.25 ? grid : Math.round(value * 8) / 8;
      };
      const candidate = drag.kind === "niche"
        ? { ...original, x: snap(original.x + dx, "x"), y: snap(original.y + dy, "y") }
        : { ...original, width: snap(original.x + original.width + dx, "x") - original.x,
            height: snap(original.y + original.height + dy, "y") - original.y };
      if (!nicheError(candidate, room, items, niches))
        setNiches((current) => current.map((niche) => niche.id === original.id ? candidate : niche));
      return;
    }
    if (drag.kind === "shelf") {
      setNiches((current) => current.map((niche) => {
        if (niche.id !== drag.nicheId) return niche;
        const proposed = { ...niche, shelves: niche.shelves.map((shelf) => shelf.id === drag.shelfId
          ? { ...shelf, fromBottom: clamp(Math.round((drag.original - (point.y - drag.anchor.y)) * 8) / 8, 0, niche.height - shelf.thickness) }
          : shelf) };
        return nicheError(proposed, room, items, current) ? niche : proposed;
      }));
      return;
    }
    if (drag.kind === "draw") {
      const dx = Math.abs(point.x - drag.start.x);
      const dy = Math.abs(point.y - drag.start.y);
      const snapped = !event.altKey ? (dx > dy ? { x: point.x, y: drag.start.y } : { x: drag.start.x, y: point.y }) : point;
      setDrag({ ...drag, current: snapped });
      return;
    }
    if (drag.kind === "item") {
      const requestedDx = point.x - drag.anchor.x;
      const requestedDy = point.y - drag.anchor.y;
      setItems((current) => current.map((item) => item.id === drag.id ? {
        ...item,
        ...(() => {
          const original = { ...item, start: drag.originalStart, end: drag.originalEnd };
          const bounded = constrainWallTranslation(original, requestedDx, requestedDy, bounds);
          const roomDelta = constrainTranslationToRoom(original, bounded.dx, bounded.dy, room);
          const moved = translateItem(original, roomDelta.dx, roomDelta.dy);
          const placed = item.type === "opening" && !event.altKey
            ? snapOpeningToBoundary(moved, room)
            : moved;
          return {
            start: placed.start,
            end: placed.end,
          };
        })(),
      } : item));
      return;
    }
    setItems((current) => current.map((item) => {
      if (item.id !== drag.id) return item;
      const other = drag.endpoint === "start" ? item.end : item.start;
      const boundedPoint = item.type === "wall" ? clampWallPoint(point, item.thickness, bounds) : point;
      const roomPoint = pointInPolygon(boundedPoint, room)
        ? boundedPoint
        : nearestRoomEdge(boundedPoint, room)?.point ?? boundedPoint;
      const dx = Math.abs(roomPoint.x - other.x);
      const dy = Math.abs(roomPoint.y - other.y);
      const axisSnapped = item.type === "wall" && !event.altKey
        ? (dx > dy ? { x: roomPoint.x, y: other.y } : { x: other.x, y: roomPoint.y })
        : roomPoint;
      const resized = { ...item, [drag.endpoint]: axisSnapped };
      return item.type === "opening" && !event.altKey
        ? snapOpeningToBoundary(resized, room)
        : resized;
    }));
  };

  const endPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (pinchPointerIdsRef.current.has(event.pointerId)) {
      pinchPointerIdsRef.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      setDrag(null);
      return;
    }
    if (!drag) return;
    if (drag.kind === "draw" && distance(drag.start, drag.current) >= 3) {
      snapshot();
      const rawNext: DrawItem = { id: uid(), type: tool === "opening" ? "opening" : "wall", start: drag.start, end: drag.current, thickness: wallThickness };
      const bounded = constrainWallToBounds(rawNext, bounds);
      const inside = itemInsideRoom(bounded, room)
        ? bounded
        : {
            ...bounded,
            start: pointInPolygon(bounded.start, room) ? bounded.start : nearestRoomEdge(bounded.start, room)?.point ?? bounded.start,
            end: pointInPolygon(bounded.end, room) ? bounded.end : nearestRoomEdge(bounded.end, room)?.point ?? bounded.end,
          };
      const next = tool === "opening" && !event.altKey
        ? snapOpeningToBoundary(inside, room)
        : inside;
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
    svgRef.current?.setPointerCapture(event.pointerId);
    setDrag({ kind: "item", id: item.id, anchor: clientPoint(event.clientX, event.clientY), originalStart: item.start, originalEnd: item.end });
  };
  const beginNicheDrag = (event: React.PointerEvent<SVGElement>, niche: Niche, kind: "niche" | "niche-resize") => {
    if (tool !== "select" || pinchRef.current) return;
    event.stopPropagation(); snapshot(); setSelectedNicheId(niche.id); setSelectedId(null);
    svgRef.current?.setPointerCapture(event.pointerId);
    setDrag({ kind, id: niche.id, anchor: clientPoint(event.clientX, event.clientY), original: niche });
  };
  const beginShelfDrag = (event: React.PointerEvent<SVGElement>, niche: Niche, shelf: Niche["shelves"][number]) => {
    if (tool !== "select" || pinchRef.current) return;
    event.stopPropagation(); snapshot(); setSelectedNicheId(niche.id);
    svgRef.current?.setPointerCapture(event.pointerId);
    setDrag({ kind: "shelf", nicheId: niche.id, shelfId: shelf.id, anchor: clientPoint(event.clientX, event.clientY), original: shelf.fromBottom });
  };
  const finishRoom = () => {
    if (draftRoom.length < 3) return;
    snapshot();
    setRoom(draftRoom);
    setItems((current) => current.map((item) => constrainWallToBounds(item, roomBounds(draftRoom))));
    setDraftRoom([]);
    setTool("select");
  };
  const cancelRoom = () => { setDraftRoom([]); setTool("select"); };
  const autoBalance = () => { snapshot(); setOrigin({ x: ((xCuts.offset % (actualTileW + grout)) + actualTileW + grout) % (actualTileW + grout),
    y: ((yCuts.offset % (actualTileH + grout)) + actualTileH + grout) % (actualTileH + grout) }); setMethod("balanced"); };
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
    const currentLength = distance(selected.start, selected.end) || 1;
    const scale = nextLength / currentLength;
    setItems((current) => current.map((item) => {
      if (item.id !== selected.id) return item;
      const end = {
        x: item.start.x + (item.end.x - item.start.x) * scale,
        y: item.start.y + (item.end.y - item.start.y) * scale,
      };
      return { ...item, end: item.type === "wall" ? clampWallPoint(end, item.thickness, bounds) : end };
    }));
  };
  const updateItemLength = (id: string, value: number): string | void => {
    const item = items.find((candidate) => candidate.id === id);
    if (!item || value < 1) return "Enter a length of at least 1 inch.";
    const oldLength = distance(item.start, item.end);
    if (!oldLength) return "Move the endpoint before entering its length.";
    const end = { x: item.start.x + (item.end.x - item.start.x) * value / oldLength,
      y: item.start.y + (item.end.y - item.start.y) * value / oldLength };
    const candidate = { ...item, end };
    if (!itemInsideRoom(candidate, room)) return "The new endpoint is outside the surface. Move the first end or change the room first.";
    snapshot(); setItems((current) => current.map((drawn) => drawn.id === id ? candidate : drawn));
  };
  const editItemOffset = (id: string, side: "left" | "right" | "top" | "bottom", value: number): string | void => {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return "Select the feature first.";
    const minX = Math.min(item.start.x, item.end.x), maxX = Math.max(item.start.x, item.end.x);
    const minY = Math.min(item.start.y, item.end.y), maxY = Math.max(item.start.y, item.end.y);
    const delta = side === "left" ? { x: bounds.minX + value - minX, y: 0 }
      : side === "right" ? { x: bounds.maxX - value - maxX, y: 0 }
      : side === "top" ? { x: 0, y: bounds.minY + value - minY }
      : { x: 0, y: bounds.maxY - value - maxY };
    const moved = translateItem(item, delta.x, delta.y);
    if (!itemInsideRoom(moved, room)) return "This offset moves the feature outside the finished surface. Adjust the adjacent edge first.";
    snapshot(); setItems((current) => current.map((candidate) => candidate.id === id ? moved : candidate));
  };
  const resizeRectangle = (axis: "width" | "height", value: number) => {
    if (!isRectangle(room) || value < 24) return;
    snapshot();
    const b = roomBounds(room);
    const nextRoom = room.map((point) => ({
      x: axis === "width" && point.x === b.maxX ? b.minX + value : point.x,
      y: axis === "height" && point.y === b.maxY ? b.minY + value : point.y,
    }));
    const nextBounds = roomBounds(nextRoom);
    setRoom(nextRoom);
    setItems((current) => current.map((item) => constrainWallToBounds(item, nextBounds)));
  };
  const editSegment = (index: number, value: number): string | void => {
    if (value < 2) return "A wall segment must be at least 2 inches.";
    const start = room[index], end = room[(index + 1) % room.length];
    const length = distance(start, end);
    if (isRectangle(room)) {
      if (value < 24) return "The overall surface must be at least 24 inches.";
      resizeRectangle(Math.abs(end.x - start.x) > Math.abs(end.y - start.y) ? "width" : "height", value);
      return;
    }
    const next = room.map((point) => ({ ...point }));
    next[(index + 1) % room.length] = { x: start.x + (end.x - start.x) / length * value, y: start.y + (end.y - start.y) / length * value };
    if (next.some((point) => point.x < 0 || point.x > VIEW_W || point.y < 0 || point.y > VIEW_H))
      return "The new point is outside the drawing. Adjust the room or the adjoining segment first.";
    if (polygonArea(next) < 24) return "That value collapses the surface.";
    snapshot(); setRoom(next);
  };
  const editNiche = (id: string, changes: Partial<Niche>): string | void => {
    const existing = niches.find((niche) => niche.id === id);
    if (!existing) return "Select a niche first.";
    const next = { ...existing, ...changes };
    const error = nicheError(next, room, items, niches);
    if (error) return error;
    snapshot(); setNiches((current) => current.map((niche) => niche.id === id ? next : niche));
  };
  const addNiche = () => {
    const width = Math.min(24, roomWidth - 4), height = Math.min(16, roomHeight - 4);
    const niche: Niche = { id: uid(), x: bounds.minX + (roomWidth - width) / 2, y: bounds.minY + (roomHeight - height) / 2,
      width, height, depth: 3.5, shelves: [] };
    const error = nicheError(niche, room, items, niches);
    if (error) { setDimensionError(error); return; }
    snapshot(); setNiches((current) => [...current, niche]); setSelectedNicheId(niche.id); setSelectedId(null); setTool("select");
  };
  const updateShelf = (niche: Niche, id: string, changes: Partial<Niche["shelves"][number]>): string | void => {
    const shelves = niche.shelves.map((shelf) => shelf.id === id ? { ...shelf, ...changes } : shelf);
    if (shelves.some((shelf) => shelf.thickness <= 0)) return "Shelf thickness must be greater than zero.";
    const error = nicheError({ ...niche, shelves }, room, items, niches);
    if (error) return error;
    snapshot(); setNiches((current) => current.map((item) => item.id === niche.id ? { ...item, shelves } : item));
  };
  const chooseMethod = (next: LayoutMethod) => {
    snapshot(); setMethod(next);
    if (next === "balanced") setOrigin({ x: ((xCuts.offset % (actualTileW + grout)) + actualTileW + grout) % (actualTileW + grout),
      y: ((yCuts.offset % (actualTileH + grout)) + actualTileH + grout) % (actualTileH + grout) });
    if (next === "center") setOrigin({ x: (roomWidth - actualTileW) / 2, y: (roomHeight - actualTileH) / 2 });
    if (next === "edge") setOrigin({ x: 0, y: 0 });
  };
  const undo = () => {
    const previous = history.at(-1); if (!previous) return;
    setFuture((current) => [currentSnapshot(), ...current]); setHistory((current) => current.slice(0, -1));
    restoreSnapshot(previous); setSelectedId(null);
  };
  const redo = () => {
    const next = future[0]; if (!next) return;
    setHistory((current) => [...current, currentSnapshot()]); setFuture((current) => current.slice(1));
    restoreSnapshot(next); setSelectedId(null);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable=true]") || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z" && event.key.toLowerCase() !== "y") return;
      event.preventDefault();
      if (event.key.toLowerCase() === "y" || event.shiftKey) redo(); else undo();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  const openDimension = (label: string, value: number, commit: (value: number) => string | void) => {
    setDimensionEdit({ label, value, commit }); setDimensionInput(formatLength(value)); setDimensionError("");
  };
  const confirmDimension = () => {
    if (!dimensionEdit) return;
    const value = parseLength(dimensionInput);
    if (value === null || !Number.isFinite(value) || value < 0) { setDimensionError("Enter a valid positive length, for example 5' 3 1/2\" or 1350 mm."); return; }
    const error = dimensionEdit.commit(value);
    if (error) { setDimensionError(error); return; }
    setDimensionEdit(null);
  };

  const roomPath = room.map((point) => `${point.x},${point.y}`).join(" ");
  const draftPath = draftRoom.map((point) => `${point.x},${point.y}`).join(" ");
  const roomCenter = polygonCenter(room);
  const patternX = bounds.minX + origin.x;
  const patternY = bounds.minY + origin.y;
  const pitchX = actualTileW + grout;
  const pitchY = actualTileH + grout;
  const startX = bounds.minX + origin.x;
  const startY = bounds.minY + origin.y;
  const startLeftReference = Math.max(0, startX - bounds.minX);
  const startRightReference = Math.max(0, bounds.maxX - startX);
  const startTopReference = Math.max(0, startY - bounds.minY);
  const startBottomReference = Math.max(0, bounds.maxY - startY);
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
  const guideLeftFace = guideWallMidpoint ? guideWallMidpoint.x - guideHalfThickness : 0;
  const guideRightFace = guideWallMidpoint ? guideWallMidpoint.x + guideHalfThickness : 0;
  const guideTopFace = guideWallMidpoint ? guideWallMidpoint.y - guideHalfThickness : 0;
  const guideBottomFace = guideWallMidpoint ? guideWallMidpoint.y + guideHalfThickness : 0;
  const setWallOffset = (side: "left" | "right" | "top" | "bottom", value: number): string | void => {
    if (!dimensionedWall || !guideWallMidpoint) return;
    const halfThickness = dimensionedWall.thickness / 2;
    if (value > (side === "left" || side === "right" ? roomWidth : roomHeight) - dimensionedWall.thickness)
      return "This offset exceeds the space between the finished faces. Adjust the wall or opposite edge first.";
    snapshot();
    if (side === "left" || side === "right") {
      const rawTarget = side === "left" ? bounds.minX + value + halfThickness : bounds.maxX - value - halfThickness;
      const target = clamp(rawTarget, bounds.minX + halfThickness, bounds.maxX - halfThickness);
      const delta = target - guideWallMidpoint.x;
      setItems((current) => current.map((item) => item.id === dimensionedWall.id ? {
        ...item,
        start: { ...item.start, x: item.start.x + delta },
        end: { ...item.end, x: item.end.x + delta },
      } : item));
    } else {
      const rawTarget = side === "top" ? bounds.minY + value + halfThickness : bounds.maxY - value - halfThickness;
      const target = clamp(rawTarget, bounds.minY + halfThickness, bounds.maxY - halfThickness);
      const delta = target - guideWallMidpoint.y;
      setItems((current) => current.map((item) => item.id === dimensionedWall.id ? {
        ...item,
        start: { ...item.start, y: item.start.y + delta },
        end: { ...item.end, y: item.end.y + delta },
      } : item));
    }
  };
  const editStart = (side: "left" | "right" | "top" | "bottom", value: number): string | void => {
    const horizontal = side === "left" || side === "right";
    const span = horizontal ? roomWidth : roomHeight;
    if (value > span) return `The start line must fall within the ${surfaceNameLower} (${formatLength(span)}).`;
    const offset = side === "left" || side === "top" ? value : span - value;
    snapshot();
    setOrigin((current) => horizontal ? { ...current, x: offset } : { ...current, y: offset });
  };
  const tileFill = {
    transparent: "#d4b477",
    porcelain: "#ece9df",
    stone: "url(#stone-fill)",
    marble: "url(#marble-fill)",
    concrete: "url(#concrete-fill)",
  }[tileAppearance];
  const tileOpacity = tileAppearance === "transparent" ? .2 : .88;
  const materialMin = materialUnit === "in" ? 1 : materialUnit === "mm" ? 25.4 : 2.54;
  const materialStep = materialUnit === "in" ? .125 : materialUnit === "mm" ? 1 : .1;
  const groutMin = materialUnit === "in" ? .0625 : materialUnit === "mm" ? 1 : .1;
  const groutStep = materialUnit === "in" ? .0625 : materialUnit === "mm" ? .5 : .05;
  const surfaceName = surface === "wall" ? "Wall" : "Floor";
  const surfaceNameLower = surface;

  return (
    <main className="app-shell">
      <input ref={importInputRef} hidden type="file" accept=".json,.buildr.json,application/json" onChange={(event)=>{void importShared(event.target.files?.[0]);event.currentTarget.value=""}}/>
      <header className="topbar">
        <div className="brand" aria-label="Layout by Buildr">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Layout</span><span className="brand-family">by Buildr</span>
        </div>
        <label className="project-name">
          <input aria-label="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} />
          <ChevronDown size={15} aria-hidden="true" />
        </label>
        <div className="header-actions">
          <span className={`save-state ${saved && syncState === "saved" ? "is-saved" : ""} ${syncState}`}>
            {syncState === "offline" || syncState === "failed" ? <CloudOff size={14} /> : saved ? <Check size={14} /> : <Save size={14} />}
            {!saved ? "Saving" : { device: "Device saved", saving: "Syncing", saved: "Cloud saved", offline: "Offline · device saved", failed: "Sync failed · device saved", conflict: "Needs review" }[syncState]}
          </span>
          <button className="icon-button" onClick={() => { saveCurrentLayout(); setLibraryOpen(true); }} aria-label="Saved layouts" title="Saved layouts"><FolderOpen size={18} /></button>
          <button className="icon-button" onClick={()=>importInputRef.current?.click()} aria-label="Import shared project" title="Import shared project"><Upload size={18}/></button>
          <button className="icon-button" onClick={exportShared} aria-label="Export shared project" title="Export shared project"><Download size={18}/></button>
          {!previewOnly && <button className="icon-button" onClick={returnToBuildr} aria-label="Return result to Buildr" title="Return result to Buildr"><ExternalLink size={18}/></button>}
          {!previewOnly && <SuiteAccountButton />}
          <button className="icon-button" onClick={printLayout} aria-label="Print layout" title="Print layout"><Printer size={18} /></button>
          <button className="icon-button" onClick={undo} disabled={!history.length} aria-label="Undo"><Undo2 size={18} /></button>
          <button className="icon-button" onClick={redo} disabled={!future.length} aria-label="Redo"><Redo2 size={18} /></button>
        </div>
      </header>
      {previewOnly && <div className="review-banner">Review preview · Your test layouts save only on this device. Buildr job syncing is disabled here.</div>}
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
      {dimensionEdit && <div className="dimension-backdrop" onPointerDown={() => setDimensionEdit(null)}>
        <form className="dimension-dialog" role="dialog" aria-modal="true" aria-labelledby="dimension-title" onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => { event.preventDefault(); confirmDimension(); }}>
          <span className="eyebrow">Exact measurement</span>
          <h2 id="dimension-title">{dimensionEdit.label}</h2>
          <p>Current: {formatLength(dimensionEdit.value)}. Enter inches, feet and inches, a fraction, mm, cm, or m.</p>
          <input autoFocus aria-label={dimensionEdit.label} value={dimensionInput} onChange={(event) => { setDimensionInput(event.target.value); setDimensionError(""); }} />
          {dimensionError && <p className="edit-error" role="alert">{dimensionError}</p>}
          <div className="button-row"><button type="button" className="secondary" onClick={() => setDimensionEdit(null)}>Cancel</button><button type="submit" className="primary">Apply dimension</button></div>
        </form>
      </div>}

      {libraryOpen && <div className="library-backdrop" role="presentation" onPointerDown={() => setLibraryOpen(false)}>
        <section className="layout-library" role="dialog" aria-modal="true" aria-labelledby="layout-library-title" onPointerDown={(event) => event.stopPropagation()}>
          <div className="library-heading">
            <span><span className="eyebrow">Saved work</span><strong id="layout-library-title">Layouts</strong></span>
            <button className="library-close" onClick={() => setLibraryOpen(false)} aria-label="Close saved layouts"><X size={19} /></button>
          </div>
          <label className="library-name-field"><span>Current layout name</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
          <button className="primary new-layout-button" onClick={createNewLayout}><Plus size={17} /> New layout</button>
          <div className="layout-list">
            {[...savedLayouts].sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || b.updatedAt - a.updatedAt).map((layout) => <article className={`layout-card ${layout.id === activeLayoutId ? "active" : ""} ${layout.archivedAt ? "archived" : ""}`} key={layout.id}>
              <button className="layout-open" onClick={() => openSavedLayout(layout.id)}>
                <strong>{layout.projectName}</strong>
                <span>{layout.surface === "wall" ? "Wall" : "Floor"} · {formatLength(roomBounds(layout.room).maxX - roomBounds(layout.room).minX)} × {formatLength(roomBounds(layout.room).maxY - roomBounds(layout.room).minY)}</span>
                <small>{layout.archivedAt ? "Archived · " : layout.id === activeLayoutId ? "Currently editing · " : ""}Saved {new Date(layout.updatedAt).toLocaleString()}</small>
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
          {([ ["select", MousePointer2, "Select"], ["pan", Hand, "Pan"], ["floor", Move, "Tile field"], ["room", SquareDashedMousePointer, surface === "wall" ? "Wall area" : "Room"], ["wall", BrickWall, surface === "wall" ? "Feature" : "Wall"], ["opening", DoorOpen, "Opening"] ] as const).map(([value, Icon, label]) => (
            <button key={value} className={tool === value ? "active" : ""} onClick={() => { setTool(value); setDraftRoom([]); setSelectedId(null); }} aria-pressed={tool === value}>
              <Icon size={21} /><span>{label}</span>
            </button>
          ))}
        </nav>

        <section className="canvas-column">
          <header className="print-only print-header">
            <div><span>LAYOUT · {surfaceName.toUpperCase()}</span><strong>{projectName}</strong></div>
            <dl>
              <div><dt>{surfaceName}</dt><dd>{formatLength(roomWidth)} × {formatLength(roomHeight)}</dd></div>
              <div><dt>Tile</dt><dd>{formatLength(tileWidth)} × {formatLength(tileHeight)}</dd></div>
              <div><dt>Grout</dt><dd>{formatLength(grout)}</dd></div>
              <div><dt>{surfaceName} area</dt><dd>{areaSqFt.toFixed(1)} ft²</dd></div>
            </dl>
          </header>
          <div className="canvas-toolbar">
            <div className="mode-copy">
              <strong>{{ select: "Select and adjust", pan: "Move around the plan", floor: "Move the tile field", wall: surface === "wall" ? "Draw a feature line" : "Draw a straight wall", opening: "Mark an opening", room: surface === "wall" ? "Draw the wall area" : "Draw the room perimeter" }[tool]}</strong>
              <span>{{ select: "Drag a selected feature to move it, or drag either end to resize it.", pan: "Drag the work area after zooming in.", floor: `Grab the ${surfaceNameLower} tile field and move the entire layout.`, wall: surface === "wall" ? "Use feature lines for ledges, borders, or other cut references." : "Walls snap straight. Hold Alt only when you need an angle.", opening: "Openings snap straight along the nearest boundary.", room: surface === "wall" ? "Tap each corner of the tiled wall area, then finish the surface." : "Tap each corner, then finish the room." }[tool]}</span>
            </div>
            {tool === "room" && <div className="draft-actions"><button className="text-button" onClick={cancelRoom}>Cancel</button><button className="primary small" disabled={draftRoom.length < 3} onClick={finishRoom}>Finish {surface === "wall" ? "surface" : "room"}</button></div>}
            <div className="history-controls" aria-label="Edit history">
              <button onClick={undo} disabled={!history.length} aria-label="Undo" title="Undo"><Undo2 size={16} /> Undo</button>
              <button onClick={redo} disabled={!future.length} aria-label="Redo" title="Redo"><Redo2 size={16} /> Redo</button>
            </div>
            <div className="zoom-controls">
              <button onClick={() => changeZoom(zoom - 0.2)} aria-label="Zoom out"><ZoomOut size={17} /></button>
              <span>{Math.round(zoom * 100)}%</span>
              <button onClick={() => changeZoom(zoom + 0.2)} aria-label="Zoom in"><ZoomIn size={17} /></button>
              <button className="fit-button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Fit plan">Fit</button>
            </div>
          </div>

          <div className={`canvas-wrap tool-${tool}`}>
            <svg ref={svgRef} className="drawing-canvas" viewBox={printing ? `0 0 ${VIEW_W} ${VIEW_H}` : `${pan.x} ${pan.y} ${VIEW_W / zoom} ${VIEW_H / zoom}`}
              onPointerDownCapture={beginPointerTracking} onPointerMoveCapture={movePointerTracking}
              onPointerUpCapture={endPointerTracking} onPointerCancelCapture={endPointerTracking}
              onPointerDown={startDrawing} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer}
              onWheel={(event) => { event.preventDefault(); changeZoom(zoom * (event.deltaY > 0 ? .9 : 1.1)); }}
              role="group" aria-label={`Editable ${surfaceNameLower} tile layout`}>
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
                <pattern id="tile-pattern" x={patternX} y={patternY} width={actualTileW + grout} height={actualTileH + grout} patternUnits="userSpaceOnUse">
                  <rect width={actualTileW} height={actualTileH} rx=".45" fill={tileFill} fillOpacity={tileOpacity} stroke="#9e7a35" strokeWidth=".45" />
                </pattern>
                <pattern id="running-pattern" x={patternX} y={patternY} width={actualTileW + grout} height={(actualTileH + grout) * (pattern === "third" ? 3 : 2)} patternUnits="userSpaceOnUse">
                  {Array.from({ length: pattern === "third" ? 3 : 2 }, (_, row) => {
                    const shift = row * (actualTileW + grout) / (pattern === "third" ? 3 : 2);
                    return [-1, 0, 1].map((column) => <rect key={`${row}-${column}`} x={column * (actualTileW + grout) + shift} y={row * (actualTileH + grout)}
                      width={actualTileW} height={actualTileH} fill={tileFill} fillOpacity={tileOpacity} stroke="#9e7a35" strokeWidth=".45" />);
                  })}
                </pattern>
                <pattern id="diagonal-pattern" x={patternX} y={patternY} width={actualTileW + grout} height={actualTileH + grout}
                  patternUnits="userSpaceOnUse" patternTransform={`rotate(45 ${patternX} ${patternY})`}>
                  <rect width={actualTileW} height={actualTileH} fill={tileFill} fillOpacity={tileOpacity} stroke="#9e7a35" strokeWidth=".45" />
                </pattern>
                <pattern id="herringbone-pattern" x={patternX} y={patternY} width={2 * (actualTileW + grout)} height={2 * (actualTileW + grout)} patternUnits="userSpaceOnUse">
                  {[0, 1, 2, 3].map((row) => <g key={row} transform={`translate(${(row % 2) * (actualTileW + grout)} ${row * (actualTileW + grout) / 2})`}>
                    <rect width={actualTileW} height={actualTileH} fill={tileFill} fillOpacity={tileOpacity} stroke="#9e7a35" strokeWidth=".45" />
                    <rect x={actualTileW + grout} width={actualTileH} height={actualTileW} fill={tileFill} fillOpacity={tileOpacity} stroke="#9e7a35" strokeWidth=".45" />
                  </g>)}
                </pattern>
                <clipPath id="room-clip"><polygon points={roomPath} /></clipPath>
                <mask id="field-mask" maskUnits="userSpaceOnUse" x="0" y="0" width={VIEW_W} height={VIEW_H}>
                  <polygon points={roomPath} fill="white" />
                  {niches.map((niche) => <rect key={niche.id} x={niche.x} y={niche.y} width={niche.width} height={niche.height} fill="black" />)}
                </mask>
              </defs>
              <rect width="100%" height="100%" fill="url(#major-grid)" />
              <polygon points={roomPath} fill="#fff" stroke="#173f32" strokeWidth="2.25" strokeLinejoin="round" />
              {showTile && <rect x={bounds.minX - actualTileW * 2} y={bounds.minY - actualTileH * 2} width={roomWidth + actualTileW * 4} height={roomHeight + actualTileH * 4}
                fill={`url(#${pattern === "stack" ? "tile-pattern" : pattern === "half" || pattern === "third" ? "running-pattern" : pattern === "diagonal" ? "diagonal-pattern" : "herringbone-pattern"})`}
                mask="url(#field-mask)" />}
              {surface === "wall" && niches.map((niche) => <g key={niche.id} className={`niche-drawing ${selectedNicheId === niche.id ? "selected" : ""}`}>
                <rect className="niche-back" x={niche.x} y={niche.y} width={niche.width} height={niche.height}
                  onPointerDown={(event) => beginNicheDrag(event, niche, "niche")} />
                <rect className="niche-back-tile" x={niche.x + 1} y={niche.y + 1} width={niche.width - 2} height={niche.height - 2}
                  fill={showTile ? "url(#tile-pattern)" : "none"} pointerEvents="none" />
                <path className="niche-returns" d={`M${niche.x} ${niche.y}l2 2h${niche.width - 4}l2 -2M${niche.x} ${niche.y + niche.height}l2 -2h${niche.width - 4}l2 2`} pointerEvents="none" />
                {niche.shelves.map((shelf) => {
                  const y = niche.y + niche.height - shelf.fromBottom - shelf.thickness;
                  return <g key={shelf.id}>
                    <rect className="niche-shelf" x={niche.x + 1} y={y} width={niche.width - 2} height={shelf.thickness}
                      onPointerDown={(event) => beginShelfDrag(event, niche, shelf)} />
                    {selectedNicheId === niche.id && <DimensionBubble x={niche.x + niche.width / 2} y={y - 2} inches={shelf.fromBottom} width={27}
                      label="shelf from sill" onClick={() => openDimension("Shelf from niche sill", shelf.fromBottom, (value) => updateShelf(niche, shelf.id, { fromBottom: value }))} />}
                  </g>;
                })}
                {selectedNicheId === niche.id && <>
                  <DimensionBubble x={niche.x + niche.width / 2} y={niche.y - 5} inches={niche.width} width={27} label="niche width" onClick={() => openDimension("Niche width · left edge fixed", niche.width, (value) => editNiche(niche.id, { width: value }))} />
                  <DimensionBubble x={niche.x + niche.width + 10} y={niche.y + niche.height / 2} inches={niche.height} width={27} label="niche height" onClick={() => openDimension("Niche height · top edge fixed", niche.height, (value) => editNiche(niche.id, { height: value }))} />
                  <DimensionBubble x={niche.x + niche.width / 2} y={niche.y + niche.height + 6} inches={bounds.maxY - niche.y - niche.height} width={30} label="from floor" onClick={() => openDimension("Niche sill from finished floor", bounds.maxY - niche.y - niche.height, (value) => editNiche(niche.id, { y: bounds.maxY - value - niche.height }))} />
                  <DimensionBubble x={niche.x - 12} y={niche.y + niche.height / 2} inches={niche.x - bounds.minX} width={27} label="from left" onClick={() => openDimension("Niche from left inside wall face", niche.x - bounds.minX, (value) => editNiche(niche.id, { x: bounds.minX + value }))} />
                  <DimensionBubble x={niche.x + niche.width + 11} y={niche.y - 6} inches={bounds.maxX - niche.x - niche.width} width={27} label="from right" onClick={() => openDimension("Niche from right inside wall face", bounds.maxX - niche.x - niche.width, (value) => editNiche(niche.id, { x: bounds.maxX - value - niche.width }))} />
                  <DimensionBubble x={niche.x - 12} y={niche.y - 6} inches={niche.y - bounds.minY} width={27} label="from top" onClick={() => openDimension("Niche from top of wall", niche.y - bounds.minY, (value) => editNiche(niche.id, { y: bounds.minY + value }))} />
                  <circle className="niche-handle" cx={niche.x + niche.width} cy={niche.y + niche.height} r="3.4" onPointerDown={(event) => beginNicheDrag(event, niche, "niche-resize")} />
                </>}
              </g>)}
              {items.map((item) => { const isSelected = selectedId === item.id; return (
                <g key={item.id} className={`plan-item ${item.type} ${isSelected ? "selected" : ""}`} onPointerDown={(event) => beginItemDrag(event, item)}>
                  <line x1={item.start.x} y1={item.start.y} x2={item.end.x} y2={item.end.y} strokeWidth={item.type === "wall" ? item.thickness : Math.max(2.25, item.thickness * .55)} />
                  {item.type === "opening" && <line className="opening-center" x1={item.start.x} y1={item.start.y} x2={item.end.x} y2={item.end.y} />}
                  <DimensionBubble x={(item.start.x + item.end.x) / 2} y={(item.start.y + item.end.y) / 2 - item.thickness / 2 - 2}
                    inches={distance(item.start, item.end)} width={22} label={item.type === "opening" ? "opening width" : "wall length"}
                    onClick={() => { setSelectedId(item.id); openDimension(item.type === "opening" ? "Opening width · first end fixed" : "Wall length · first end fixed", distance(item.start, item.end), (value) => updateItemLength(item.id, value)); }} />
                  {isSelected && <><circle cx={item.start.x} cy={item.start.y} r="2.7" onPointerDown={(event) => beginEndpointDrag(event, item.id, "start")} /><circle cx={item.end.x} cy={item.end.y} r="2.7" onPointerDown={(event) => beginEndpointDrag(event, item.id, "end")} /></>}
                </g>
              ); })}
              {selected?.type === "opening" && <g className="opening-dimensions">
                <DimensionBubble x={(bounds.minX + Math.min(selected.start.x, selected.end.x)) / 2} y={Math.min(selected.start.y, selected.end.y) - 7}
                  inches={Math.min(selected.start.x, selected.end.x) - bounds.minX} label="from left" onClick={() => openDimension("Opening from left", Math.min(selected.start.x, selected.end.x) - bounds.minX, (value) => editItemOffset(selected.id, "left", value))} />
                <DimensionBubble x={(bounds.maxX + Math.max(selected.start.x, selected.end.x)) / 2} y={Math.min(selected.start.y, selected.end.y) - 7}
                  inches={bounds.maxX - Math.max(selected.start.x, selected.end.x)} label="from right" onClick={() => openDimension("Opening from right", bounds.maxX - Math.max(selected.start.x, selected.end.x), (value) => editItemOffset(selected.id, "right", value))} />
                {surface === "wall" && <DimensionBubble x={Math.max(selected.start.x, selected.end.x) + 12} y={(bounds.maxY + Math.max(selected.start.y, selected.end.y)) / 2}
                  inches={bounds.maxY - Math.max(selected.start.y, selected.end.y)} label="from floor" onClick={() => openDimension("Opening from finished floor", bounds.maxY - Math.max(selected.start.y, selected.end.y), (value) => editItemOffset(selected.id, "bottom", value))} />}
              </g>}
              {showTile && <g className="chalk-guide" clipPath="url(#room-clip)">
                <line className="chalk-axis" x1={startX} y1={bounds.minY} x2={startX} y2={bounds.maxY} />
                <line className="chalk-axis" x1={bounds.minX} y1={startY} x2={bounds.maxX} y2={startY} />
                <circle cx={startX} cy={startY} r="1.8" />
                <DimensionBubble x={(bounds.minX + startX) / 2} y={startY} inches={startLeftReference} label="from left" onClick={() => openDimension("Start line from left", startLeftReference, (value) => editStart("left", value))} />
                <DimensionBubble x={(startX + bounds.maxX) / 2} y={startY} inches={startRightReference} label="from right" onClick={() => openDimension("Start line from right", startRightReference, (value) => editStart("right", value))} />
                <DimensionBubble x={startX} y={(bounds.minY + startY) / 2} inches={startTopReference} label="from top" onClick={() => openDimension("Start line from top", startTopReference, (value) => editStart("top", value))} />
                <DimensionBubble x={startX} y={(startY + bounds.maxY) / 2} inches={startBottomReference} label="from bottom" onClick={() => openDimension("Start line from bottom", startBottomReference, (value) => editStart("bottom", value))} />
                <g className="chalk-label" transform={`translate(${startX + 12} ${startY - 7})`}><rect x="-10" y="-3" width="20" height="6" rx="2" /><text y="1">CHALK CROSSING</text></g>
              </g>}
              <g className="dimensions">
                {room.map((point, index) => { const next = room[(index + 1) % room.length]; const midpoint = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 }; const labelPoint = outsideDimensionPoint(point, next, roomCenter); return (
                  <g key={index}><line x1={midpoint.x} y1={midpoint.y} x2={labelPoint.x} y2={labelPoint.y} pointerEvents="none" />
                    <DimensionBubble x={labelPoint.x} y={labelPoint.y} inches={distance(point, next)} width={22}
                      label={isRectangle(room) ? (Math.abs(next.x - point.x) > Math.abs(next.y - point.y) ? "width" : "height") : `segment ${index + 1}`}
                      onClick={() => openDimension(isRectangle(room) ? (Math.abs(next.x - point.x) > Math.abs(next.y - point.y) ? "Overall width · left edge fixed" : "Overall height · top edge fixed") : `Wall segment ${index + 1} · start point fixed`, distance(point, next), (value) => editSegment(index, value))} />
                  </g>
                ); })}
              </g>
              {dimensionedWall && guideWallMidpoint && guideWallOrientation === "vertical" && <g className="wall-offset-guides">
                <line x1={bounds.minX} y1={guideWallMidpoint.y} x2={guideLeftFace} y2={guideWallMidpoint.y} />
                <line x1={guideRightFace} y1={guideWallMidpoint.y} x2={bounds.maxX} y2={guideWallMidpoint.y} />
                <DimensionBubble x={(bounds.minX + guideLeftFace) / 2} y={guideWallMidpoint.y} inches={guideLeftFace - bounds.minX} label="from left" onClick={() => openDimension("Wall face from left", guideLeftFace - bounds.minX, (value) => setWallOffset("left", value))} />
                <DimensionBubble x={(guideRightFace + bounds.maxX) / 2} y={guideWallMidpoint.y} inches={bounds.maxX - guideRightFace} label="from right" onClick={() => openDimension("Wall face from right", bounds.maxX - guideRightFace, (value) => setWallOffset("right", value))} />
              </g>}
              {dimensionedWall && guideWallMidpoint && guideWallOrientation === "horizontal" && <g className="wall-offset-guides">
                <line x1={guideWallMidpoint.x} y1={bounds.minY} x2={guideWallMidpoint.x} y2={guideTopFace} />
                <line x1={guideWallMidpoint.x} y1={guideBottomFace} x2={guideWallMidpoint.x} y2={bounds.maxY} />
                <DimensionBubble x={guideWallMidpoint.x} y={(bounds.minY + guideTopFace) / 2} inches={guideTopFace - bounds.minY} label="from top" onClick={() => openDimension("Wall face from top", guideTopFace - bounds.minY, (value) => setWallOffset("top", value))} />
                <DimensionBubble x={guideWallMidpoint.x} y={(guideBottomFace + bounds.maxY) / 2} inches={bounds.maxY - guideBottomFace} label={surface === "wall" ? "from floor" : "from bottom"} onClick={() => openDimension(surface === "wall" ? "Feature from finished floor" : "Wall face from bottom", bounds.maxY - guideBottomFace, (value) => setWallOffset("bottom", value))} />
              </g>}
              {drag?.kind === "draw" && <g className="draft-line" pointerEvents="none"><line x1={drag.start.x} y1={drag.start.y} x2={drag.current.x} y2={drag.current.y} strokeWidth={tool === "wall" ? wallThickness : 2.5} /><text x={(drag.start.x + drag.current.x) / 2} y={(drag.start.y + drag.current.y) / 2 - 4}>{formatLength(distance(drag.start, drag.current))}</text></g>}
              {drag?.kind === "draw" && tool === "wall" && Math.abs(drag.current.x - drag.start.x) < 1 && <g className="draft-offset-guides" pointerEvents="none">
                <line x1={bounds.minX} y1={(drag.start.y + drag.current.y) / 2} x2={drag.start.x - wallThickness / 2} y2={(drag.start.y + drag.current.y) / 2} />
                <line x1={drag.start.x + wallThickness / 2} y1={(drag.start.y + drag.current.y) / 2} x2={bounds.maxX} y2={(drag.start.y + drag.current.y) / 2} />
                <text x={(bounds.minX + drag.start.x - wallThickness / 2) / 2} y={(drag.start.y + drag.current.y) / 2}>{formatLength(drag.start.x - wallThickness / 2 - bounds.minX)} from left</text>
                <text x={(drag.start.x + wallThickness / 2 + bounds.maxX) / 2} y={(drag.start.y + drag.current.y) / 2}>{formatLength(bounds.maxX - drag.start.x - wallThickness / 2)} from right</text>
              </g>}
              {drag?.kind === "draw" && tool === "wall" && Math.abs(drag.current.y - drag.start.y) < 1 && <g className="draft-offset-guides" pointerEvents="none">
                <line x1={(drag.start.x + drag.current.x) / 2} y1={bounds.minY} x2={(drag.start.x + drag.current.x) / 2} y2={drag.start.y - wallThickness / 2} />
                <line x1={(drag.start.x + drag.current.x) / 2} y1={drag.start.y + wallThickness / 2} x2={(drag.start.x + drag.current.x) / 2} y2={bounds.maxY} />
                <text x={(drag.start.x + drag.current.x) / 2} y={(bounds.minY + drag.start.y - wallThickness / 2) / 2}>{formatLength(drag.start.y - wallThickness / 2 - bounds.minY)} from top</text>
                <text x={(drag.start.x + drag.current.x) / 2} y={(drag.start.y + wallThickness / 2 + bounds.maxY) / 2}>{formatLength(bounds.maxY - drag.start.y - wallThickness / 2)} from bottom</text>
              </g>}
              {draftRoom.length > 0 && <g className="draft-room" pointerEvents="none"><polyline points={draftPath} />{draftRoom.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="2" />)}</g>}
            </svg>
            <div className="scale-note">Each small square = 3 inches · Openings snap to the nearest boundary · Drag the tile field to adjust the starting position</div>
          </div>
          <section className="print-only print-summary">
            <div><span>Vertical chalk line</span><strong>{formatLength(startLeftReference)} from left / {formatLength(startRightReference)} from right</strong></div>
            <div><span>Horizontal chalk line</span><strong>{formatLength(startTopReference)} from top / {formatLength(startBottomReference)} from bottom</strong></div>
            <div><span>Material estimate</span><strong>{tileCount} tiles including {wastePercent}% waste · {mortarBags} × 50 lb mortar bags</strong></div>
            <div><span>Pattern</span><strong>{pattern === "stack" ? "Straight stack" : pattern === "half" ? "½ running bond" : pattern === "third" ? "⅓ running bond" : pattern === "diagonal" ? "Diagonal" : "Herringbone"} · {method} layout</strong></div>
            {referenceLine && <div><span>Shared wall reference</span><strong>{referenceLine}</strong></div>}
            {niches.map((niche, index) => <div key={niche.id}><span>Niche {index + 1}</span><strong>{formatLength(niche.width)} × {formatLength(niche.height)} × {formatLength(niche.depth)} deep · {formatLength(bounds.maxY - niche.y - niche.height)} from finished floor · {formatLength(niche.x - bounds.minX)} from left · {niche.shelves.map((shelf) => `${formatLength(shelf.fromBottom)} shelf, ${formatLength(shelf.thickness)} thick`).join("; ")}</strong></div>)}
          </section>
        </section>

        <aside className="inspector">
          <div className="workflow-steps" aria-label="Layout workflow"><span>1 Surface</span><span>2 Tile & pattern</span><span>3 Position</span><span>4 Cuts</span><span>5 Save / print</span></div>
          {dimensionError && !dimensionEdit && <p className="edit-error" role="alert">{dimensionError}</p>}
          {selectedNiche && <section className="panel selected-panel">
            <div className="panel-heading"><span className="eyebrow">Selected niche</span><strong>Drag to move · handle to resize</strong></div>
            <div className="dimension-action-grid">
              {([
                ["Width", selectedNiche.width, (value: number) => editNiche(selectedNiche.id, { width: value })],
                ["Height", selectedNiche.height, (value: number) => editNiche(selectedNiche.id, { height: value })],
                ["Depth", selectedNiche.depth, (value: number) => editNiche(selectedNiche.id, { depth: value })],
                ["From left", selectedNiche.x - bounds.minX, (value: number) => editNiche(selectedNiche.id, { x: bounds.minX + value })],
                ["From right", bounds.maxX - selectedNiche.x - selectedNiche.width, (value: number) => editNiche(selectedNiche.id, { x: bounds.maxX - value - selectedNiche.width })],
                ["From floor", bounds.maxY - selectedNiche.y - selectedNiche.height, (value: number) => editNiche(selectedNiche.id, { y: bounds.maxY - value - selectedNiche.height })],
              ] as [string, number, (value: number) => string | void][]).map(([label, value, commit]) =>
                <button key={label} onClick={() => openDimension(`Niche ${label.toLowerCase()}`, value, commit)}><span>{label}</span><strong>{formatLength(value)}</strong></button>)}
            </div>
            <div className="shelf-heading"><strong>Shelves · {selectedNiche.shelves.length}</strong>
              <button className="secondary" onClick={() => {
                const shelf = { id: uid(), fromBottom: selectedNiche.height * (selectedNiche.shelves.length + 1) / (selectedNiche.shelves.length + 2), thickness: .5 };
                snapshot(); setNiches((current) => current.map((item) => item.id === selectedNiche.id ? { ...item, shelves: [...item.shelves, shelf] } : item));
              }}><Plus size={14} /> Add shelf</button></div>
            {selectedNiche.shelves.map((shelf, index) => <div key={shelf.id} className="shelf-row">
              <button onClick={() => openDimension(`Shelf ${index + 1} from niche sill`, shelf.fromBottom, (value) => updateShelf(selectedNiche, shelf.id, { fromBottom: value }))}>Shelf {index + 1}: {formatLength(shelf.fromBottom)} high</button>
              <button onClick={() => openDimension(`Shelf ${index + 1} thickness`, shelf.thickness, (value) => updateShelf(selectedNiche, shelf.id, { thickness: value }))}>{formatLength(shelf.thickness)} thick</button>
              <button aria-label={`Remove shelf ${index + 1}`} onClick={() => { snapshot(); setNiches((current) => current.map((item) => item.id === selectedNiche.id ? { ...item, shelves: item.shelves.filter((s) => s.id !== shelf.id) } : item)); }}><X size={14} /></button>
            </div>)}
            <button className="delete-button" onClick={() => { snapshot(); setNiches((current) => current.filter((item) => item.id !== selectedNiche.id)); setSelectedNicheId(null); }}>Delete niche</button>
          </section>}
          {selected ? <section className="panel selected-panel">
            <div className="panel-heading"><span className="eyebrow">Selected</span><strong>{selected.type === "wall" ? (surface === "wall" ? "Feature line" : "Wall") : "Opening"}</strong></div>
            <NumberField label="Length" value={distance(selected.start, selected.end)} onChange={updateSelectedLength} suffix="in" min={1} />
            <NumberField label={selected.type === "wall" ? "Thickness" : "Wall thickness"} value={selected.thickness} onChange={(value) => { snapshot(); setItems((current) => current.map((item) => item.id === selected.id ? constrainWallToBounds({ ...item, thickness: value }, bounds) : item)); }} suffix="in" min={1} step={.5} />
            {selected.type === "wall" && guideWallOrientation === "vertical" && <div className="field-row wall-offset-fields">
              <OffsetField label="From left" inches={guideLeftFace - bounds.minX} onCommit={(value) => setWallOffset("left", value)} />
              <OffsetField label="From right" inches={bounds.maxX - guideRightFace} onCommit={(value) => setWallOffset("right", value)} />
            </div>}
            {selected.type === "wall" && guideWallOrientation === "horizontal" && <div className="field-row wall-offset-fields">
              <OffsetField label="From top" inches={guideTopFace - bounds.minY} onCommit={(value) => setWallOffset("top", value)} />
              <OffsetField label={surface === "wall" ? "From finished floor" : "From bottom"} inches={bounds.maxY - guideBottomFace} onCommit={(value) => { const error = setWallOffset("bottom", value); if (error) setDimensionError(error); }} />
            </div>}
            {selected.type === "wall" && <p className="selection-hint">Drag the {surface === "wall" ? "feature" : "wall"} to reposition it. Gold dimensions measure from both surface borders to its nearest face. Use the fields above to enter an exact offset. The guides are visible only while it is selected.</p>}
            {selected.type === "opening" && <button className="favor-button" onClick={favorOpening}><Sparkles size={16} /> Favor this opening</button>}
            <button className="delete-button" onClick={() => { snapshot(); setItems((current) => current.filter((item) => item.id !== selected.id)); setSelectedId(null); }}>Delete {selected.type}</button>
          </section> : <section className="panel">
            <div className="panel-heading"><span className="eyebrow">Surface</span><strong>{surfaceName} · {isRectangle(room) ? `${formatLength(roomWidth)} × ${formatLength(roomHeight)}` : "Custom shape"}</strong></div>
            <div className="surface-picker" aria-label="Tile surface">
              <button className={surface === "floor" ? "active" : ""} aria-pressed={surface === "floor"} onClick={() => { snapshot(); setSurface("floor"); }}>Floor</button>
              <button className={surface === "wall" ? "active" : ""} aria-pressed={surface === "wall"} onClick={() => { snapshot(); setSurface("wall"); }}>Wall</button>
            </div>
            <p className="surface-help">Each saved layout represents one tiled surface. Create another layout for each additional wall.</p>
            {surface === "wall" && <><button className="primary" onClick={addNiche}><Plus size={16} /> Add niche</button>
              <label className="field"><span>Shared grout reference for related shower walls</span><input value={referenceLine} placeholder="e.g. Back wall · 42 in above finished floor" onChange={(event) => { snapshot(); setReferenceLine(event.target.value); }} /></label>
              <p className="surface-help">Wall height is measured from the finished floor; widths use inside finished faces. Give related walls the same reference and set the start line to that height.</p></>}
            {isRectangle(room) && <div className="field-row"><NumberField label="Width" value={roomWidth} onChange={(value) => resizeRectangle("width", value)} suffix="in" min={24} /><NumberField label={surface === "wall" ? "Height" : "Length"} value={roomHeight} onChange={(value) => resizeRectangle("height", value)} suffix="in" min={24} /></div>}
            {surface === "floor" && <NumberField label="New wall thickness" value={wallThickness} onChange={(value) => { snapshot(); setWallThickness(value); }} suffix="in" min={1} step={.5} />}
          </section>}

          <section className="panel tile-panel">
            <div className="panel-heading inline-heading"><span><span className="eyebrow">Material</span><strong>Tile layout</strong></span><label className="switch"><input aria-label="Show tile layout" type="checkbox" checked={showTile} onChange={(event) => { snapshot(); setShowTile(event.target.checked); }} /><span aria-hidden="true" /></label></div>
            <div className="material-units" aria-label="Tile measurement unit">
              {(["in", "mm", "cm"] as MaterialUnit[]).map((unit) => <button key={unit} className={materialUnit === unit ? "active" : ""} onClick={() => { snapshot(); setMaterialUnit(unit); }} aria-pressed={materialUnit === unit}>{unit}</button>)}
            </div>
            <div className="field-row">
              <NumberField label="Tile width" value={displayUnit(tileWidth, materialUnit)} onChange={(value) => { snapshot(); setTileWidth(inchesFromUnit(value, materialUnit)); }} suffix={materialUnit} min={materialMin} step={materialStep} />
              <NumberField label="Tile length" value={displayUnit(tileHeight, materialUnit)} onChange={(value) => { snapshot(); setTileHeight(inchesFromUnit(value, materialUnit)); }} suffix={materialUnit} min={materialMin} step={materialStep} />
            </div>
            <NumberField label="Grout joint" value={displayUnit(grout, materialUnit)} onChange={(value) => { snapshot(); setGrout(inchesFromUnit(value, materialUnit)); }} suffix={materialUnit} min={groutMin} step={groutStep} />
            <div className="pattern-picker"><strong>Pattern</strong><div className="pattern-options">
              {([["stack", "Straight stack"], ["half", "½ running bond"], ["third", "⅓ running bond"], ["diagonal", "Diagonal"], ["herringbone", "Herringbone"]] as [TilePattern, string][]).map(([value, label]) => <button key={value} className={pattern === value ? "active" : ""} aria-pressed={pattern === value}
                disabled={value === "herringbone" && Math.max(tileWidth, tileHeight) / Math.min(tileWidth, tileHeight) < 1.9}
                onClick={() => { snapshot(); setPattern(value); }}>
                <span className={`pattern-preview preview-${value}`} aria-hidden="true" /><span>{label}</span></button>)}
            </div></div>
            <div className="method-picker"><strong>Starting layout</strong>
              {([["center", "Centered", "Similar cuts at both sides"], ["edge", "Reference edge", "Start at the left and finished floor"], ["balanced", "Reduce narrow cuts", "Checks edges and marked features"]] as [LayoutMethod, string, string][]).map(([value, label, help]) =>
                <button key={value} className={method === value ? "active" : ""} onClick={() => chooseMethod(value)}><strong>{label}</strong><small>{help}</small></button>)}
              <p>Drag the tile field or tap a start-line dimension to fine-tune any option.</p>
            </div>
            <details className="advanced-settings"><summary>Advanced material settings</summary><div className="appearance-field">
              <span>Tile appearance</span>
              <div className="appearance-options">
                {([ ["transparent", "Clear"], ["porcelain", "Porcelain"], ["stone", "Stone"], ["marble", "Marble"], ["concrete", "Concrete"] ] as [TileAppearance, string][]).map(([value, label]) => (
                  <button key={value} className={tileAppearance === value ? `active appearance-${value}` : `appearance-${value}`} onClick={() => { snapshot(); setTileAppearance(value); }} aria-pressed={tileAppearance === value}><span aria-hidden="true" />{label}</button>
                ))}
              </div>
            </div></details>
            <div className="button-row"><button className="secondary" onClick={() => { snapshot(); setRotation((value) => value === 0 ? 90 : 0); }}><RotateCw size={16} /> Rotate 90°</button><button className="primary" onClick={autoBalance}><Sparkles size={16} /> Optimize cuts</button></div>
            <button className={`grab-floor-button ${tool === "floor" ? "active" : ""}`} onClick={() => { setShowTile(true); setTool("floor"); setSelectedId(null); }}><Move size={16} /> {tool === "floor" ? `Drag the ${surfaceNameLower} tile field` : "Grab and move tile field"}</button>
            <div className="nudge-control"><span>Precision adjustment · 1/4″</span><div><button onClick={() => { snapshot(); setOrigin((point) => ({ ...point, x: point.x - .25 })); }} aria-label="Move layout left">←</button><button onClick={() => { snapshot(); setOrigin((point) => ({ ...point, y: point.y - .25 })); }} aria-label="Move layout up">↑</button><button onClick={() => { snapshot(); setOrigin((point) => ({ ...point, y: point.y + .25 })); }} aria-label="Move layout down">↓</button><button onClick={() => { snapshot(); setOrigin((point) => ({ ...point, x: point.x + .25 })); }} aria-label="Move layout right">→</button></div></div>
            {surface === "wall" && <label className="snap-control"><input type="checkbox" checked={snapNiche} onChange={(event) => setSnapNiche(event.target.checked)} /> Snap niche edges to grout lines while dragging</label>}
          </section>

          <section className="panel results-panel">
            <div className="panel-heading inline-heading"><span><span className="eyebrow">Layout check</span><strong>{cutWarning ? "Review edge cuts" : "Cuts look balanced"}</strong></span><span className={`result-icon ${cutWarning ? "warning" : ""}`}>{cutWarning ? "!" : <Check size={17} />}</span></div>
            <div className="metrics"><div><span>{surfaceName} area</span><strong>{areaSqFt.toFixed(1)} ft²</strong></div><div><span>Tile + {wastePercent}%</span><strong>{tileCount} pcs</strong></div><div><span>Smallest planned cut</span><strong>{estimatedCuts ? "Review on drawing" : `${minimumCut.toFixed(1)} in`}</strong></div></div>
            <div className="start-reference-card"><span>Vertical chalk line</span><strong>{formatLength(startLeftReference)} from left · {formatLength(startRightReference)} from right</strong><span>Horizontal chalk line</span><strong>{formatLength(startTopReference)} from top · {formatLength(startBottomReference)} from bottom</strong></div>
            <p>{estimatedCuts ? "Diagonal and herringbone cut sizes need a manual check on the drawing before installation." : cutWarning ? `A ${surfaceNameLower} edge, feature, or opening may create a cut below half a tile. Use Optimize cuts, drag the tile field, or nudge it precisely.` : `The current tile position avoids small cuts across the ${surfaceNameLower} edges, features, and openings being checked.`}</p>
          </section>

          <section className="panel install-panel">
            <div className="panel-heading"><span className="eyebrow">Install setup</span><strong>{mortar.trowel}</strong></div>
            <div className="install-metrics"><div><span>Mortar estimate</span><strong>{mortarBags} × 50 lb bags</strong></div><div><span>Waste allowance</span><NumberField label="Waste allowance" value={wastePercent} onChange={(value) => { snapshot(); setWastePercent(value); }} suffix="%" min={0} step={1} /></div></div>
            <p>Planning estimate based on about {mortar.coverage} ft² per bag. Confirm the mortar manufacturer&apos;s coverage and the trowel required for the tile back, substrate flatness, and required mortar coverage; back-buttering can increase usage.</p>
          </section>
        </aside>
      </section>

      <nav className="mobile-tools" aria-label="Drawing tools">
        {([ ["select", MousePointer2, "Select"], ["pan", Hand, "Pan"], ["floor", Move, "Tile"], ["room", SquareDashedMousePointer, surface === "wall" ? "Wall area" : "Room"], ["wall", BrickWall, surface === "wall" ? "Feature" : "Wall"], ["opening", DoorOpen, "Opening"], ["tile", Grid3X3, "Settings"] ] as const).map(([value, Icon, label]) => (
          <button key={value} className={value !== "tile" && tool === value ? "active" : ""} onClick={() => { if (value === "tile") document.querySelector(".tile-panel")?.scrollIntoView({ behavior: "smooth" }); else setTool(value); }}><Icon size={19} /><span>{label}</span></button>
        ))}
      </nav>
    </main>
  );
}

