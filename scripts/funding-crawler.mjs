#!/usr/bin/env node

/**
 * Funding-call crawler for the funding_documents index.
 *
 * Source: the Grants.gov public REST API (US federal opportunities).
 *   - POST https://api.grants.gov/v1/api/search2 — keyless search. The body
 *     takes plural keys with pipe-separated values ("oppStatuses":
 *     "forecasted|posted"); paging is rows/startRecordNum. Watch out: a typo
 *     in a filter VALUE silently returns zero rows, and a typo in a filter
 *     NAME silently returns the whole catalog — never assume an empty result
 *     is an error state the API reported.
 *   - POST https://api.grants.gov/v1/api/fetchOpportunity — keyless detail
 *     lookup (award ceiling/floor, eligibility, synopsis) for the rows we
 *     actually upsert, capped per run to keep the crawl quick and polite.
 *
 * Search rows carry thin metadata (id, number, title, agency, dates,
 * status), so the crawler joins details for the newest `detailLimit` rows.
 * Calls whose close date failed to parse are still stored with close_date
 * NULL — the search RPC keeps them visible and the UI marks them
 * "deadline unverified". Already-closed calls are skipped.
 *
 * Default mode is dry-run. Pass --execute to upsert.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API_SEARCH = 'https://api.grants.gov/v1/api/search2';
const API_DETAIL = 'https://api.grants.gov/v1/api/fetchOpportunity';
const USER_AGENT = 'ResearchLinkOpportunityBot/1.0 (+https://researchlink-app.com/bot)';
const PAGE_SIZE = 100;
const MIN_DELAY_MS = 350;
const DEFAULT_DETAIL_LIMIT = 150;

function loadEnvLocal() {
  for (const path of ['.env.local', '.env']) {
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index < 1) continue;
      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

function args(argv) {
  const result = { execute: false, limit: 1000, keyword: null, detailLimit: DEFAULT_DETAIL_LIMIT };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--execute') result.execute = true;
    else if (flag === '--limit') result.limit = Math.max(1, Math.min(5000, Number(argv[++i] || 1000)));
    else if (flag === '--keyword') result.keyword = String(argv[++i] || '').trim();
    else if (flag === '--details') result.detailLimit = Math.max(0, Math.min(500, Number(argv[++i] ?? DEFAULT_DETAIL_LIMIT)));
    else throw new Error(`Unknown option: ${flag}`);
  }
  return result;
}

function compact(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 3).trim()}...`;
}

/** Grants.gov keys vary in casing and spacing ("fundingOpportunityTitle",
 * "Funding Opportunity Title"). Compare on a letters-and-digits-only form. */
function pick(row, ...candidates) {
  const normalized = new Map();
  for (const [key, value] of Object.entries(row ?? {})) {
    normalized.set(String(key).toLowerCase().replace(/[^a-z0-9]/g, ''), value);
  }
  for (const candidate of candidates) {
    const value = normalized.get(candidate.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

/** Grants.gov dates arrive as MM/DD/YYYY (also accepts ISO and month-name forms). */
export function parseApiDate(raw) {
  const text = String(raw || '').trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }
  match = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (match) {
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12' };
    const month = months[match[1].toLowerCase().slice(0, 4)] || months[match[1].toLowerCase().slice(0, 3)];
    if (month) return `${match[3]}-${month}-${String(Number(match[2])).padStart(2, '0')}`;
  }
  return null;
}

async function postJson(url, body, timeoutMs = 30_000) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT };
  // search2/fetchOpportunity are keyless; pass the key through when present
  // (harmless, and forwards intent if Grants.gov ever gates these paths).
  if (process.env.GRANTS_GOV_API_KEY) headers['X-API-Key'] = process.env.GRANTS_GOV_API_KEY;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`grants.gov ${response.status}`);
  return response.json();
}

