import test from "node:test";
import assert from "node:assert/strict";
import {
  assessAxis,
  assessPolygonLayout,
  balancedOffset,
  cutAtBoundary,
  edgeCuts,
  optimizePolygonLayout,
} from "../src/lib/layout-engine.ts";

test("edge cut math remains stable with grout joints", () => {
  const cuts = edgeCuts(120, 24, 0.125, 0);
  assert.ok(cuts.left > 23.8);
  assert.ok(cuts.right > 23);
});

test("optimizer improves a deliberately poor starting position", () => {
  const poor = assessAxis(103, 24, 0.125, 0, []);
  const best = balancedOffset(103, 24, 0.125, []);
  assert.ok(best.minimum >= poor.minimum);
  assert.ok(best.left > 0);
  assert.ok(best.right > 0);
});

test("obstacles participate in the minimum-cut decision", () => {
  const withoutObstacle = assessAxis(120, 24, 0.125, -6, []);
  const withObstacle = assessAxis(
    120,
    24,
    0.125,
    -6,
    [{ coordinate: 24.2, side: "before" }],
  );
  assert.ok(withObstacle.minimum <= withoutObstacle.minimum);
});

test("running-bond phases use the worst row rather than only the first row", () => {
  const straight = assessAxis(101, 24, 0.125, -4, [], [0]);
  const halfOffset = assessAxis(101, 24, 0.125, -4, [], [0, (24 + 0.125) / 2]);
  assert.ok(halfOffset.minimum <= Math.max(straight.minimum, 24));
});

test("boundary cuts are reported on the requested side", () => {
  const before = cutAtBoundary(18, 24, 0.125, 0, "before");
  const after = cutAtBoundary(18, 24, 0.125, 0, "after");
  assert.ok(Math.abs(before - 18) < 0.001);
  assert.ok(Math.abs(after - 6) < 0.001);
});


test("polygon cut analysis measures angled boundary depth", () => {
  const room = [
    { x: 0, y: 0 },
    { x: 96, y: 0 },
    { x: 120, y: 48 },
    { x: 96, y: 96 },
    { x: 0, y: 96 },
  ];
  const assessment = assessPolygonLayout(
    room,
    24,
    24,
    0.125,
    { x: -3, y: -5 },
    1,
  );
  assert.ok(assessment.cutPieceCount > 0);
  assert.ok(assessment.minimumBoundaryCut > 0);
  assert.ok(assessment.minimumBoundaryCut <= 24);
  assert.ok(assessment.minimumAreaRatio > 0 && assessment.minimumAreaRatio < 1);
});

test("polygon optimizer improves a poor angled-room layout", () => {
  const room = [
    { x: 0, y: 0 },
    { x: 98, y: 0 },
    { x: 120, y: 44 },
    { x: 98, y: 96 },
    { x: 0, y: 96 },
  ];
  const poor = assessPolygonLayout(
    room,
    24,
    24,
    0.125,
    { x: 0, y: 0 },
    1,
  );
  const optimized = optimizePolygonLayout(
    room,
    24,
    24,
    0.125,
    { x: 0, y: 0 },
    [],
    [],
    1,
  );
  assert.ok(optimized.polygon.minimumBoundaryCut >= poor.minimumBoundaryCut - 0.001);
  assert.ok(optimized.minimum > 0);
});

test("polygon optimizer accounts for running-bond row phases", () => {
  const room = [
    { x: 0, y: 0 },
    { x: 101, y: 0 },
    { x: 116, y: 72 },
    { x: 0, y: 72 },
  ];
  const straight = optimizePolygonLayout(room, 24, 12, 0.125, { x: 0, y: 0 }, [], [], 1);
  const halfOffset = optimizePolygonLayout(room, 24, 12, 0.125, { x: 0, y: 0 }, [], [], 2);
  assert.ok(straight.minimum > 0);
  assert.ok(halfOffset.minimum > 0);
  assert.equal(halfOffset.polygon.pieceCount > 0, true);
});
