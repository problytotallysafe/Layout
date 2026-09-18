import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createSuiteEnvelope,
  inchesToMm,
  mmToInches,
  parseSuiteProject,
  type SuiteProject,
} from "../src/lib/suite-contract.ts";
import { layoutToSuite, suiteToLayout } from "../src/lib/suite-exchange.ts";

const project: SuiteProject = {
  id: "project_1",
  organizationId: null,
  importKey: "layout:project_1",
  name: "Standalone bathroom",
  rooms: [],
  createdAt: "2026-09-13T00:00:00Z",
  modifiedAt: "2026-09-13T00:00:00Z",
};

const fixture = new URL("./fixtures/suite-project-v1.json", import.meta.url);

test("measurement conversion is reversible to shared precision", () => {
  assert.equal(mmToInches(inchesToMm(101.125)), 101.125);
});

test("valid suite data is accepted", () => {
  assert.equal(
    parseSuiteProject(createSuiteEnvelope(project, "layout", "1.0.0")).ok,
    true,
  );
});

test("canonical fixture converts through Layout and preserves unsupported Floorplan entities", async () => {
  const input = JSON.parse(await readFile(fixture, "utf8"));
  const imported = suiteToLayout(input);
  assert.equal(imported.error, undefined);
  assert.ok(imported.layout);
  if (!imported.layout) return;

  assert.equal(imported.layout.suiteContext?.buildrProjectId, "suite-fixture-buildr-project-1");
  assert.equal(imported.layout.items.some((item) => item.id === "wall-1"), true);
  assert.equal(imported.layout.items.some((item) => item.id === "opening-1"), true);

  const exported = layoutToSuite(
    imported.layout,
    "suite-fixture-org-1",
    "suite-fixture-buildr-project-1",
  );
  const parsed = parseSuiteProject(exported);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.project.buildrProjectId, "suite-fixture-buildr-project-1");
  assert.equal(
    parsed.value.project.rooms[0].entities.some((entity) => entity.id === "toilet-1" && entity.kind === "object.toilet"),
    true,
  );
});

test("editing one suite room preserves unrelated rooms", async () => {
  const input = JSON.parse(await readFile(fixture, "utf8"));
  input.project.rooms.push({
    id: "suite-fixture-room-2",
    name: "Hall",
    displayUnit: "ft-in",
    origin: { x: 0, y: 0 },
    entities: [
      {
        id: "hall-boundary",
        kind: "room.boundary",
        geometry: {
          vertices: [
            { x: 0, y: 0 },
            { x: 1219.2, y: 0 },
            { x: 1219.2, y: 2438.4 },
            { x: 0, y: 2438.4 },
          ],
        },
      },
      {
        id: "hall-unknown",
        kind: "object.custom",
        geometry: { x: 300, y: 400 },
        metadata: { preserveMe: true },
      },
    ],
    extensions: { keep: "unchanged" },
  });

  const imported = suiteToLayout(input);
  assert.ok(imported.layout);
  if (!imported.layout) return;
  const exported = layoutToSuite(imported.layout);
  assert.equal(exported.project.rooms.length, 2);
  const hall = exported.project.rooms.find((room) => room.id === "suite-fixture-room-2");
  assert.ok(hall);
  assert.equal(hall?.extensions?.keep, "unchanged");
  assert.equal(hall?.entities.some((entity) => entity.id === "hall-unknown"), true);
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