/** One search2 page. oppStatuses uses the plural key with pipe-separated values. */
async function fetchSearchPage(offset, keyword) {
  const body = { rows: PAGE_SIZE, startRecordNum: offset, oppStatuses: 'forecasted|posted' };
  if (keyword) body.keyword = keyword;
  const data = await postJson(API_SEARCH, body);
  const container = (data && typeof data === 'object') ? (data.data ?? data) : {};
  return {
    hitCount: Number(pick(container, 'hitCount') ?? pick(data, 'hitCount') ?? 0),
    rows: Array.isArray(container.oppHits) ? container.oppHits : (Array.isArray(data.oppHits) ? data.oppHits : []),
  };
}

/** Detail lookup for one opportunity id. The request key is not clearly
 * documented; try the common shapes and treat failures as "no detail". */
async function fetchDetail(externalId) {
  for (const body of [{ oppId: String(externalId) }, { id: String(externalId) }, { opportunityId: String(externalId) }]) {
    try {
      const data = await postJson(API_DETAIL, body, 15_000);
      const container = (data && typeof data === 'object') ? (data.data ?? data) : {};
      const opportunity = container.opportunity ?? container.oppDetail ?? container;
      if (pick(opportunity, 'id', 'oppId', 'opportunityId')) return opportunity;
    } catch {
      // Try the next request shape.
    }
  }
  return null;
}

function adapt(row) {
  const externalId = pick(row, 'id', 'oppId', 'opportunityId');
  const title = compact(pick(row, 'title', 'fundingOpportunityTitle', 'opportunityTitle'), 500);
  if (!externalId || !title) return null;
  const funder = compact(pick(row, 'agency', 'agencyName', 'agencyCode'), 200);
  const opportunityNumber = compact(pick(row, 'number', 'fundingOpportunityNumber', 'opportunityNumber'), 100);
  const closeDate = parseApiDate(pick(row, 'closeDate', 'closeDateAPI', 'applicationDeadlineDate'));
  const openDate = parseApiDate(pick(row, 'openDate', 'postDate', 'postingDate'));
  const status = compact(pick(row, 'oppStatus', 'status'), 50);

  const today = new Date().toISOString().slice(0, 10);
  if (closeDate && closeDate < today) return { id: String(externalId), skipped: 'already closed' };

  const ceiling = Number(pick(row, 'awardCeiling', 'awardAmountCeiling'));
  const floor = Number(pick(row, 'awardFloor', 'awardAmountFloor'));
  const amountText = Number.isFinite(ceiling) && ceiling > 0
    ? `Up to $${ceiling.toLocaleString('en-US')}`
    : Number.isFinite(floor) && floor > 0 ? `From $${floor.toLocaleString('en-US')}` : null;
  const eligibility = compact(pick(row, 'applicantEligibilityDesc', 'eligibilityDesc', 'description', 'synopsis'), 1200);

  const descriptionParts = [];
  if (opportunityNumber) descriptionParts.push(`Opportunity number ${opportunityNumber}.`);
  if (status) descriptionParts.push(`Status: ${status}.`);
  if (eligibility) descriptionParts.push(eligibility);

  return {
    id: `grantsgov:${externalId}`,
    title,
    description: compact(descriptionParts.join(' '), 1500),
    funder: funder || 'U.S. federal agency',
    amount_text: amountText,
    eligibility_countries: ['US'],
    location_country: 'US',
    open_date: openDate,
    close_date: closeDate,
    url: `https://www.grants.gov/search-results-detail/${externalId}`,
    source: 'grantsgov',
    external_id: String(externalId),
    fields: [],
    indexed_at: new Date().toISOString(),
  };
}

