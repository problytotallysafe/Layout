import test from "node:test";
import assert from "node:assert/strict";
import {
  constrainPointToPolygon,
  endpointAtAngle,
  nearestSnapPoint,
  pointInPolygon,
  roundToIncrement,
  segmentAngleDegrees,
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
