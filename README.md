# ResearchLink Web Crawler

Standalone crawlers that populate the ResearchLink search indexes with
deadline-bearing opportunities:

- **Academic events** (conferences, workshops, seminars, hackathons) —
  scraped from [WikiCFP](http://www.wikicfp.com) into the `event_documents`
  table.
- **Funding calls** (grants, fellowships, prizes) — fetched from the
  [Grants.gov REST API](https://www.grants.gov) into the `funding_documents`
  table.

This repository is designed to run entirely on **GitHub Actions free
runners**: no servers to operate, state lives in Supabase, and each run
upserts incrementally.

## Schedule

| Workflow | Source | Cadence | Path |
| --- | --- | --- | --- |
| `crawl-events` | WikiCFP | daily at 03:40 UTC | `.github/workflows/crawl-events.yml` |
| `crawl-funding` | Grants.gov | every 6 hours at :50 | `.github/workflows/crawl-funding.yml` |

Both also expose a manual `workflow_dispatch` trigger with a `limit` input.

## Repository secrets

Set these under **Settings → Secrets and variables → Actions**:

| Secret | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role key for upserts (never commit this) |
| `GRANTS_GOV_API_KEY` | no | The search2 / fetchOpportunity endpoints are keyless. If set, the key is forwarded as `X-API-Key` — kept for forward compatibility if Grants.gov ever gates them. |

Note: the keyless endpoints are `POST https://api.grants.gov/v1/api/search2`
and `POST https://api.grants.gov/v1/api/fetchOpportunity`. The legacy
`GET v1/api/search` endpoint returns 403 from cloud networks — do not
switch back to it. Watch the body keys: search2 takes plural keys with
pipe-separated values (`"oppStatuses": "forecasted|posted"`), a typo in a
filter **value** silently returns zero rows, and a typo in a filter **name**
silently returns the entire catalog.

The service-role key bypasses RLS, so keep this repository's secrets private
even though the Actions minutes are free on public repositories.

## Database prerequisite

The crawlers write to tables created by the ResearchLink schema migration:
see `schema/20261121200000_opportunity_search_tables.sql`. It creates
`event_documents` and `funding_documents` (weighted-FTS indexes included)
plus the `search_event_documents` / `search_funding_documents` RPCs used by
the search API. Apply it once with the main project's
`node scripts/db-deploy.mjs`.

## Local usage

```bash
npm install
cp .env.example .env.local   # or create it with the two variables below

# Dry-run (default): prints what would be stored, writes nothing.
npm run events:crawl
npm run funding:crawl

# Execute: upserts into Supabase.
npm run events:crawl -- --execute --limit 400
npm run funding:crawl -- --execute --limit 1000
npm run funding:crawl -- --execute --keyword "artificial intelligence"
```

`conference-crawler.mjs` honors `robots.txt`, keeps a 1.5 s delay between
requests, and stops after the configured limit. `funding-crawler.mjs` pages
through the Grants.gov search API and skips calls that are already closed.

## Expiry and deadline policy

- Rows are **never deleted** when they expire — the search RPC excludes them
  from results by comparing `event_end_date` / `close_date` to today.
- Rows whose deadline could not be parsed keep a NULL date, **stay visible**
  in search results, and render with a "deadline unverified" badge in the
  ResearchLink UI. A bad parse must never hide a live opportunity.
- Expired archives remain queryable via the RPC's `p_include_expired`
  parameter.
