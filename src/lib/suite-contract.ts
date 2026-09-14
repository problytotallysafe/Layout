export const SUITE_SCHEMA = "buildr-suite.project.v1" as const;
export const SUITE_MAJOR = 1;
export type SuiteApp = "buildr" | "floorplan" | "layout";
export type PointMm = { x: number; y: number };
export type SuiteEntity = { id: string; kind: string; condition?: "existing" | "proposed"; geometry: Record<string, unknown>; label?: string; metadata?: Record<string, unknown> };
export type SuiteRoom = { id: string; name: string; displayUnit: "ft-in" | "in" | "mm" | "cm"; origin: PointMm; entities: SuiteEntity[]; extensions?: Record<string, unknown> };
export type SuiteProject = { id: string; organizationId: string | null; buildrProjectId?: string | null; importKey: string; name: string; customer?: Record<string, unknown>; rooms: SuiteRoom[]; createdAt: string; modifiedAt: string; extensions?: Record<string, unknown> };
export type SuiteEnvelope = { schema: typeof SUITE_SCHEMA | string; schemaVersion: string; source: { app: SuiteApp; appVersion: string; revision: number }; exportedAt: string; project: SuiteProject; extensions?: Record<string, unknown> };
export type ParseResult = { ok: true; value: SuiteEnvelope; readOnly: boolean; warning?: string } | { ok: false; error: string };

const APPS = new Set<SuiteApp>(["buildr", "floorplan", "layout"]);
const UNITS = new Set<SuiteRoom["displayUnit"]>(["ft-in", "in", "mm", "cm"]);
const CONDITIONS = new Set(["existing", "proposed"]);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const point = (value: unknown): value is PointMm => record(value) && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y));
const optionalRecord = (value: unknown) => value == null || record(value);
const optionalString = (value: unknown) => value == null || typeof value === "string";

export const inchesToMm = (value: number) => Math.round(value * 25.4 * 1000) / 1000;
export const mmToInches = (value: number) => Math.round((value / 25.4) * 1000) / 1000;
export function stableId(prefix: string) { return `${prefix}_${crypto.randomUUID()}`; }

function validateEnvelope(value: Record<string, unknown>): string | null {
  if (value.schema !== SUITE_SCHEMA) return "This file is not a supported Buildr suite record.";
  if (!nonEmpty(value.schemaVersion)) return "Required project or version data is missing.";
  const source = value.source;
  if (!record(source) || !APPS.has(source.app as SuiteApp) || !nonEmpty(source.appVersion) || !Number.isInteger(Number(source.revision)) || Number(source.revision) < 1) return "The shared record has invalid source information.";
  const project = value.project;
  if (!record(project) || !Array.isArray(project.rooms)) return "Required project or version data is missing.";
  if (!nonEmpty(project.id) || !nonEmpty(project.importKey) || !nonEmpty(project.name) || !optionalString(project.organizationId) || !optionalString(project.buildrProjectId) || !nonEmpty(project.createdAt) || !nonEmpty(project.modifiedAt) || !optionalRecord(project.customer) || !optionalRecord(project.extensions)) return "The shared project metadata is incomplete or invalid.";
  for (const rawRoom of project.rooms) {
    if (!record(rawRoom)) return "A room in the shared record is invalid.";
    if (!nonEmpty(rawRoom.id) || !nonEmpty(rawRoom.name) || !UNITS.has(rawRoom.displayUnit as SuiteRoom["displayUnit"]) || !point(rawRoom.origin) || !Array.isArray(rawRoom.entities) || !optionalRecord(rawRoom.extensions)) return "A room in the shared record is incomplete or invalid.";
    for (const rawEntity of rawRoom.entities) {
      if (!record(rawEntity)) return "An item in the shared drawing is invalid.";
      if (!nonEmpty(rawEntity.id) || !nonEmpty(rawEntity.kind) || !record(rawEntity.geometry) || !optionalString(rawEntity.label) || !optionalRecord(rawEntity.metadata) || (rawEntity.condition != null && !CONDITIONS.has(String(rawEntity.condition)))) return "An item in the shared drawing is incomplete or invalid.";
    }
  }
  if (!nonEmpty(value.exportedAt) || !optionalRecord(value.extensions)) return "The shared record metadata is incomplete or invalid.";
  return null;
}

export function parseSuiteProject(input: unknown): ParseResult {
  try {
    if (!record(input)) return { ok: false, error: "The shared record is not an object." };
    const error = validateEnvelope(input);
    if (error) return { ok: false, error };
    const major = Number(String(input.schemaVersion).split(".")[0]);
    if (!Number.isInteger(major) || major < 1) return { ok: false, error: "The shared record has an invalid schema version." };
    const value = input as unknown as SuiteEnvelope;
    if (major > SUITE_MAJOR) return { ok: true, value, readOnly: true, warning: "This record was created by a newer app. It can be viewed and exported, but editing is disabled until this app is updated." };
    return { ok: true, value, readOnly: false };
  } catch { return { ok: false, error: "The shared record could not be read. Your existing work was not changed." }; }
}

export function createSuiteEnvelope(project: SuiteProject, app: SuiteApp, appVersion: string, revision = 1): SuiteEnvelope {
  return { schema: SUITE_SCHEMA, schemaVersion: "1.0.0", source: { app, appVersion, revision }, exportedAt: new Date().toISOString(), project };
}
