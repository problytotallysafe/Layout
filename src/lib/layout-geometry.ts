export type GeometryPoint = { x: number; y: number };

export const GEOMETRY_EPSILON = 1e-6;

export function distanceBetween(a: GeometryPoint, b: GeometryPoint) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function roundToIncrement(value: number, increment = 0.125) {
  if (!Number.isFinite(value) || !Number.isFinite(increment) || increment <= 0)
    return value;
  return Math.round(value / increment) * increment;
}

export function normalizeAngleDegrees(value: number) {
  const normalized = ((value % 360) + 360) % 360;
  return Math.abs(normalized - 360) < GEOMETRY_EPSILON ? 0 : normalized;
}

export function segmentAngleDegrees(start: GeometryPoint, end: GeometryPoint) {
  return normalizeAngleDegrees(
    (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI,
  );
}

export function endpointAtAngle(
  start: GeometryPoint,
  length: number,
  degrees: number,
): GeometryPoint {
  const radians = (normalizeAngleDegrees(degrees) * Math.PI) / 180;
  return {
    x: start.x + Math.cos(radians) * length,
    y: start.y + Math.sin(radians) * length,
  };
}

export function snapToCommonAngle(
  start: GeometryPoint,
  end: GeometryPoint,
  stepDegrees = 45,
): GeometryPoint {
  const length = distanceBetween(start, end);
  if (length < GEOMETRY_EPSILON || stepDegrees <= 0) return end;
  const angle = segmentAngleDegrees(start, end);
  const snappedAngle = Math.round(angle / stepDegrees) * stepDegrees;
  return endpointAtAngle(start, length, snappedAngle);
}

export function nearestSnapPoint(
  point: GeometryPoint,
  candidates: GeometryPoint[],
  tolerance: number,
): { point: GeometryPoint; snapped: boolean } {
  if (!candidates.length || tolerance <= 0) return { point, snapped: false };
  let closest: GeometryPoint | null = null;
  let best = tolerance;
  for (const candidate of candidates) {
    const current = distanceBetween(point, candidate);
    if (current <= best) {
      best = current;
      closest = candidate;
    }
  }
  return closest
    ? { point: { ...closest }, snapped: true }
    : { point, snapped: false };
}

export function pointInPolygon(point: GeometryPoint, polygon: GeometryPoint[]) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];

    const cross =
      (point.y - a.y) * (b.x - a.x) - (point.x - a.x) * (b.y - a.y);
    const onSegment =
      Math.abs(cross) < GEOMETRY_EPSILON &&
      point.x >= Math.min(a.x, b.x) - GEOMETRY_EPSILON &&
      point.x <= Math.max(a.x, b.x) + GEOMETRY_EPSILON &&
      point.y >= Math.min(a.y, b.y) - GEOMETRY_EPSILON &&
      point.y <= Math.max(a.y, b.y) + GEOMETRY_EPSILON;
    if (onSegment) return true;

    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x <
        ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || GEOMETRY_EPSILON) +
          a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function closestPointOnSegment(
  point: GeometryPoint,
  start: GeometryPoint,
  end: GeometryPoint,
): GeometryPoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < GEOMETRY_EPSILON) return { ...start };
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return { x: start.x + t * dx, y: start.y + t * dy };
}

export function constrainPointToPolygon(
  point: GeometryPoint,
  polygon: GeometryPoint[],
): GeometryPoint {
  if (polygon.length < 3 || pointInPolygon(point, polygon)) return point;
  let closest = polygon[0] ? { ...polygon[0] } : point;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const candidate = closestPointOnSegment(
      point,
      polygon[index],
      polygon[(index + 1) % polygon.length],
    );
    const current = distanceBetween(point, candidate);
    if (current < best) {
      best = current;
      closest = candidate;
    }
  }
  return closest;
}
