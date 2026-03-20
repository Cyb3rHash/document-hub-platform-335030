/*
  Document Hub Platform - Supabase schema + RLS (Step 01.01)

  How to apply:
  - Supabase Dashboard -> SQL Editor -> paste/run
  - OR Supabase CLI migrations (if configured): supabase db push

  Notes:
  - This migration assumes Supabase-managed auth schema exists (auth.users).
  - It uses gen_random_uuid(). In Supabase Postgres this is available via pgcrypto.
  - Storage policies for storage.objects are included, but may require owner privileges on storage schema.
*/

begin;

-- Extensions
create extension if not exists pgcrypto;

-- ============================================================
-- 1) Helper functions (updated_at trigger + admin role check)
-- ============================================================

-- PUBLIC_INTERFACE
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
/**
 * set_updated_at()
 *
 * Contract:
 * - Inputs: Trigger context (OLD/NEW row)
 * - Output: NEW row with updated_at set to now()
 * - Errors: none expected
 * - Side effects: updates NEW.updated_at
 */
begin
  new.updated_at := now();
  return new;
end;
$$;

-- PUBLIC_INTERFACE
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
/**
 * is_admin()
 *
 * Contract:
 * - Inputs: none (uses auth.uid())
 * - Output: true if current authenticated user has role 'admin' in public.profiles
 * - Errors: none expected
 * - Side effects: none
 */
select exists (
  select 1
  from public.profiles p
  where p.id = auth.uid()
    and p.role = 'admin'
);
$$;

-- ============================================================
-- 2) profiles table (1:1 with auth.users)
-- ============================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_profiles_set_updated_at on public.profiles;
create trigger trg_profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

-- Policies: profiles
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
on public.profiles
for select
to authenticated
using (
  id = auth.uid() OR public.is_admin()
);

drop policy if exists "profiles_update_own_or_admin" on public.profiles;
create policy "profiles_update_own_or_admin"
on public.profiles
for update
to authenticated
using (
  id = auth.uid() OR public.is_admin()
)
with check (
  id = auth.uid() OR public.is_admin()
);

-- Allow users to insert their own profile row (common pattern after signup)
drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

-- ============================================================
-- 3) documents table (metadata + storage path + visibility)
-- ============================================================

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,

  title text not null,
  description text,

  visibility text not null default 'private' check (visibility in ('private','public','unlisted')),

  -- file metadata
  mime_type text not null,
  original_filename text not null,
  file_size_bytes bigint not null check (file_size_bytes >= 0),

  -- storage metadata (Supabase Storage)
  storage_bucket text not null default 'documents',
  storage_path text not null,
  preview_storage_path text,

  -- viewer / processing metadata
  page_count int,
  status text not null default 'uploaded' check (status in ('uploaded','processing','ready','failed')),

  -- access control switches
  disable_download boolean not null default false,
  watermark_text text,

  -- denormalized counters (optional but useful)
  view_count bigint not null default 0 check (view_count >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_documents_owner_id on public.documents(owner_id);
create index if not exists idx_documents_visibility on public.documents(visibility);
create index if not exists idx_documents_created_at on public.documents(created_at);

drop trigger if exists trg_documents_set_updated_at on public.documents;
create trigger trg_documents_set_updated_at
before update on public.documents
for each row execute function public.set_updated_at();

alter table public.documents enable row level security;

-- Policies: documents
-- Read if public/unlisted OR owner OR admin
drop policy if exists "documents_select_public_unlisted_owner_admin" on public.documents;
create policy "documents_select_public_unlisted_owner_admin"
on public.documents
for select
to anon, authenticated
using (
  visibility in ('public','unlisted')
  OR owner_id = auth.uid()
  OR public.is_admin()
);

-- Insert: only authenticated and must be owner_id = auth.uid() OR admin (admin can create for others if needed)
drop policy if exists "documents_insert_owner_or_admin" on public.documents;
create policy "documents_insert_owner_or_admin"
on public.documents
for insert
to authenticated
with check (
  owner_id = auth.uid()
  OR public.is_admin()
);

-- Update/Delete: owner OR admin
drop policy if exists "documents_update_owner_or_admin" on public.documents;
create policy "documents_update_owner_or_admin"
on public.documents
for update
to authenticated
using (
  owner_id = auth.uid()
  OR public.is_admin()
)
with check (
  owner_id = auth.uid()
  OR public.is_admin()
);

drop policy if exists "documents_delete_owner_or_admin" on public.documents;
create policy "documents_delete_owner_or_admin"
on public.documents
for delete
to authenticated
using (
  owner_id = auth.uid()
  OR public.is_admin()
);

-- ============================================================
-- 4) document_access table (explicit per-user grants)
--    Supports future "shared with user" private docs.
-- ============================================================

