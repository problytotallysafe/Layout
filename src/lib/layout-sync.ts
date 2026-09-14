import type { SavedLayout } from "@/components/layout-planner";

export type LayoutConflict = { id: string; local: SavedLayout; cloud: SavedLayout };

export function mergeLayouts(localLayouts: SavedLayout[], cloudLayouts: SavedLayout[]) {
  const merged = new Map<string, SavedLayout>();
  const conflicts: LayoutConflict[] = [];
  for (const cloud of cloudLayouts) merged.set(cloud.id, cloud);
  for (const local of localLayouts) {
    const cloud = merged.get(local.id);
    if (!cloud) { merged.set(local.id, local); continue; }
    if (local.revision === cloud.revision && JSON.stringify(local) !== JSON.stringify(cloud)) {
      conflicts.push({ id: local.id, local, cloud });
      merged.set(local.id, local);
      continue;
    }
    if (local.revision > cloud.revision) merged.set(local.id, local);
  }
  return { layouts: [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt), conflicts };
}
