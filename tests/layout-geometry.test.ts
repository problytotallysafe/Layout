import test from "node:test";
import assert from "node:assert/strict";
import {
  alignSegmentToHost,
  constrainPointToPolygon,
  constrainPointToPolygonInset,
  constrainSegmentToPolygonInset,
  constrainSegmentTranslationToPolygonInset,
  endpointAtAngle,
  horizontalPolygonSpanAtY,
  nearestGridIntersectionInsidePolygon,
  nearestSnapPoint,
  pointInPolygon,
  pointInPolygonInset,
  roundToIncrement,
  segmentFitsPolygonInset,
  segmentAngleDegrees,
  segmentProjectionFraction,
  snapToCommonAngle,
  verticalPolygonSpanAtX,
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


test("keeps wall clearance inside angled room edges", () => {
  const room = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 10, y: 20 },
  ];
  const constrained = constrainPointToPolygonInset({ x: 10, y: 19.5 }, room, 2);
  assert.equal(pointInPolygonInset(constrained, room, 2), true);
  assert.ok(constrained.y < 19.5);
});

test("rejects wall segments that cross outside a concave room", () => {
  const room = [
    { x: 0, y: 0 },
    { x: 12, y: 0 },
    { x: 12, y: 4 },
    { x: 4, y: 4 },
    { x: 4, y: 12 },
    { x: 0, y: 12 },
  ];
  const start = { x: 2, y: 10 };
  const requestedEnd = { x: 10, y: 2 };
  assert.equal(segmentFitsPolygonInset(start, requestedEnd, room, 0.5), false);
  const constrained = constrainSegmentToPolygonInset(start, requestedEnd, room, 0.5);
  assert.equal(segmentFitsPolygonInset(constrained.start, constrained.end, room, 0.5), true);
  assert.ok(constrained.end.x <= 3.501);
});

test("limits whole-wall translation before it crosses the room boundary", () => {
  const room = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ];
  const delta = constrainSegmentTranslationToPolygonInset(
    { x: 3, y: 3 },
    { x: 17, y: 3 },
    0,
    -5,
    room,
    2,
  );
  assert.ok(delta.dy <= 0);
  assert.ok(delta.dy >= -1.01);
  assert.equal(
    segmentFitsPolygonInset(
      { x: 3 + delta.dx, y: 3 + delta.dy },
      { x: 17 + delta.dx, y: 3 + delta.dy },
      room,
      2,
    ),
    true,
  );
});


test("scanline references measure the actual angled perimeter", () => {
  const room = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 10, y: 20 },
  ];
  assert.deepEqual(horizontalPolygonSpanAtY(room, 10, 10), { min: 5, max: 15 });
  assert.deepEqual(verticalPolygonSpanAtX(room, 5, 5), { min: 0, max: 10 });
});

test("scanline references choose the local span inside concave rooms", () => {
  const room = [
    { x: 0, y: 0 },
    { x: 12, y: 0 },
    { x: 12, y: 4 },
    { x: 4, y: 4 },
    { x: 4, y: 12 },
    { x: 0, y: 12 },
  ];
  assert.deepEqual(horizontalPolygonSpanAtY(room, 8, 2), { min: 0, max: 4 });
  assert.deepEqual(horizontalPolygonSpanAtY(room, 2, 10), { min: 0, max: 12 });
  assert.deepEqual(verticalPolygonSpanAtX(room, 8, 2), { min: 0, max: 4 });
});

test("reference cross stays on an equivalent grid intersection inside a concave room", () => {
  const room = [
    { x: 0, y: 0 },
    { x: 12, y: 0 },
    { x: 12, y: 4 },
    { x: 4, y: 4 },
    { x: 4, y: 12 },
    { x: 0, y: 12 },
  ];
  const point = nearestGridIntersectionInsidePolygon(
    room,
    { x: 0, y: 0 },
    2,
    2,
    { x: 8, y: 8 },
  );
  assert.equal(pointInPolygon(point, room), true);
  assert.ok(Math.abs(point.x / 2 - Math.round(point.x / 2)) < 0.001);
  assert.ok(Math.abs(point.y / 2 - Math.round(point.y / 2)) < 0.001);
});
