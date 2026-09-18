export type CutObstacle = { coordinate: number; side: "before" | "after" };

const EPSILON = 0.001;

export function edgeCuts(
  span: number,
  tile: number,
  grout: number,
  rawOffset: number,
) {
  const pitch = tile + grout;
  if (span <= 0 || tile <= 0 || pitch <= 0) return { left: 0, right: 0 };
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

export function cutAtBoundary(
  coordinate: number,
  tile: number,
  grout: number,
  rawOffset: number,
  side: CutObstacle["side"],
) {
  const pitch = tile + grout;
  if (tile <= 0 || pitch <= 0) return 0;
  const phase = ((coordinate - rawOffset) % pitch + pitch) % pitch;
  if (phase < EPSILON || phase >= tile - EPSILON) return tile;
  return side === "before" ? phase : tile - phase;
}

export function assessAxis(
  span: number,
  tile: number,
  grout: number,
  rawOffset: number,
  obstacles: CutObstacle[],
  phaseOffsets: number[] = [0],
) {
  const phases = phaseOffsets.length ? phaseOffsets : [0];
  const assessments = phases.map((phase) => {
    const offset = rawOffset + phase;
    const edges = edgeCuts(span, tile, grout, offset);
    const obstacleCuts = obstacles.map((obstacle) =>
      cutAtBoundary(obstacle.coordinate, tile, grout, offset, obstacle.side),
    );
    return {
      left: edges.left,
      right: edges.right,
      minimum: Math.min(edges.left, edges.right, ...obstacleCuts),
    };
  });
  return {
    left: Math.min(...assessments.map((item) => item.left)),
    right: Math.min(...assessments.map((item) => item.right)),
    minimum: Math.min(...assessments.map((item) => item.minimum)),
  };
}

export function balancedOffset(
  span: number,
  tile: number,
  grout: number,
  obstacles: CutObstacle[],
  phaseOffsets: number[] = [0],
  precision = 0.125,
) {
  const pitch = tile + grout;
  if (span <= 0 || tile <= 0 || pitch <= 0 || precision <= 0) {
    return { offset: 0, score: 0, left: 0, right: 0, minimum: 0 };
  }
  let best = { offset: 0, score: -Infinity, left: 0, right: 0, minimum: 0 };
  for (let offset = -pitch; offset <= EPSILON; offset += precision) {
    const assessment = assessAxis(span, tile, grout, offset, obstacles, phaseOffsets);
    const score = assessment.minimum * 100 - Math.abs(assessment.left - assessment.right);
    if (score > best.score) best = { offset, score, ...assessment };
  }
  return best;
}


export type PolygonPoint = { x: number; y: number };

type Rect = { minX: number; minY: number; maxX: number; maxY: number };

const polygonArea = (points: PolygonPoint[]) => Math.abs(points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length];
  return sum + point.x * next.y - next.x * point.y;
}, 0)) / 2;

function clipAgainst(
  subject: PolygonPoint[],
  inside: (point: PolygonPoint) => boolean,
  intersection: (a: PolygonPoint, b: PolygonPoint) => PolygonPoint,
) {
  if (!subject.length) return [];
  const output: PolygonPoint[] = [];
  let previous = subject[subject.length - 1];
  let previousInside = inside(previous);
  for (const current of subject) {
    const currentInside = inside(current);
    if (currentInside) {
      if (!previousInside) output.push(intersection(previous, current));
      output.push(current);
    } else if (previousInside) {
      output.push(intersection(previous, current));
    }
    previous = current;
    previousInside = currentInside;
  }
  return output;
}

