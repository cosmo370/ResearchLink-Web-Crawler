-- Crawled opportunity index: academic events (conferences, workshops, seminars)
-- and funding calls. Populated by scripts/conference-crawler.mjs and
-- scripts/funding-crawler.mjs, searched through the same weighted-FTS RPC
-- pattern as scholarly_documents.
--
-- Expiry policy: rows are never deleted when they expire. Search RPCs exclude
-- rows whose end/close date is in the past by default; rows with a NULL
-- end/close date stay visible (the crawler could not parse a deadline) and
-- the UI marks them as "deadline unverified" so a live call is never hidden
-- behind a bad parse.
begin;

create table if not exists public.event_documents (
  id text primary key,
  title text not null check (length(title) between 1 and 2000),
  description text not null default '',
  event_subtype text not null default 'conference'
    check (event_subtype in ('conference', 'workshop', 'seminar', 'hackathon')),
  organizer text,
  location text,
  location_country text,
  event_start_date date,
  event_end_date date,
  cfp_deadline date,
  url text not null,
  source text not null,
  external_id text,
  fields text[] not null default '{}',
  indexed_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, title), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(organizer, '') || ' ' || coalesce(location, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, description), 'C')
  ) stored
);
create index if not exists event_documents_fts on public.event_documents using gin(search_vector);
create index if not exists event_documents_end_date on public.event_documents(event_end_date);
create index if not exists event_documents_cfp_deadline on public.event_documents(cfp_deadline);
create index if not exists event_documents_country on public.event_documents(location_country);
create unique index if not exists event_documents_source_external on public.event_documents(source, external_id) where external_id is not null;
alter table public.event_documents enable row level security;
drop policy if exists event_documents_read on public.event_documents;
create policy event_documents_read on public.event_documents for select to anon, authenticated using (true);
grant select on public.event_documents to anon, authenticated;
grant all on public.event_documents to service_role;

create table if not exists public.funding_documents (
  id text primary key,
  title text not null check (length(title) between 1 and 2000),
  description text not null default '',
  funder text,
  amount_text text,
  eligibility_countries text[] not null default '{}',
  location_country text,
  open_date date,
  close_date date,
  url text not null,
  source text not null,
  external_id text,
  fields text[] not null default '{}',
  indexed_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, title), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(funder, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, description), 'C')
  ) stored
);
create index if not exists funding_documents_fts on public.funding_documents using gin(search_vector);
create index if not exists funding_documents_close_date on public.funding_documents(close_date);
create index if not exists funding_documents_country on public.funding_documents(location_country);
create index if not exists funding_documents_eligibility on public.funding_documents using gin(eligibility_countries);
create unique index if not exists funding_documents_source_external on public.funding_documents(source, external_id) where external_id is not null;
alter table public.funding_documents enable row level security;
drop policy if exists funding_documents_read on public.funding_documents;
create policy funding_documents_read on public.funding_documents for select to anon, authenticated using (true);
grant select on public.funding_documents to anon, authenticated;
grant all on public.funding_documents to service_role;

create or replace function public.search_event_documents(
  p_query text, p_region text default null, p_subtype text default null,
  p_include_expired boolean default false,
  p_limit integer default 25, p_after_score double precision default null,
  p_after_id text default null
) returns jsonb language sql stable security invoker
set search_path = public, pg_temp
set statement_timeout = '5s'
as $$
with query as (
  select websearch_to_tsquery('english', left(p_query, 300)) as terms
), matches as materialized (
  select d.*, ts_rank_cd(d.search_vector, q.terms, 32)::double precision
    -- Soft regional boost: locally relevant events rank higher but never
    -- hide global ones (boost stays within one order of ts_rank range).
    + case when p_region is not null and d.location_country = p_region then 0.06 else 0 end
    -- CFP deadlines closing within two weeks deserve a nudge.
    + case when d.cfp_deadline is not null
        and d.cfp_deadline between current_date and current_date + 14 then 0.04 else 0 end
    as rank_score
  from public.event_documents d cross join query q
  where length(trim(p_query)) > 0
    and d.search_vector @@ q.terms
    and (p_subtype is null or d.event_subtype = p_subtype)
), filtered as materialized (
  select m.* from matches m
  where p_include_expired
    -- NULL end dates stay visible: the crawler could not parse a date and a
    -- wrongly-hidden live conference is worse than a stale listing.
    or m.event_end_date is null
    or m.event_end_date >= current_date
), page as (
  select * from filtered
  where p_after_score is null or rank_score < p_after_score
     or (rank_score = p_after_score and id > p_after_id)
  order by rank_score desc, id asc limit least(greatest(p_limit, 1), 50) + 1
)
select jsonb_build_object(
  'rows', coalesce((select jsonb_agg(to_jsonb(page) - 'search_vector' order by rank_score desc, id asc) from page), '[]'::jsonb),
  'total', (select count(*) from filtered),
  'subtypes', coalesce((select jsonb_agg(s order by event_subtype) from (
    select event_subtype, count(*) as count from matches group by event_subtype
  ) s), '[]'::jsonb)
);
$$;
revoke all on function public.search_event_documents(text,text,text,boolean,integer,double precision,text) from public;
grant execute on function public.search_event_documents(text,text,text,boolean,integer,double precision,text) to anon, authenticated, service_role;

create or replace function public.search_funding_documents(
  p_query text, p_region text default null,
  p_include_expired boolean default false,
  p_limit integer default 25, p_after_score double precision default null,
  p_after_id text default null
) returns jsonb language sql stable security invoker
set search_path = public, pg_temp
set statement_timeout = '5s'
as $$
with query as (
  select websearch_to_tsquery('english', left(p_query, 300)) as terms
), matches as materialized (
  select d.*, ts_rank_cd(d.search_vector, q.terms, 32)::double precision
    + case when p_region is not null and (d.location_country = p_region or d.eligibility_countries @> array[p_region]) then 0.06 else 0 end
    -- Closing soon matters even more for funding calls than for CFPs.
    + case when d.close_date is not null
        and d.close_date between current_date and current_date + 21 then 0.05 else 0 end
    as rank_score
  from public.funding_documents d cross join query q
  where length(trim(p_query)) > 0
    and d.search_vector @@ q.terms
), filtered as materialized (
  select m.* from matches m
  where p_include_expired
    or m.close_date is null
    or m.close_date >= current_date
), page as (
  select * from filtered
  where p_after_score is null or rank_score < p_after_score
     or (rank_score = p_after_score and id > p_after_id)
  order by rank_score desc, id asc limit least(greatest(p_limit, 1), 50) + 1
)
select jsonb_build_object(
  'rows', coalesce((select jsonb_agg(to_jsonb(page) - 'search_vector' order by rank_score desc, id asc) from page), '[]'::jsonb),
  'total', (select count(*) from filtered)
);
$$;
revoke all on function public.search_funding_documents(text,text,boolean,integer,double precision,text) from public;
grant execute on function public.search_funding_documents(text,text,boolean,integer,double precision,text) to anon, authenticated, service_role;

commit;
