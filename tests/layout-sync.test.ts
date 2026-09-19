import test from "node:test";
import assert from "node:assert/strict";
import { mergeLayouts } from "../src/lib/layout-sync.ts";
import type { SavedLayout } from "../src/components/layout-planner.tsx";

function layout(name: string, revision = 1): SavedLayout {
  return { id: "layout_1", revision, updatedAt: Date.parse("2026-09-13T00:00:00Z"), projectName: name,
    room: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 96 }], items: [], tileWidth: 12, tileHeight: 24,
    grout: .125, materialUnit: "in", materialType: "tile", tileAppearance: "transparent", pattern: "straight", wastePercent: 10, wallThickness: 4.5,
    origin: { x: 0, y: 0 }, rotation: 0, showTile: true, snapEnabled: true };
}

test("equal-revision divergent layouts require a user choice", () => {
  const result = mergeLayouts([layout("Device")], [layout("Cloud")]);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.layouts[0].projectName, "Device");
});

test("a higher revision wins during reconnection", () => {
  const result = mergeLayouts([layout("Device", 2)], [layout("Cloud", 1)]);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.layouts[0].projectName, "Device");
});