export function clipPolygonToRect(subject: PolygonPoint[], rect: Rect) {
  let output = subject;
  output = clipAgainst(
    output,
    (point) => point.x >= rect.minX - EPSILON,
    (a, b) => {
      const t = (rect.minX - a.x) / ((b.x - a.x) || EPSILON);
      return { x: rect.minX, y: a.y + (b.y - a.y) * t };
    },
  );
  output = clipAgainst(
    output,
    (point) => point.x <= rect.maxX + EPSILON,
    (a, b) => {
      const t = (rect.maxX - a.x) / ((b.x - a.x) || EPSILON);
      return { x: rect.maxX, y: a.y + (b.y - a.y) * t };
    },
  );
  output = clipAgainst(
    output,
    (point) => point.y >= rect.minY - EPSILON,
    (a, b) => {
      const t = (rect.minY - a.y) / ((b.y - a.y) || EPSILON);
      return { x: a.x + (b.x - a.x) * t, y: rect.minY };
    },
  );
  output = clipAgainst(
    output,
    (point) => point.y <= rect.maxY + EPSILON,
    (a, b) => {
      const t = (rect.maxY - a.y) / ((b.y - a.y) || EPSILON);
      return { x: a.x + (b.x - a.x) * t, y: rect.maxY };
    },
  );
  return output;
}

function pointToSegmentDistance(point: PolygonPoint, start: PolygonPoint, end: PolygonPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const projected = { x: start.x + t * dx, y: start.y + t * dy };
  return Math.hypot(point.x - projected.x, point.y - projected.y);
}

function pointToLineDistance(point: PolygonPoint, start: PolygonPoint, end: PolygonPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length;
}

function boundsForPolygon(points: PolygonPoint[]) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

export type PolygonLayoutAssessment = {
  minimumBoundaryCut: number;
  minimumAreaRatio: number;
  cutPieceCount: number;
  pieceCount: number;
};

export function assessPolygonLayout(
  room: PolygonPoint[],
  tileWidth: number,
  tileHeight: number,
  grout: number,
  origin: PolygonPoint,
  patternRows = 1,
): PolygonLayoutAssessment {
  if (room.length < 3 || tileWidth <= 0 || tileHeight <= 0) {
    return { minimumBoundaryCut: 0, minimumAreaRatio: 0, cutPieceCount: 0, pieceCount: 0 };
  }
  const roomBounds = boundsForPolygon(room);
  const pitchX = tileWidth + grout;
  const pitchY = tileHeight + grout;
  const rows = Math.max(1, Math.round(patternRows));
  const firstRow = Math.floor((roomBounds.minY - origin.y) / pitchY) - 1;
  const lastRow = Math.ceil((roomBounds.maxY - origin.y) / pitchY) + 1;
  let minimumBoundaryCut = Number.POSITIVE_INFINITY;
  let minimumAreaRatio = 1;
  let cutPieceCount = 0;
  let pieceCount = 0;
  const fullArea = tileWidth * tileHeight;

  for (let row = firstRow; row <= lastRow; row += 1) {
    const normalizedRow = ((row % rows) + rows) % rows;
    const rowShift = normalizedRow * pitchX / rows;
    const rowY = origin.y + row * pitchY;
    const firstColumn = Math.floor((roomBounds.minX - origin.x - rowShift) / pitchX) - 1;
    const lastColumn = Math.ceil((roomBounds.maxX - origin.x - rowShift) / pitchX) + 1;

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const cellX = origin.x + rowShift + column * pitchX;
      const clipped = clipPolygonToRect(room, {
        minX: cellX,
        maxX: cellX + tileWidth,
        minY: rowY,
        maxY: rowY + tileHeight,
      });
      if (clipped.length < 3) continue;
      const area = polygonArea(clipped);
      if (area < EPSILON) continue;
      pieceCount += 1;
      const areaRatio = Math.min(1, area / fullArea);
      if (areaRatio >= 0.999) continue;

      cutPieceCount += 1;
      minimumAreaRatio = Math.min(minimumAreaRatio, areaRatio);
      let pieceBoundaryCut = Number.POSITIVE_INFINITY;

      for (let edgeIndex = 0; edgeIndex < room.length; edgeIndex += 1) {
        const edgeStart = room[edgeIndex];
        const edgeEnd = room[(edgeIndex + 1) % room.length];
        const touchesEdge = clipped.some(
          (point) => pointToSegmentDistance(point, edgeStart, edgeEnd) <= 0.02,
        );
        if (!touchesEdge) continue;
        const depth = Math.max(
          ...clipped.map((point) => pointToLineDistance(point, edgeStart, edgeEnd)),
        );
        if (depth > EPSILON) pieceBoundaryCut = Math.min(pieceBoundaryCut, depth);
      }

      if (Number.isFinite(pieceBoundaryCut)) {
        minimumBoundaryCut = Math.min(minimumBoundaryCut, pieceBoundaryCut);
      } else {
        const clippedBounds = boundsForPolygon(clipped);
        minimumBoundaryCut = Math.min(
          minimumBoundaryCut,
          clippedBounds.maxX - clippedBounds.minX,
          clippedBounds.maxY - clippedBounds.minY,
        );
      }
    }
  }

  return {
    minimumBoundaryCut: Number.isFinite(minimumBoundaryCut)
      ? minimumBoundaryCut
      : Math.min(tileWidth, tileHeight),
    minimumAreaRatio: cutPieceCount ? minimumAreaRatio : 1,
    cutPieceCount,
    pieceCount,
  };
}