create table if not exists public.document_access (
  document_id uuid not null references public.documents(id) on delete cascade,
  grantee_id uuid not null references public.profiles(id) on delete cascade,
  access_level text not null default 'viewer' check (access_level in ('viewer','editor')),
  created_at timestamptz not null default now(),
  primary key (document_id, grantee_id)
);

create index if not exists idx_document_access_grantee on public.document_access(grantee_id);

alter table public.document_access enable row level security;

-- Policies: document_access
-- Owners/admin can read grants for their docs; grantee can read their own grant.
drop policy if exists "document_access_select_owner_grantee_admin" on public.document_access;
create policy "document_access_select_owner_grantee_admin"
on public.document_access
for select
to authenticated
using (
  grantee_id = auth.uid()
  OR public.is_admin()
  OR exists (
    select 1
    from public.documents d
    where d.id = document_access.document_id
      and (d.owner_id = auth.uid() OR public.is_admin())
  )
);

-- Owners/admin can insert grants
drop policy if exists "document_access_insert_owner_or_admin" on public.document_access;
create policy "document_access_insert_owner_or_admin"
on public.document_access
for insert
to authenticated
with check (
  public.is_admin()
  OR exists (
    select 1
    from public.documents d
    where d.id = document_access.document_id
      and d.owner_id = auth.uid()
  )
);

-- Owners/admin can update grants
drop policy if exists "document_access_update_owner_or_admin" on public.document_access;
create policy "document_access_update_owner_or_admin"
on public.document_access
for update
to authenticated
using (
  public.is_admin()
  OR exists (
    select 1
    from public.documents d
    where d.id = document_access.document_id
      and d.owner_id = auth.uid()
  )
)
with check (
  public.is_admin()
  OR exists (
    select 1
    from public.documents d
    where d.id = document_access.document_id
      and d.owner_id = auth.uid()
  )
);

-- Owners/admin can delete grants
drop policy if exists "document_access_delete_owner_or_admin" on public.document_access;
create policy "document_access_delete_owner_or_admin"
on public.document_access
for delete
to authenticated
using (
  public.is_admin()
  OR exists (
    select 1
    from public.documents d
    where d.id = document_access.document_id
      and d.owner_id = auth.uid()
  )
);

-- ============================================================
-- 5) document_versions table (version history + storage paths)
-- ============================================================

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version_number int not null check (version_number >= 1),
  mime_type text not null,
  original_filename text not null,
  file_size_bytes bigint not null check (file_size_bytes >= 0),
  storage_bucket text not null default 'documents',
  storage_path text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (document_id, version_number)
);

create index if not exists idx_document_versions_doc on public.document_versions(document_id);

alter table public.document_versions enable row level security;

-- Policies: document_versions
-- Read if document is readable (public/unlisted/owner/admin) OR if user has explicit access grant
drop policy if exists "document_versions_select_by_document_visibility_or_access" on public.document_versions;
create policy "document_versions_select_by_document_visibility_or_access"
on public.document_versions
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.documents d
    where d.id = document_versions.document_id
      and (
        d.visibility in ('public','unlisted')
        OR d.owner_id = auth.uid()
        OR public.is_admin()
        OR exists (
          select 1
          from public.document_access da
          where da.document_id = d.id
            and da.grantee_id = auth.uid()
        )
      )
  )
);

-- Insert/update/delete only by owner/admin (version creation typically by owner)
drop policy if exists "document_versions_insert_owner_or_admin" on public.document_versions;
create policy "document_versions_insert_owner_or_admin"
on public.document_versions
for insert
to authenticated
with check (
  public.is_admin()
  OR exists (
    select 1
    from public.documents d
    where d.id = document_versions.document_id
      and d.owner_id = auth.uid()
  )
);

drop policy if exists "document_versions_update_owner_or_admin" on public.document_versions;
create policy "document_versions_update_owner_or_admin"
on public.document_versions
for update
to authenticated
using (
  public.is_admin()
  OR exists (
    select 1
    from public.documents d
    where d.id = document_versions.document_id
      and d.owner_id = auth.uid()
  )
)
with check (
  public.is_admin()
  OR exists (
    select 1
    from public.documents d
    where d.id = document_versions.document_id
      and d.owner_id = auth.uid()
  )
);

