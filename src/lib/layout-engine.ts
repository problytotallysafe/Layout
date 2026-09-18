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
