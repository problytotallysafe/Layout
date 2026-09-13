export const SUITE_SCHEMA = "buildr-suite.project.v1" as const;
export const SUITE_MAJOR = 1;
export type SuiteApp = "buildr" | "floorplan" | "layout";
export type PointMm = { x: number; y: number };
export type SuiteEntity = { id: string; kind: string; condition?: "existing" | "proposed"; geometry: Record<string, unknown>; label?: string; metadata?: Record<string, unknown> };
export type SuiteRoom = { id: string; name: string; displayUnit: "ft-in" | "in" | "mm" | "cm"; origin: PointMm; entities: SuiteEntity[]; extensions?: Record<string, unknown> };
export type SuiteProject = { id: string; organizationId: string | null; buildrProjectId?: string | null; importKey: string; name: string; customer?: Record<string, unknown>; rooms: SuiteRoom[]; createdAt: string; modifiedAt: string; extensions?: Record<string, unknown> };
export type SuiteEnvelope = { schema: typeof SUITE_SCHEMA | string; schemaVersion: string; source: { app: SuiteApp; appVersion: string; revision: number }; exportedAt: string; project: SuiteProject; extensions?: Record<string, unknown> };
export type ParseResult = { ok: true; value: SuiteEnvelope; readOnly: boolean; warning?: string } | { ok: false; error: string };
export const inchesToMm = (value: number) => Math.round(value * 25.4 * 1000) / 1000;
export const mmToInches = (value: number) => Math.round((value / 25.4) * 1000) / 1000;
export function stableId(prefix: string) { return `${prefix}_${crypto.randomUUID()}`; }
export function parseSuiteProject(input: unknown): ParseResult {
  try {
    if (!input || typeof input !== "object") return { ok: false, error: "The shared record is not an object." };
    const value = input as SuiteEnvelope;
    if (typeof value.schemaVersion !== "string" || !value.project || !Array.isArray(value.project.rooms)) return { ok: false, error: "Required project or version data is missing." };
    const major = Number(value.schemaVersion.split(".")[0]);
    if (!Number.isFinite(major) || major < 1) return { ok: false, error: "The shared record has an invalid schema version." };
    if (major > SUITE_MAJOR) return { ok: true, value, readOnly: true, warning: "This record was created by a newer app. It can be viewed and exported, but editing is disabled until this app is updated." };
    return { ok: true, value, readOnly: false };
  } catch { return { ok: false, error: "The shared record could not be read. Your existing work was not changed." }; }
}
export function createSuiteEnvelope(project: SuiteProject, app: SuiteApp, appVersion: string, revision = 1): SuiteEnvelope {
  return { schema: SUITE_SCHEMA, schemaVersion: "1.0.0", source: { app, appVersion, revision }, exportedAt: new Date().toISOString(), project };
}

