-- =====================================================================
--  NORSU E-Library - database setup for Supabase
--
--  HOW TO RUN: Supabase dashboard > SQL Editor > "New query" > paste this
--  WHOLE file > Run.  (If it asks about "destructive operations" because of
--  "drop policy", that is normal - confirm.)  It is safe to run again later.
--
--  WHAT THIS DOES: this is the "server" of your system.  The website talks
--  straight to Supabase, so the RULES about who may see or change what live
--  here, inside the database (Row Level Security).  Students can only ever
--  see their own profile, cannot approve themselves, and can only open an
--  e-book if the database says they are approved - and every open is logged.
-- =====================================================================


-- =====================================================================
-- 1. TABLES
-- =====================================================================

-- One row per person (linked to Supabases own login table, auth.users).
create table if not exists public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  name           text not null,
  email          text not null default '',
  id_number      text not null default '',
  role_requested text not null default 'Student' check (role_requested in ('Student', 'Faculty', 'Staff')),
  program        text not null default '',
  user_role      text not null default 'patron'  check (user_role in ('patron', 'staff')),
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  avatar_path    text,
  created_at     timestamptz not null default now(),
  reviewed_at    timestamptz
);

create table if not exists public.books (
  id         bigint generated always as identity primary key,
  title      text not null check (length(title) between 1 and 300),
  author     text not null check (length(author) between 1 and 200),
  category   text not null default 'Other' check (length(category) <= 100),
  file_name  text,                       -- original PDF name; empty = no PDF uploaded yet
  created_at timestamptz not null default now()
);

-- Every time someone opens an e-book, one row is added here (the monitoring data).
create table if not exists public.access_log (
  id          bigint generated always as identity primary key,
  user_id     uuid   not null references public.profiles (id) on delete cascade,
  book_id     bigint not null references public.books (id) on delete restrict,  -- books with history cannot be deleted
  accessed_at timestamptz not null default now()
);
create index if not exists access_log_user_book_time on public.access_log (user_id, book_id, accessed_at desc);
create index if not exists access_log_time           on public.access_log (accessed_at desc);

-- Private settings. Nobody on the website can read this table (no policies, no grants).
create table if not exists public.app_config (
  key   text primary key,
  value text not null default ''
);
-- Staff sign-up code. EMPTY = nobody can sign up as staff (safe default).
insert into public.app_config (key, value) values ('staff_signup_code', '') on conflict (key) do nothing;


-- =====================================================================
-- 2. HELPER FUNCTIONS used by the rules
--    (security definer = they look at the profiles table with the owners
--     rights, so a student cannot trick them; search_path is locked down)
-- =====================================================================

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.user_role = 'staff'
  );
$$;

-- true for staff, and for people whose registration was approved
create or replace function public.is_approved()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and (p.user_role = 'staff' or p.status = 'approved')
  );
$$;

