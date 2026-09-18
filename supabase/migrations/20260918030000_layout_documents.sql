create table if not exists public.layout_documents (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  name text not null,
  schema_version text not null check (schema_version = 'layout.plan.v1'),
  revision integer not null default 1 check (revision > 0),
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists layout_documents_owner_updated_idx
  on public.layout_documents (owner_id, updated_at desc)
  where deleted_at is null;

alter table public.layout_documents enable row level security;

create policy "Layout owners can read their documents"
  on public.layout_documents
  for select
  to authenticated
  using ((select auth.uid()) = owner_id and deleted_at is null);

create policy "Layout owners can create documents"
  on public.layout_documents
  for insert
  to authenticated
  with check (
    (select auth.uid()) = owner_id
    and (
      organization_id is null
      or organization_id in (select private.user_organization_ids())
    )
  );

create policy "Layout owners can update their documents"
  on public.layout_documents
  for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check (
    (select auth.uid()) = owner_id
    and (
      organization_id is null
      or organization_id in (select private.user_organization_ids())
    )
  );

create policy "Layout owners can delete their documents"
  on public.layout_documents
  for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

grant select, insert, update, delete on public.layout_documents to authenticated;
