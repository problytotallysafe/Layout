import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = new URL(
  "../supabase/migrations/20260918030000_layout_documents.sql",
  import.meta.url,
);
const layoutStore = new URL("../src/lib/layout-store.ts", import.meta.url);

test("Layout standalone cloud migration keeps owner and organization safeguards", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /create table if not exists public\.layout_documents/i);
  assert.match(sql, /alter table public\.layout_documents enable row level security/i);
  assert.match(sql, /auth\.uid\(\)[\s\S]*owner_id/i);
  assert.match(sql, /private\.user_organization_ids\(\)/i);
  assert.match(sql, /deleted_at is null/i);
  assert.match(sql, /primary key\s*\(owner_id,\s*id\)/i);
  assert.match(sql, /grant select, insert, update, delete on public\.layout_documents to authenticated/i);
});

test("Layout cloud upserts use the same owner-scoped conflict key", async () => {
  const source = await readFile(layoutStore, "utf8");
  assert.match(source, /onConflict:\s*"owner_id,id"/);
  assert.match(source, /eq\("owner_id",\s*user\.id\)/);
});