export function optimizePolygonLayout(
  room: PolygonPoint[],
  tileWidth: number,
  tileHeight: number,
  grout: number,
  boundsOrigin: PolygonPoint,
  xObstacles: CutObstacle[] = [],
  yObstacles: CutObstacle[] = [],
  patternRows = 1,
) {
  const pitchX = tileWidth + grout;
  const pitchY = tileHeight + grout;
  const phasesX = Array.from(
    { length: Math.max(1, Math.round(patternRows)) },
    (_, index) => index * pitchX / Math.max(1, Math.round(patternRows)),
  );
  const roomBounds = boundsForPolygon(room);
  const spanX = roomBounds.maxX - roomBounds.minX;
  const spanY = roomBounds.maxY - roomBounds.minY;

  const evaluate = (offsetX: number, offsetY: number) => {
    const polygon = assessPolygonLayout(
      room,
      tileWidth,
      tileHeight,
      grout,
      { x: boundsOrigin.x + offsetX, y: boundsOrigin.y + offsetY },
      patternRows,
    );
    const x = assessAxis(spanX, tileWidth, grout, offsetX, xObstacles, phasesX);
    const y = assessAxis(spanY, tileHeight, grout, offsetY, yObstacles);
    const minimum = Math.min(polygon.minimumBoundaryCut, x.minimum, y.minimum);
    return {
      offset: { x: offsetX, y: offsetY },
      minimum,
      polygon,
      score:
        minimum * 1000 +
        polygon.minimumAreaRatio * 10 -
        Math.abs(x.left - x.right) * 0.1 -
        Math.abs(y.left - y.right) * 0.1,
    };
  };

  const coarseStep = Math.max(0.5, Math.min(1, Math.min(pitchX, pitchY) / 4));
  let best = evaluate(0, 0);
  for (let x = -pitchX; x <= EPSILON; x += coarseStep) {
    for (let y = -pitchY; y <= EPSILON; y += coarseStep) {
      const current = evaluate(x, y);
      if (current.score > best.score) best = current;
    }
  }

  const coarseBest = best;
  for (
    let x = Math.max(-pitchX, coarseBest.offset.x - coarseStep);
    x <= Math.min(0, coarseBest.offset.x + coarseStep) + EPSILON;
    x += 0.125
  ) {
    for (
      let y = Math.max(-pitchY, coarseBest.offset.y - coarseStep);
      y <= Math.min(0, coarseBest.offset.y + coarseStep) + EPSILON;
      y += 0.125
    ) {
      const current = evaluate(x, y);
      if (current.score > best.score) best = current;
    }
  }
  return best;
}
