import {
  createSuiteEnvelope,
  inchesToMm,
  mmToInches,
  parseSuiteProject,
  type SuiteEnvelope,
  type SuiteEntity,
  type SuiteProject,
  type SuiteRoom,
} from "./suite-contract.ts";
import type { DrawItem, Point, SavedLayout } from "../components/layout-planner";

type SuiteContext = {
  organizationId: string | null;
  buildrProjectId: string | null;
  importKey: string;
  sourceEnvelope?: SuiteEnvelope;
  sourceRoomId?: string;
  readOnly?: boolean;
};

type LayoutSettings = {
  tileWidthMm?: number;
  tileHeightMm?: number;
  groutMm?: number;
  appearance?: SavedLayout["tileAppearance"];
  wastePercent?: number;
  originMm?: { x: number; y: number };
  rotation?: number;
  showTile?: boolean;
};

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finitePoint = (value: unknown): value is { x: number; y: number } =>
  record(value) &&
  Number.isFinite(Number(value.x)) &&
  Number.isFinite(Number(value.y));
const mmPoint = (point: Point) => ({
  x: inchesToMm(point.x),
  y: inchesToMm(point.y),
});
const inchPoint = (point: { x: number; y: number }) => ({
  x: mmToInches(point.x),
  y: mmToInches(point.y),
});
const contextFor = (layout: SavedLayout) =>
  layout.suiteContext as SuiteContext | undefined;

function chosenRoom(envelope: SuiteEnvelope): SuiteRoom | undefined {
  return (
    envelope.project.rooms.find((room) => {
      const boundary = room.entities.find(
        (entity) => entity.kind === "room.boundary",
      );
      return (
        boundary?.condition === "proposed" ||
        room.extensions?.condition === "proposed"
      );
    }) || envelope.project.rooms[0]
  );
}

function segmentFromObject(entity: SuiteEntity): DrawItem | null {
  if (entity.kind !== "object.opening" || !record(entity.geometry)) return null;
  const x = Number(entity.geometry.x);
  const y = Number(entity.geometry.y);
  const width = Number(entity.geometry.width);
  const rotation = Number(entity.geometry.rotation || 0);
  if (![x, y, width, rotation].every(Number.isFinite) || width <= 0) return null;
  const center = inchPoint({ x, y });
  const half = mmToInches(width) / 2;
  const radians = (rotation * Math.PI) / 180;
  const dx = Math.cos(radians) * half;
  const dy = Math.sin(radians) * half;
  return {
    id: entity.id,
    type: "opening",
    start: { x: center.x - dx, y: center.y - dy },
    end: { x: center.x + dx, y: center.y + dy },
    thickness: mmToInches(Number(entity.geometry.depth || 114.3)),
  };
}

function itemFromEntity(entity: SuiteEntity): DrawItem | null {
  if (entity.kind === "object.opening") return segmentFromObject(entity);
  if (
    entity.kind !== "wall.interior" &&
    entity.kind !== "opening" &&
    entity.kind !== "wall.opening"
  )
    return null;
  if (!record(entity.geometry)) return null;
  const start = entity.geometry.start;
  const end = entity.geometry.end;
  if (!finitePoint(start) || !finitePoint(end)) return null;
  return {
    id: entity.id,
    type:
      entity.kind === "opening" || entity.kind === "wall.opening"
        ? "opening"
        : "wall",
    start: inchPoint({ x: Number(start.x), y: Number(start.y) }),
    end: inchPoint({ x: Number(end.x), y: Number(end.y) }),
    thickness: mmToInches(Number(entity.geometry.thickness || 114.3)),
  };
}

function entityForItem(item: DrawItem, prior?: SuiteEntity): SuiteEntity {
  if (prior?.kind === "object.opening") {
    const center = {
      x: (item.start.x + item.end.x) / 2,
      y: (item.start.y + item.end.y) / 2,
    };
    return {
      ...prior,
      condition: prior.condition || "proposed",
      geometry: {
        ...prior.geometry,
        x: inchesToMm(center.x),
        y: inchesToMm(center.y),
        width: inchesToMm(
          Math.hypot(item.end.x - item.start.x, item.end.y - item.start.y),
        ),
        depth: inchesToMm(item.thickness),
        rotation:
          (Math.atan2(
            item.end.y - item.start.y,
            item.end.x - item.start.x,
          ) *
            180) /
          Math.PI,
      },
    };
  }
  return {
    ...(prior || {}),
    id: item.id,
    kind:
      prior?.kind || (item.type === "wall" ? "wall.interior" : "opening"),
    condition: prior?.condition || "proposed",
    geometry: {
      ...(prior?.geometry || {}),
      start: mmPoint(item.start),
      end: mmPoint(item.end),
      thickness: inchesToMm(item.thickness),
    },
  } as SuiteEntity;
}