/** Merge detail fields (amount, eligibility) into an adapted search row. */
function enrichWithDetail(entry, detail) {
  if (!detail) return entry;
  const ceiling = Number(pick(detail, 'awardCeiling', 'awardAmountCeiling'));
  const floor = Number(pick(detail, 'awardFloor', 'awardAmountFloor'));
  const amountText = Number.isFinite(ceiling) && ceiling > 0
    ? `Up to $${ceiling.toLocaleString('en-US')}`
    : Number.isFinite(floor) && floor > 0 ? `From $${floor.toLocaleString('en-US')}` : entry.amount_text;
  const eligibility = compact(pick(detail, 'applicantEligibilityDesc', 'eligibilityDesc', 'description', 'synopsis'), 1200);
  return {
    ...entry,
    amount_text: amountText ?? entry.amount_text,
    description: compact([entry.description, eligibility].filter(Boolean).join(' '), 1500),
  };
}

async function main() {
  loadEnvLocal();
  const options = args(process.argv.slice(2));

  const byId = new Map();
  const skipped = [];
  try {
    let offset = 0;
    while (byId.size < options.limit) {
      const page = await fetchSearchPage(offset, options.keyword);
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        const entry = adapt(row);
        if (!entry) continue;
        if (entry.skipped) { skipped.push(entry); continue; }
        if (!byId.has(entry.id)) byId.set(entry.id, entry);
      }
      offset += page.rows.length;
      if (offset >= page.hitCount) break;
      await new Promise((resolve) => setTimeout(resolve, MIN_DELAY_MS));
    }
    if (byId.size === 0 && skipped.length === 0) {
      throw new Error(`search2 returned no opportunities (hitCount=0${options.keyword ? ` for "${options.keyword}"` : ''})`);
    }
  } catch (error) {
    const message = compact(error?.message || error, 300);
    console.log(JSON.stringify({ mode: options.execute ? 'execute' : 'dry-run', unique_calls: 0, error: message }, null, 2));
    console.error('[funding-crawler] Grants.gov rejected this run:', message);
    console.error('[funding-crawler] The search2 endpoint is keyless; a 403 means the edge blocked this network.');
    console.error('[funding-crawler] Fix options:');
    console.error('  1. Run from a different network (local machine, self-hosted runner).');
    console.error('  2. Or report the block to the Grants.gov help desk for this repository workflow.');
    if (process.env.CI === 'true') {
      console.log(`::warning::Funding crawl skipped — Grants.gov rejected this runner (${message}).`);
      return;
    }
    throw error;
  }

  // Join richer details for the freshest slice only — keeps the run quick.
  // A circuit breaker stops detail lookups once Grants.gov's detail backend
  // is consistently unavailable (it has been observed down for periods).
  const entries = [...byId.values()].slice(0, options.limit);
  if (options.detailLimit > 0) {
    console.log(`[funding-crawler] fetching details for up to ${Math.min(options.detailLimit, entries.length)} calls`);
    let consecutiveFailures = 0;
    for (const entry of entries.slice(0, options.detailLimit)) {
      if (consecutiveFailures >= 5) {
        console.log('[funding-crawler] detail backend unavailable — skipping remaining detail lookups');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, MIN_DELAY_MS));
      try {
        const detail = await fetchDetail(entry.external_id);
        if (detail) {
          consecutiveFailures = 0;
          byId.set(entry.id, enrichWithDetail(entry, detail));
        } else {
          consecutiveFailures += 1;
        }
      } catch {
        consecutiveFailures += 1;
      }
    }
  }

  const finalEntries = entries.map((entry) => byId.get(entry.id) ?? entry);
  console.log(JSON.stringify({
    mode: options.execute ? 'execute' : 'dry-run',
    unique_calls: finalEntries.length,
    closed_skipped: skipped.length,
    entries: finalEntries.slice(0, 15),
  }, null, 2));

  if (!options.execute) return;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  let stored = 0;
  for (const entry of finalEntries) {
    const { error } = await admin.from('funding_documents').upsert(entry, { onConflict: 'id' });
    if (error) throw error;
    stored += 1;
  }
  console.log(`[funding-crawler] upserted ${stored} calls into funding_documents`);
}

// Run only when executed directly — importing the module (tests, tooling)
// must not start a crawl.
const invokedDirectly = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => { console.error(`[funding-crawler] ${error.message || error}`); process.exitCode = 1; });
}
