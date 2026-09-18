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

export function distanceToPolygonBoundary(
  point: GeometryPoint,
  polygon: GeometryPoint[],
) {
  if (polygon.length < 2) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const projected = closestPointOnSegment(
      point,
      polygon[index],
      polygon[(index + 1) % polygon.length],
    );
    best = Math.min(best, distanceBetween(point, projected));
  }
  return best;
}

export function pointInPolygonInset(
  point: GeometryPoint,
  polygon: GeometryPoint[],
  inset = 0,
) {
  if (!pointInPolygon(point, polygon)) return false;
  return inset <= GEOMETRY_EPSILON ||
    distanceToPolygonBoundary(point, polygon) >= inset - GEOMETRY_EPSILON;
}

export function constrainPointToPolygonInset(
  point: GeometryPoint,
  polygon: GeometryPoint[],
  inset = 0,
): GeometryPoint {
  if (polygon.length < 3) return point;
  let candidate = constrainPointToPolygon(point, polygon);
  if (inset <= GEOMETRY_EPSILON) return candidate;

  for (let iteration = 0; iteration < 18; iteration += 1) {
    let nearestPoint = polygon[0];
    let nearestStart = polygon[0];
    let nearestEnd = polygon[1] || polygon[0];
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const projected = closestPointOnSegment(candidate, start, end);
      const current = distanceBetween(candidate, projected);
      if (current < nearestDistance) {
        nearestDistance = current;
        nearestPoint = projected;
        nearestStart = start;
        nearestEnd = end;
      }
    }

    if (
      pointInPolygon(candidate, polygon) &&
      nearestDistance >= inset - GEOMETRY_EPSILON
    ) return candidate;

    let dx = candidate.x - nearestPoint.x;
    let dy = candidate.y - nearestPoint.y;
    let magnitude = Math.hypot(dx, dy);

    if (magnitude < GEOMETRY_EPSILON) {
      const edgeX = nearestEnd.x - nearestStart.x;
      const edgeY = nearestEnd.y - nearestStart.y;
      const edgeLength = Math.hypot(edgeX, edgeY) || 1;
      const first = { x: -edgeY / edgeLength, y: edgeX / edgeLength };
      const second = { x: -first.x, y: -first.y };
      const probe = Math.max(0.01, Math.min(0.25, inset * 0.2));
      const firstProbe = {
        x: nearestPoint.x + first.x * probe,
        y: nearestPoint.y + first.y * probe,
      };
      const inward = pointInPolygon(firstProbe, polygon) ? first : second;
      dx = inward.x;
      dy = inward.y;
      magnitude = 1;
    }

    const scale = (inset + 0.001) / magnitude;
    const pushed = {
      x: nearestPoint.x + dx * scale,
      y: nearestPoint.y + dy * scale,
    };
    if (pointInPolygon(pushed, polygon)) {
      candidate = pushed;
      continue;
    }

    const opposite = {
      x: nearestPoint.x - dx * scale,
      y: nearestPoint.y - dy * scale,
    };
    candidate = pointInPolygon(opposite, polygon)
      ? opposite
      : constrainPointToPolygon(pushed, polygon);
  }

  return candidate;
}

function segmentSampleCount(
  start: GeometryPoint,
  end: GeometryPoint,
  inset: number,
) {
  const step = Math.max(0.75, inset / 2);
  return Math.max(
    2,
    Math.min(160, Math.ceil(distanceBetween(start, end) / step)),
  );
}

export function segmentFitsPolygonInset(
  start: GeometryPoint,
  end: GeometryPoint,
  polygon: GeometryPoint[],
  inset = 0,
) {
  const samples = segmentSampleCount(start, end, inset);
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const point = {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    };
    if (!pointInPolygonInset(point, polygon, inset)) return false;
  }
  return true;
}

export function constrainSegmentToPolygonInset(
  start: GeometryPoint,
  end: GeometryPoint,
  polygon: GeometryPoint[],
  inset = 0,
) {
  const safeStart = constrainPointToPolygonInset(start, polygon, inset);
  if (segmentFitsPolygonInset(safeStart, end, polygon, inset)) {
    return { start: safeStart, end };
  }

  const samples = segmentSampleCount(safeStart, end, inset);
  let previousT = 0;
  for (let index = 1; index <= samples; index += 1) {
    const t = index / samples;
    const current = {
      x: safeStart.x + (end.x - safeStart.x) * t,
      y: safeStart.y + (end.y - safeStart.y) * t,
    };
    if (pointInPolygonInset(current, polygon, inset)) {
      previousT = t;
      continue;
    }

    let low = previousT;
    let high = t;
    for (let pass = 0; pass < 16; pass += 1) {
      const mid = (low + high) / 2;
      const probe = {
        x: safeStart.x + (end.x - safeStart.x) * mid,
        y: safeStart.y + (end.y - safeStart.y) * mid,
      };
      if (pointInPolygonInset(probe, polygon, inset)) low = mid;
      else high = mid;
    }
    return {
      start: safeStart,
      end: {
        x: safeStart.x + (end.x - safeStart.x) * low,
        y: safeStart.y + (end.y - safeStart.y) * low,
      },
    };
  }

  return {
    start: safeStart,
    end: constrainPointToPolygonInset(end, polygon, inset),
  };
}

export function constrainSegmentTranslationToPolygonInset(
  start: GeometryPoint,
  end: GeometryPoint,
  dx: number,
  dy: number,
  polygon: GeometryPoint[],
  inset = 0,
) {
  const translated = (factor: number) => ({
    start: { x: start.x + dx * factor, y: start.y + dy * factor },
    end: { x: end.x + dx * factor, y: end.y + dy * factor },
  });
  const desired = translated(1);
  if (segmentFitsPolygonInset(desired.start, desired.end, polygon, inset)) {
    return { dx, dy };
  }
  if (!segmentFitsPolygonInset(start, end, polygon, inset)) {
    return { dx: 0, dy: 0 };
  }

  let low = 0;
  let high = 1;
  for (let pass = 0; pass < 12; pass += 1) {
    const mid = (low + high) / 2;
    const candidate = translated(mid);
    if (segmentFitsPolygonInset(candidate.start, candidate.end, polygon, inset)) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return { dx: dx * low, dy: dy * low };
}


export function segmentProjectionFraction(
  point: GeometryPoint,
  start: GeometryPoint,
  end: GeometryPoint,
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < GEOMETRY_EPSILON) return 0;
  return Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
}

export function alignSegmentToHost(
  hostStart: GeometryPoint,
  hostEnd: GeometryPoint,
  segmentLength: number,
  requestedT: number,
) {
  const hostLength = distanceBetween(hostStart, hostEnd);
  if (hostLength < GEOMETRY_EPSILON) {
    return {
      start: { ...hostStart },
      end: { ...hostEnd },
      t: 0,
    };
  }
  const usableLength = Math.min(Math.max(segmentLength, 0), hostLength);
  const halfT = usableLength / hostLength / 2;
  const t = Math.max(halfT, Math.min(1 - halfT, requestedT));
  const center = {
    x: hostStart.x + (hostEnd.x - hostStart.x) * t,
    y: hostStart.y + (hostEnd.y - hostStart.y) * t,
  };
  const ux = (hostEnd.x - hostStart.x) / hostLength;
  const uy = (hostEnd.y - hostStart.y) / hostLength;
  return {
    start: {
      x: center.x - ux * usableLength / 2,
      y: center.y - uy * usableLength / 2,
    },
    end: {
      x: center.x + ux * usableLength / 2,
      y: center.y + uy * usableLength / 2,
    },
    t,
  };
}