-- May the caller download this PDF file? Only if approved AND they opened it through
-- open_book() in the last 2 minutes (that is what writes the access log row).
create or replace function public.can_read_book_object(p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null
     and public.is_approved()
     and (
       public.is_staff()
       or exists (
         select 1 from public.access_log a
         where a.user_id = (select auth.uid())
           and a.book_id::text = split_part(p_name, '.', 1)
           and a.accessed_at > now() - interval '2 minutes'
       )
     );
$$;


-- =====================================================================
-- 3. NEW ACCOUNT -> PROFILE (runs automatically when someone signs up)
-- =====================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  m        jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_code   text;
  v_staff  boolean := false;
  v_role   text;
  v_name   text;
begin
  -- staff only if the right secret code was typed AND a code is currently set
  select c.value into v_code from public.app_config c where c.key = 'staff_signup_code';
  if v_code is not null and v_code <> '' and coalesce(m ->> 'staff_code', '') = v_code then
    v_staff := true;
  end if;

  v_role := case when (m ->> 'role_requested') in ('Student', 'Faculty', 'Staff') then m ->> 'role_requested' else 'Student' end;
  v_name := left(coalesce(nullif(btrim(m ->> 'name'), ''), split_part(coalesce(new.email, ''), '@', 1)), 120);

  insert into public.profiles (id, name, email, id_number, role_requested, program, user_role, status, reviewed_at)
  values (
    new.id,
    v_name,
    coalesce(new.email, ''),
    left(coalesce(m ->> 'id_number', ''), 60),
    v_role,
    left(coalesce(m ->> 'program', ''), 120),
    case when v_staff then 'staff'    else 'patron'  end,
    case when v_staff then 'approved' else 'pending' end,
    case when v_staff then now()      else null      end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- (if anyone already signed up before this script ran, give them a profile too)
insert into public.profiles (id, name, email, id_number)
select u.id,
       coalesce(nullif(btrim(u.raw_user_meta_data ->> 'name'), ''), split_part(coalesce(u.email, ''), '@', 1)),
       coalesce(u.email, ''),
       coalesce(u.raw_user_meta_data ->> 'id_number', '')
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);


-- =====================================================================
-- 4. ROW LEVEL SECURITY  (the actual access rules)
-- =====================================================================

alter table public.profiles   enable row level security;
alter table public.books      enable row level security;
alter table public.access_log enable row level security;
alter table public.app_config enable row level security;

-- profiles: you see your own row; staff see everyone. Nobody edits rows directly
-- (approving someone and changing a photo go through the functions in section 5).
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_staff());

-- books: every signed-in person can see the catalog; only staff can change it.
drop policy if exists "books_select" on public.books;
create policy "books_select" on public.books
  for select to authenticated using (true);

drop policy if exists "books_staff_insert" on public.books;
create policy "books_staff_insert" on public.books
  for insert to authenticated with check (public.is_staff());

drop policy if exists "books_staff_update" on public.books;
create policy "books_staff_update" on public.books
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "books_staff_delete" on public.books;
create policy "books_staff_delete" on public.books
  for delete to authenticated using (public.is_staff());

-- access_log: only staff can read it. Nobody can write it directly (open_book() does).
drop policy if exists "access_log_staff_select" on public.access_log;
create policy "access_log_staff_select" on public.access_log
  for select to authenticated using (public.is_staff());

-- app_config: NO policies on purpose = invisible to the website.

-- Belt and braces: take away table permissions nobody should have.
grant usage on schema public to anon, authenticated;
revoke all on public.profiles, public.books, public.access_log, public.app_config from anon;
revoke all on public.app_config from authenticated;
revoke insert, update, delete, truncate on public.profiles   from authenticated;
revoke insert, update, delete, truncate on public.access_log from authenticated;
grant select on public.profiles, public.access_log to authenticated;
grant select, insert, update, delete on public.books to authenticated;


-- =====================================================================
-- 5. FUNCTIONS THE WEBSITE CALLS  (each one checks who is asking)
-- =====================================================================

