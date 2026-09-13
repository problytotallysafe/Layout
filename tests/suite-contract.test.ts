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
