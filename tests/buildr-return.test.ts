import test from "node:test";
import assert from "node:assert/strict";
import { resolveBuildrReturnTarget } from "../src/lib/buildr-return.ts";
import { createSuiteEnvelope } from "../src/lib/suite-contract.ts";
import type { SavedLayout } from "../src/components/layout-planner.tsx";

function baseLayout(): SavedLayout {
  return {
    id: "layout-return-test",
    revision: 1,
    updatedAt: Date.now(),
    projectName: "Return routing test",
    roomName: "Bathroom",
    room: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 96 }, { x: 0, y: 96 }],
    items: [],
    tileWidth: 12,
    tileHeight: 24,
    grout: 0.125,
    materialUnit: "in",
    materialType: "tile",
    tileAppearance: "transparent",
    pattern: "straight",
    wastePercent: 10,
    wallThickness: 4.5,
    origin: { x: 0, y: 0 },
    rotation: 0,
    showTile: true,
    snapEnabled: true,
    notes: "",
  };
}

test("returns directly to a linked Buildr project without cloud lookup", async () => {
  const layout = baseLayout();
  layout.suiteContext = {
    organizationId: "org_test",
    buildrProjectId: "project_12345678",
    importKey: "layout:return-test",
  };
  assert.deepEqual(await resolveBuildrReturnTarget(layout), {
    kind: "project",
    id: "project_12345678",
    path: "/projects/project_12345678",
  });
});

test("preserves originating Buildr estimate context from an imported suite record", async () => {
  const layout = baseLayout();
  const envelope = createSuiteEnvelope({
    id: "suite_project_return",
    organizationId: "org_test",
    buildrProjectId: null,
    importKey: "estimate:estimate_12345678",
    name: "Estimate planning",
    rooms: [],
    createdAt: new Date(0).toISOString(),
    modifiedAt: new Date(0).toISOString(),
    extensions: {
      buildrContext: {
        type: "estimate",
        id: "estimate_12345678",
        path: "/estimates/estimate_12345678",
      },
    },
  }, "buildr", "1.6.0");

  layout.suiteContext = {
    organizationId: "org_test",
    buildrProjectId: null,
    importKey: "estimate:estimate_12345678",
    sourceEnvelope: envelope,
  };

  assert.deepEqual(await resolveBuildrReturnTarget(layout), {
    kind: "context",
    type: "estimate",
    id: "estimate_12345678",
    path: "/estimates/estimate_12345678",
  });
});