-- Staff: approve / reject / set pending.
create or replace function public.set_user_status(p_user uuid, p_status text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'staff_only' using errcode = '42501';
  end if;
  if p_status not in ('pending', 'approved', 'rejected') then
    raise exception 'bad_status' using errcode = '22023';
  end if;
  update public.profiles
     set status = p_status, reviewed_at = now()
   where id = p_user and user_role = 'patron';
end;
$$;

-- Anyone: set (or clear) MY profile photo path. Must be inside my own folder.
create or replace function public.set_my_avatar(p_path text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_path is not null and p_path not like (auth.uid()::text || '/%') then
    raise exception 'bad_path' using errcode = '22023';
  end if;
  update public.profiles set avatar_path = p_path where id = auth.uid();
end;
$$;

-- Open an e-book: checks approval, writes the access log row, returns the files path.
create or replace function public.open_book(p_book_id bigint)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_file text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not public.is_approved() then
    raise exception 'not_approved' using errcode = '42501';
  end if;

  select b.file_name into v_file from public.books b where b.id = p_book_id;
  if not found then
    raise exception 'book_not_found' using errcode = 'P0002';
  end if;
  if v_file is null then
    raise exception 'no_file' using errcode = 'P0002';
  end if;

  -- do not count page reloads: one log row per person+book per minute
  if not exists (
    select 1 from public.access_log a
    where a.user_id = auth.uid() and a.book_id = p_book_id
      and a.accessed_at > now() - interval '60 seconds'
  ) then
    insert into public.access_log (user_id, book_id) values (auth.uid(), p_book_id);
  end if;

  return p_book_id::text || '.pdf';
end;
$$;

-- Dashboard numbers (anyone signed in; totals only - no names, no emails).
create or replace function public.dashboard_stats(p_tz text default 'UTC')
returns json
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tz    text := coalesce(nullif(btrim(p_tz), ''), 'UTC');
  v_today date;
  res     json;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  begin
    v_today := (now() at time zone v_tz)::date;
  exception when others then
    v_tz := 'UTC';
    v_today := (now() at time zone 'UTC')::date;
  end;

  select json_build_object(
    'totalBooks',    (select count(*) from public.books),
    'totalUsers',    (select count(*) from public.profiles p where p.user_role = 'patron'),
    'totalAccesses', (select count(*) from public.access_log),
    'todayAccesses', (select count(*) from public.access_log a where (a.accessed_at at time zone v_tz)::date = v_today),
    'activeToday',   (select count(distinct a.user_id) from public.access_log a where (a.accessed_at at time zone v_tz)::date = v_today),
    'top', coalesce((
      select json_agg(t) from (
        select b.title as book_title, count(*)::int as n
        from public.access_log a join public.books b on b.id = a.book_id
        group by b.id, b.title
        order by n desc, b.title
        limit 5
      ) t), '[]'::json),
    'programs', coalesce((
      select json_agg(g) from (
        select coalesce(nullif(btrim(u.program), ''), 'Unspecified') as program,
               count(*)::int as accesses,
               count(distinct u.id)::int as users
        from public.access_log a join public.profiles u on u.id = a.user_id
        group by coalesce(nullif(btrim(u.program), ''), 'Unspecified')
        order by accesses desc, program
      ) g), '[]'::json),
    'days', coalesce((
      select json_agg(d order by d.day) from (
        select (v_today - i)::text as day,
               (select count(*) from public.access_log a where (a.accessed_at at time zone v_tz)::date = (v_today - i))::int as n
        from generate_series(0, 6) as i
      ) d), '[]'::json)
  ) into res;

  return res;
end;
$$;

-- Staff: every person with their access numbers.
create or replace function public.staff_list_users()
returns json
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'staff_only' using errcode = '42501';
  end if;
  return coalesce((
    select json_agg(x order by x.created_at desc) from (
      select p.id, p.name, p.email, p.id_number, p.role_requested, p.program, p.user_role,
             p.status, p.avatar_path, p.created_at, p.reviewed_at,
             (select count(*)::int from public.access_log a where a.user_id = p.id) as read_count,
             (select count(distinct a.book_id)::int from public.access_log a where a.user_id = p.id) as distinct_books,
             (select max(a.accessed_at) from public.access_log a where a.user_id = p.id) as last_read
      from public.profiles p
    ) x), '[]'::json);
end;
$$;

-- Staff: one persons access history.
create or replace function public.staff_user_activity(p_user uuid)
returns json
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_user  json;
  v_reads json;
begin
  if not public.is_staff() then
    raise exception 'staff_only' using errcode = '42501';
  end if;
  select to_json(x) into v_user from (
    select p.id, p.name, p.email, p.id_number, p.role_requested, p.program, p.user_role,
           p.status, p.avatar_path, p.created_at
    from public.profiles p where p.id = p_user
  ) x;
  if v_user is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select coalesce(json_agg(r order by r.accessed_at desc), '[]'::json) into v_reads from (
    select a.accessed_at, b.title as book_title
    from public.access_log a join public.books b on b.id = a.book_id
    where a.user_id = p_user
    order by a.accessed_at desc
    limit 500
  ) r;
  return json_build_object('user', v_user, 'reads', v_reads);
end;
$$;

-- Staff: the 200 most recent opens (for the dashboard).
create or replace function public.staff_access_log()
returns json
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'staff_only' using errcode = '42501';
  end if;
  return coalesce((
    select json_agg(r order by r.accessed_at desc) from (
      select a.id, a.accessed_at, b.title as book_title, u.name as user_name, u.program as user_program
      from public.access_log a
      join public.books b    on b.id = a.book_id
      join public.profiles u on u.id = a.user_id
      order by a.accessed_at desc
      limit 200
    ) r), '[]'::json);
end;
$$;

-- Staff: the filtered usage report.
create or replace function public.staff_report(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_program text default null
)
returns json
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'staff_only' using errcode = '42501';
  end if;
  return coalesce((
    select json_agg(r order by r.accessed_at desc) from (
      select a.accessed_at, b.title as book_title, b.category,
             u.name as user_name, u.program, u.role_requested
      from public.access_log a
      join public.books b    on b.id = a.book_id
      join public.profiles u on u.id = a.user_id
      where (p_from is null or a.accessed_at >= p_from)
        and (p_to is null or a.accessed_at <= p_to)
        and (p_program is null or u.program = p_program)
      order by a.accessed_at desc
      limit 20000
    ) r), '[]'::json);
end;
$$;

-- Only signed-in people may call these (never anonymous visitors).
revoke execute on function public.is_staff()                                   from public, anon;
revoke execute on function public.is_approved()                                from public, anon;
revoke execute on function public.can_read_book_object(text)                   from public, anon;
revoke execute on function public.set_user_status(uuid, text)                  from public, anon;
revoke execute on function public.set_my_avatar(text)                          from public, anon;
revoke execute on function public.open_book(bigint)                            from public, anon;
revoke execute on function public.dashboard_stats(text)                        from public, anon;
revoke execute on function public.staff_list_users()                           from public, anon;
revoke execute on function public.staff_user_activity(uuid)                    from public, anon;
revoke execute on function public.staff_access_log()                           from public, anon;
revoke execute on function public.staff_report(timestamptz, timestamptz, text) from public, anon;

grant execute on function public.is_staff()                                   to authenticated;
grant execute on function public.is_approved()                                to authenticated;
grant execute on function public.can_read_book_object(text)                   to authenticated;
grant execute on function public.set_user_status(uuid, text)                  to authenticated;
grant execute on function public.set_my_avatar(text)                          to authenticated;
grant execute on function public.open_book(bigint)                            to authenticated;
grant execute on function public.dashboard_stats(text)                        to authenticated;
grant execute on function public.staff_list_users()                           to authenticated;
grant execute on function public.staff_user_activity(uuid)                    to authenticated;
grant execute on function public.staff_access_log()                           to authenticated;
grant execute on function public.staff_report(timestamptz, timestamptz, text) to authenticated;


-- =====================================================================
-- 6. FILE STORAGE  (two PRIVATE buckets)
-- =====================================================================

-- books: e-book PDFs. 50 MB per file is the free-plan maximum.
-- avatars: profile photos. 5 MB, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('books', 'books', false, 52428800, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- books: staff can do everything; everyone else can only read a file right after
-- opening it through open_book() (which logged the open).
drop policy if exists "books_files_staff_all" on storage.objects;
create policy "books_files_staff_all" on storage.objects
  for all to authenticated
  using      (bucket_id = 'books' and public.is_staff())
  with check (bucket_id = 'books' and public.is_staff());

drop policy if exists "books_files_read_after_open" on storage.objects;
create policy "books_files_read_after_open" on storage.objects
  for select to authenticated
  using (bucket_id = 'books' and public.can_read_book_object(name));

-- avatars: each person has a folder named after their user id and can only touch that
-- folder. Staff can view photos (for the Users page).
drop policy if exists "avatars_select" on storage.objects;
create policy "avatars_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars'
         and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_staff()));

drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);


-- =====================================================================
-- 7. MAKE YOUR FIRST ADMIN
--    Do this AFTER you registered once on the website. The exact command
--    is in SETUP.md (step 8); it is NOT part of this script, so nothing
--    happens by accident.
-- =====================================================================

notify pgrst, 'reload schema';
select 'NORSU E-Library database is ready.' as status;