drop policy if exists "document_versions_delete_owner_or_admin" on public.document_versions;
create policy "document_versions_delete_owner_or_admin"
on public.document_versions
for delete
to authenticated
using (
  public.is_admin()
  OR exists (
    select 1
    from public.documents d
    where d.id = document_versions.document_id
      and d.owner_id = auth.uid()
  )
);

-- ============================================================
-- 6) document_views table (events) + counter maintenance
-- ============================================================

create table if not exists public.document_views (
  id bigint generated by default as identity primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  viewer_id uuid references public.profiles(id) on delete set null,
  viewer_ip inet,
  user_agent text,
  page_number int,
  created_at timestamptz not null default now()
);

create index if not exists idx_document_views_doc on public.document_views(document_id);
create index if not exists idx_document_views_created_at on public.document_views(created_at);

alter table public.document_views enable row level security;

-- Insert policy:
-- - anon can insert for public/unlisted docs (so view counting works without login)
-- - authenticated can insert if they can view the doc: public/unlisted OR owner/admin OR explicit access
drop policy if exists "document_views_insert_if_doc_viewable" on public.document_views;
create policy "document_views_insert_if_doc_viewable"
on public.document_views
for insert
to anon, authenticated
with check (
  exists (
    select 1
    from public.documents d
    where d.id = document_views.document_id
      and (
        d.visibility in ('public','unlisted')
        OR d.owner_id = auth.uid()
        OR public.is_admin()
        OR exists (
          select 1
          from public.document_access da
          where da.document_id = d.id
            and da.grantee_id = auth.uid()
        )
      )
  )
);

-- Select policy: only owner/admin can view raw events (privacy)
drop policy if exists "document_views_select_owner_or_admin" on public.document_views;
create policy "document_views_select_owner_or_admin"
on public.document_views
for select
to authenticated
using (
  public.is_admin()
  OR exists (
    select 1
    from public.documents d
    where d.id = document_views.document_id
      and d.owner_id = auth.uid()
  )
);

-- PUBLIC_INTERFACE
create or replace function public.increment_document_view_count()
returns trigger
language plpgsql
as $$
/**
 * increment_document_view_count()
 *
 * Contract:
 * - Inputs: Trigger context (NEW.document_id)
 * - Output: NEW row (unchanged)
 * - Errors: none expected
 * - Side effects: increments public.documents.view_count for NEW.document_id
 *
 * Invariants:
 * - documents.view_count remains non-negative
 */
begin
  update public.documents
    set view_count = view_count + 1
  where id = new.document_id;

  return new;
end;
$$;

drop trigger if exists trg_document_views_increment_counter on public.document_views;
create trigger trg_document_views_increment_counter
after insert on public.document_views
for each row execute function public.increment_document_view_count();

-- ============================================================
-- 7) Storage policies (optional, may require elevated privileges)
-- ============================================================

/*
  These policies allow:
  - Authenticated users to CRUD objects under prefix "<uid>/..." in bucket 'documents'
  - Optional public read for objects whose name matches a document that is public/unlisted

  If you get an error like: "must be owner of table objects", run these as the project owner
  in Supabase SQL editor or via migrations with sufficient privileges.
*/

-- Ensure RLS is enabled for storage.objects (usually already enabled in Supabase projects)
-- alter table storage.objects enable row level security;

-- Owner CRUD under their folder prefix
drop policy if exists "storage_documents_owner_crud" on storage.objects;
create policy "storage_documents_owner_crud"
on storage.objects
for all
to authenticated
using (
  bucket_id = 'documents'
  and split_part(name, '/', 1) = auth.uid()::text
)
with check (
  bucket_id = 'documents'
  and split_part(name, '/', 1) = auth.uid()::text
);

-- Public/unlisted read access (optional; remove if you prefer signed URLs only)
drop policy if exists "storage_documents_public_read" on storage.objects;
create policy "storage_documents_public_read"
on storage.objects
for select
to anon, authenticated
using (
  bucket_id = 'documents'
  and exists (
    select 1
    from public.documents d
    where d.storage_path = storage.objects.name
      and d.visibility in ('public','unlisted')
  )
);

commit;