export function layoutToSuite(
  layout: SavedLayout,
  organizationId: string | null = contextFor(layout)?.organizationId || null,
  buildrProjectId: string | null = contextFor(layout)?.buildrProjectId || null,
): SuiteEnvelope {
  const context = contextFor(layout);
  const source = context?.sourceEnvelope;
  if (context?.readOnly && source) return source;

  const sourceRoom = source?.project.rooms.find(
    (room) => room.id === context?.sourceRoomId,
  );
  const sourceBoundary = sourceRoom?.entities.find(
    (entity) => entity.kind === "room.boundary",
  );
  const currentIds = new Set(layout.items.map((item) => item.id));
  const preserved =
    sourceRoom?.entities.filter(
      (entity) => entity.kind !== "room.boundary" && !currentIds.has(entity.id),
    ) || [];

  const room: SuiteRoom = {
    id: sourceRoom?.id || context?.sourceRoomId || `room_${layout.id}`,
    name: sourceRoom?.name || layout.projectName,
    displayUnit: sourceRoom?.displayUnit || "ft-in",
    origin: sourceRoom?.origin || { x: 0, y: 0 },
    entities: [
      ...preserved,
      {
        ...(sourceBoundary || {}),
        id: sourceBoundary?.id || `boundary_${layout.id}`,
        kind: "room.boundary",
        condition: sourceBoundary?.condition || "proposed",
        geometry: {
          ...(sourceBoundary?.geometry || {}),
          vertices: layout.room.map(mmPoint),
        },
      } as SuiteEntity,
      ...layout.items.map((item) =>
        entityForItem(
          item,
          sourceRoom?.entities.find((entity) => entity.id === item.id),
        ),
      ),
    ],
    extensions: {
      ...(sourceRoom?.extensions || {}),
      condition: sourceRoom?.extensions?.condition || "proposed",
      layout: {
        tileWidthMm: inchesToMm(layout.tileWidth),
        tileHeightMm: inchesToMm(layout.tileHeight),
        groutMm: inchesToMm(layout.grout),
        appearance: layout.tileAppearance,
        wastePercent: layout.wastePercent,
        originMm: mmPoint(layout.origin),
        rotation: layout.rotation,
        showTile: layout.showTile,
      },
    },
  };

  const project: SuiteProject = {
    id: source?.project.id || layout.id,
    organizationId: organizationId ?? source?.project.organizationId ?? null,
    buildrProjectId:
      buildrProjectId ?? source?.project.buildrProjectId ?? null,
    importKey:
      source?.project.importKey || context?.importKey || `layout:${layout.id}`,
    name: layout.projectName,
    customer: source?.project.customer,
    createdAt:
      source?.project.createdAt || new Date(layout.updatedAt).toISOString(),
    modifiedAt: new Date(layout.updatedAt).toISOString(),
    rooms: [room],
    extensions: source?.project.extensions,
  };
  const envelope = createSuiteEnvelope(
    project,
    "layout",
    "1.0.0",
    layout.revision,
  );
  envelope.extensions = source?.extensions;
  return envelope;
}

export function suiteToLayout(input: unknown): {
  layout?: SavedLayout;
  error?: string;
  readOnly?: boolean;
  warning?: string;
} {
  const parsed = parseSuiteProject(input);
  if (!parsed.ok) return { error: parsed.error };
  const room = chosenRoom(parsed.value);
  if (!room) return { error: "This shared project does not contain a room." };
  const boundary = room.entities.find(
    (entity) => entity.kind === "room.boundary",
  );
  const rawVertices = record(boundary?.geometry)
    ? boundary.geometry.vertices
    : undefined;
  const vertices = Array.isArray(rawVertices)
    ? rawVertices.filter(finitePoint).map((point) => ({
        x: Number(point.x),
        y: Number(point.y),
      }))
    : [];
  if (vertices.length < 3)
    return {
      error:
        "No compatible room boundary was found. The original shared record was not changed.",
    };

  const imported = room.entities.flatMap((entity) => {
    const item = itemFromEntity(entity);
    return item ? [item] : [];
  });
  const settings = (record(room.extensions?.layout)
    ? room.extensions?.layout
    : {}) as LayoutSettings;
  const now = Date.now();
  return {
    readOnly: parsed.readOnly,
    warning: parsed.warning,
    layout: {
      id: parsed.value.project.id,
      revision: Math.max(1, Number(parsed.value.source.revision) || 1),
      updatedAt: now,
      projectName: parsed.value.project.name,
      room: vertices.map(inchPoint),
      items: imported,
      tileWidth: mmToInches(Number(settings.tileWidthMm || 304.8)),
      tileHeight: mmToInches(Number(settings.tileHeightMm || 609.6)),
      grout: mmToInches(Number(settings.groutMm || 3.175)),
      materialUnit: "in",
      tileAppearance: settings.appearance || "transparent",
      wastePercent: Number(settings.wastePercent ?? 10),
      wallThickness: 4.5,
      origin:
        settings.originMm && finitePoint(settings.originMm)
          ? inchPoint(settings.originMm)
          : { x: 0, y: 0 },
      rotation: settings.rotation === 90 ? 90 : 0,
      showTile: settings.showTile !== false,
      suiteContext: {
        organizationId: parsed.value.project.organizationId,
        buildrProjectId: parsed.value.project.buildrProjectId || null,
        importKey: parsed.value.project.importKey,
        sourceEnvelope: parsed.value,
        sourceRoomId: room.id,
        readOnly: parsed.readOnly,
      } as SuiteContext,
    },
  };
}

export function decodeSuiteHash(hash: string) {
  try {
    const encoded = new URLSearchParams(hash.replace(/^#/, "")).get("suite");
    if (!encoded) return null;
    const binary = atob(decodeURIComponent(encoded));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function suiteLink(base: string, envelope: SuiteEnvelope) {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return `${base.replace(/\/$/, "")}/#suite=${encodeURIComponent(btoa(binary))}`;
}

export function downloadSuite(envelope: SuiteEnvelope, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download =
    name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".buildr.json";
  link.click();
  URL.revokeObjectURL(url);
}
