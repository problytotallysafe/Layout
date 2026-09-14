import test from "node:test";
import assert from "node:assert/strict";
import {
  createSuiteEnvelope,
  inchesToMm,
  mmToInches,
  parseSuiteProject,
  type SuiteProject,
} from "../src/lib/suite-contract.ts";

const project: SuiteProject = {
  id: "project_1",
  organizationId: null,
  importKey: "layout:project_1",
  name: "Standalone bathroom",
  rooms: [],
  createdAt: "2026-09-13T00:00:00Z",
  modifiedAt: "2026-09-13T00:00:00Z",
};

test("measurement conversion is reversible to shared precision", () => {
  assert.equal(mmToInches(inchesToMm(101.125)), 101.125);
});

test("valid suite data is accepted", () => {
  assert.equal(
    parseSuiteProject(createSuiteEnvelope(project, "layout", "1.0.0")).ok,
    true,
  );
});

test("newer shared records open safely read-only", () => {
  const envelope = createSuiteEnvelope(project, "floorplan", "2.0.0");
  envelope.schemaVersion = "2.0.0";
  const result = parseSuiteProject(envelope);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.readOnly, true);
});

test("invalid shared data is rejected without throwing", () => {
  assert.equal(parseSuiteProject(null).ok, false);
  assert.equal(parseSuiteProject({ schemaVersion: "bad" }).ok, false);
});

test("malformed drawing items are rejected before Layout conversion", () => {
  const envelope = createSuiteEnvelope(
    {
      ...project,
      rooms: [
        {
          id: "room_1",
          name: "Bath",
          displayUnit: "ft-in",
          origin: { x: 0, y: 0 },
          entities: [
            { id: "wall_1", kind: "wall.interior", geometry: {} },
          ],
        },
      ],
    },
    "floorplan",
    "1.0.0",
  );
  (envelope.project.rooms[0].entities[0] as unknown as { geometry: unknown }).geometry = null;
  assert.equal(parseSuiteProject(envelope).ok, false);
});
