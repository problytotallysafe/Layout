import test from "node:test";
import assert from "node:assert/strict";
import {
  alignSegmentToHost,
  constrainPointToPolygon,
  endpointAtAngle,
  nearestSnapPoint,
  pointInPolygon,
  roundToIncrement,
  segmentAngleDegrees,
  segmentProjectionFraction,
  snapToCommonAngle,
} from "../src/lib/layout-geometry.ts";

test("pointer precision rounds to an eighth inch", () => {
  assert.equal(roundToIncrement(10.06), 10);
  assert.equal(roundToIncrement(10.07), 10.125);
});

test("common-angle snapping preserves segment length", () => {
  const snapped = snapToCommonAngle({ x: 0, y: 0 }, { x: 10, y: 8 });
  assert.ok(Math.abs(segmentAngleDegrees({ x: 0, y: 0 }, snapped) - 45) < 0.001);
  assert.ok(Math.abs(Math.hypot(snapped.x, snapped.y) - Math.hypot(10, 8)) < 0.001);
});

test("angle editing keeps exact length", () => {
  const end = endpointAtAngle({ x: 4, y: 5 }, 12, 135);
  assert.ok(Math.abs(Math.hypot(end.x - 4, end.y - 5) - 12) < 0.001);
  assert.ok(Math.abs(segmentAngleDegrees({ x: 4, y: 5 }, end) - 135) < 0.001);
});

test("endpoint snapping prefers nearby existing geometry", () => {
  const result = nearestSnapPoint(
    { x: 10.9, y: 10.8 },
    [{ x: 11, y: 11 }, { x: 40, y: 40 }],
    1,
  );
  assert.equal(result.snapped, true);
  assert.deepEqual(result.point, { x: 11, y: 11 });
});

test("polygon constraint keeps points inside irregular rooms", () => {
  const polygon = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
    { x: 5, y: 10 },
    { x: 0, y: 5 },
  ];
  assert.equal(pointInPolygon({ x: 5, y: 5 }, polygon), true);
  assert.equal(pointInPolygon({ x: 12, y: 5 }, polygon), false);
  const constrained = constrainPointToPolygon({ x: 12, y: 5 }, polygon);
  assert.equal(pointInPolygon(constrained, polygon), true);
});


test("hosted openings remain centered and aligned on their wall", () => {
  const hostStart = { x: 0, y: 0 };
  const hostEnd = { x: 100, y: 0 };
  const aligned = alignSegmentToHost(hostStart, hostEnd, 36, 0.4);
  assert.ok(Math.abs(aligned.start.y) < 0.001);
  assert.ok(Math.abs(aligned.end.y) < 0.001);
  assert.ok(Math.abs(Math.hypot(aligned.end.x - aligned.start.x, aligned.end.y - aligned.start.y) - 36) < 0.001);
  assert.ok(Math.abs(segmentProjectionFraction(
    { x: (aligned.start.x + aligned.end.x) / 2, y: 0 },
    hostStart,
    hostEnd,
  ) - aligned.t) < 0.001);
});

test("hosted openings are clamped so they cannot extend past a wall end", () => {
  const aligned = alignSegmentToHost({ x: 0, y: 0 }, { x: 40, y: 0 }, 36, 0.02);
  assert.ok(aligned.start.x >= -0.001);
  assert.ok(aligned.end.x <= 40.001);
});
