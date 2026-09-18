import {
  alignSegmentToHost,
  closestPointOnSegment,
  distanceBetween,
  segmentProjectionFraction,
  type GeometryPoint,
} from "./layout-geometry.ts";

export type HostableItem = {
  id: string;
  type: "wall" | "opening";
  start: GeometryPoint;
  end: GeometryPoint;
  thickness: number;
  hostId?: string;
  hostEdgeIndex?: number;
  hostT?: number;
};

type HostCandidate =
  | { kind: "wall"; id: string; start: GeometryPoint; end: GeometryPoint; thickness: number }
  | { kind: "room-edge"; edgeIndex: number; start: GeometryPoint; end: GeometryPoint };

const midpoint = (item: Pick<HostableItem, "start" | "end">) => ({
  x: (item.start.x + item.end.x) / 2,
  y: (item.start.y + item.end.y) / 2,
});

export function attachOpeningToNearestHost<T extends HostableItem>(
  opening: T,
  items: HostableItem[],
  room: GeometryPoint[],
  tolerance = 8,
): T {
  if (opening.type !== "opening") return opening;
  const center = midpoint(opening);
  const candidates: HostCandidate[] = [
    ...items
      .filter((item) => item.type === "wall")
      .map((wall) => ({
        kind: "wall" as const,
        id: wall.id,
        start: wall.start,
        end: wall.end,
        thickness: wall.thickness,
      })),
    ...room.map((start, edgeIndex) => ({
      kind: "room-edge" as const,
      edgeIndex,
      start,
      end: room[(edgeIndex + 1) % room.length],
    })),
  ];

  let best: { candidate: HostCandidate; distance: number; t: number } | null = null;
  for (const candidate of candidates) {
    const projected = closestPointOnSegment(center, candidate.start, candidate.end);
    const currentDistance = distanceBetween(center, projected);
    if (!best || currentDistance < best.distance) {
      best = {
        candidate,
        distance: currentDistance,
        t: segmentProjectionFraction(center, candidate.start, candidate.end),
      };
    }
  }
  if (!best || best.distance > tolerance) {
    return {
      ...opening,
      hostId: undefined,
      hostEdgeIndex: undefined,
      hostT: undefined,
    };
  }

  const length = distanceBetween(opening.start, opening.end);
  const aligned = alignSegmentToHost(
    best.candidate.start,
    best.candidate.end,
    length,
    best.t,
  );
  return {
    ...opening,
    start: aligned.start,
    end: aligned.end,
    thickness:
      best.candidate.kind === "wall"
        ? best.candidate.thickness
        : opening.thickness,
    hostId: best.candidate.kind === "wall" ? best.candidate.id : undefined,
    hostEdgeIndex:
      best.candidate.kind === "room-edge"
        ? best.candidate.edgeIndex
        : undefined,
    hostT: aligned.t,
  };
}

export function reflowWallHostedOpenings<T extends HostableItem>(
  items: T[],
  wallId: string,
  updatedWall: T,
): T[] {
  return items.map((item) => {
    if (item.id === wallId) return updatedWall;
    if (item.type !== "opening" || item.hostId !== wallId) return item;
    const aligned = alignSegmentToHost(
      updatedWall.start,
      updatedWall.end,
      distanceBetween(item.start, item.end),
      item.hostT ?? 0.5,
    );
    return {
      ...item,
      start: aligned.start,
      end: aligned.end,
      thickness: updatedWall.thickness,
      hostT: aligned.t,
    };
  });
}

export function reflowRoomHostedOpenings<T extends HostableItem>(
  items: T[],
  room: GeometryPoint[],
): T[] {
  return items.map((item) => {
    if (
      item.type !== "opening" ||
      item.hostEdgeIndex == null ||
      !room[item.hostEdgeIndex]
    ) return item;
    const start = room[item.hostEdgeIndex];
    const end = room[(item.hostEdgeIndex + 1) % room.length];
    const aligned = alignSegmentToHost(
      start,
      end,
      distanceBetween(item.start, item.end),
      item.hostT ?? 0.5,
    );
    return {
      ...item,
      start: aligned.start,
      end: aligned.end,
      hostT: aligned.t,
    };
  });
}

export function moveHostedOpening<T extends HostableItem>(
  opening: T,
  items: HostableItem[],
  room: GeometryPoint[],
  requestedCenter: GeometryPoint,
): T {
  if (opening.type !== "opening") return opening;
  let hostStart: GeometryPoint | null = null;
  let hostEnd: GeometryPoint | null = null;
  let thickness = opening.thickness;

  if (opening.hostId) {
    const wall = items.find((item) => item.id === opening.hostId && item.type === "wall");
    if (wall) {
      hostStart = wall.start;
      hostEnd = wall.end;
      thickness = wall.thickness;
    }
  } else if (opening.hostEdgeIndex != null && room[opening.hostEdgeIndex]) {
    hostStart = room[opening.hostEdgeIndex];
    hostEnd = room[(opening.hostEdgeIndex + 1) % room.length];
  }

  if (!hostStart || !hostEnd) return opening;
  const t = segmentProjectionFraction(requestedCenter, hostStart, hostEnd);
  const aligned = alignSegmentToHost(
    hostStart,
    hostEnd,
    distanceBetween(opening.start, opening.end),
    t,
  );
  return {
    ...opening,
    start: aligned.start,
    end: aligned.end,
    thickness,
    hostT: aligned.t,
  };
}
