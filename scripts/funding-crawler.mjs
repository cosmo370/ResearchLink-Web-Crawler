#!/usr/bin/env node

/**
 * Funding-call crawler for the funding_documents index.
 *
 * Primary source: the Grants.gov public REST API (US federal opportunities).
 * The API's documented shape has drifted between versions, so every field
 * read goes through pick() (case/space-insensitive key matching) and the
 * pagination parameter is probed from a candidate list on the second page.
 * Calls whose close date failed to parse are still stored with close_date
 * NULL — the search RPC keeps them visible and the UI marks them
 * "deadline unverified".
 *
 * Default mode is dry-run. Pass --execute to upsert. Opportunities already
 * closed are skipped client-side as well as excluded server-side by the RPC.
 *
 * Set GRANTS_GOV_API_KEY to use the v2 API when a key has been issued;
 * v1 needs no key.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

const USER_AGENT = 'ResearchLinkOpportunityBot/1.0 (+https://researchlink-app.com/bot)';
const PAGE_SIZE = 100;
const MIN_DELAY_MS = 1200;

/** Candidate pagination parameters across Grants.gov API versions. */
const PAGINATION_PARAMS = ['startNum', 'startRecordNum', 'pageNum'];
const STATUS_PARAMS = ['open', 'forecasted'];

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
  const result = { execute: false, limit: 1000, keyword: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--execute') result.execute = true;
    else if (flag === '--limit') result.limit = Math.max(1, Math.min(5000, Number(argv[++i] || 1000)));
    else if (flag === '--keyword') result.keyword = String(argv[++i] || '').trim();
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
  for (const [key, value] of Object.entries(row)) {
    normalized.set(String(key).toLowerCase().replace(/[^a-z0-9]/g, ''), value);
  }
  for (const candidate of candidates) {
    const value = normalized.get(candidate.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function parseApiDate(raw) {
  const text = String(raw || '').trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (match) {
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12' };
    const month = months[match[1].toLowerCase().slice(0, 4)] || months[match[1].toLowerCase().slice(0, 3)];
    if (month) return `${match[3]}-${month}-${String(Number(match[2])).padStart(2, '0')}`;
  }
  return null;
}

function apiBase() {
  return process.env.GRANTS_GOV_API_KEY
    ? 'https://api.grants.gov/v2/api/search'
    : 'https://api.grants.gov/v1/api/search';
}

async function fetchPage(offsetParam, offset, keyword, status) {
  const params = new URLSearchParams({ rows: String(PAGE_SIZE) });
  if (offsetParam) params.set(offsetParam, String(offset));
  if (keyword) params.set('keyword', keyword);
  if (status) params.set('oppStatus', status);
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (process.env.GRANTS_GOV_API_KEY) headers['x-api-key'] = process.env.GRANTS_GOV_API_KEY;
  const response = await fetch(`${apiBase()}?${params.toString()}`, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`grants.gov ${response.status}`);
  const data = await response.json();
  return {
    hitCount: Number(pick(data, 'hitCount', 'totalHits', 'total') ?? 0),
    rows: Array.isArray(data.opportunityData) ? data.opportunityData : (Array.isArray(data.opportunities) ? data.opportunities : []),
  };
}

function adapt(row) {
  const externalId = pick(row, 'opportunityId', 'oppId', 'id');
  const title = compact(pick(row, 'fundingOpportunityTitle', 'opportunityTitle', 'title'), 500);
  if (!externalId || !title) return null;
  const funder = compact(pick(row, 'agencyName', 'agency', 'agencyCode'), 200);
  const closeDate = parseApiDate(pick(row, 'closeDate', 'closeDateAPI', 'applicationDeadlineDate'));
  const openDate = parseApiDate(pick(row, 'openDate', 'postDate', 'postingDate'));
  const ceiling = Number(pick(row, 'awardCeiling', 'awardAmountCeiling'));
  const floor = Number(pick(row, 'awardFloor', 'awardAmountFloor'));
  const eligibility = compact(pick(row, 'applicantEligibilityDescription', 'eligibilityDescription', 'description'), 1200);
  const category = compact(pick(row, 'opportunityCategory', 'category'), 100);

  const today = new Date().toISOString().slice(0, 10);
  if (closeDate && closeDate < today) return { id: String(externalId), skipped: 'already closed' };

  const amountText = Number.isFinite(ceiling) && ceiling > 0
    ? `Up to $${ceiling.toLocaleString('en-US')}`
    : Number.isFinite(floor) && floor > 0 ? `From $${floor.toLocaleString('en-US')}` : null;

  return {
    id: `grantsgov:${externalId}`,
    title,
    description: compact([category, eligibility].filter(Boolean).join(' — '), 1500),
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

async function main() {
  loadEnvLocal();
  const options = args(process.argv.slice(2));

  // Probe the pagination parameter: fetch the first page without an offset
  // param, then find which candidate the API accepts for page two.
  let selectedParam = null;
  const first = await fetchPage(null, 0, options.keyword, STATUS_PARAMS[0]);
  if (first.rows.length === 0 && first.hitCount === 0) {
    // Some API versions reject oppStatus — retry without it.
    const retry = await fetchPage(null, 0, options.keyword, null);
    if (retry.rows.length === 0 && retry.hitCount === 0) {
      throw new Error('Grants.gov API returned no opportunities (endpoint shape may have changed)');
    }
    Object.assign(first, retry);
  }
  console.log(`[funding-crawler] first page: ${first.rows.length} rows, hitCount=${first.hitCount}`);

  if (first.rows.length >= PAGE_SIZE && first.hitCount > PAGE_SIZE) {
    for (const candidate of PAGINATION_PARAMS) {
      try {
        const probe = await fetchPage(candidate, PAGE_SIZE, options.keyword, STATUS_PARAMS[0]);
        if (probe.rows.length > 0) {
          selectedParam = candidate;
          console.log(`[funding-crawler] pagination param: ${candidate}`);
          break;
        }
      } catch {
        // Try the next candidate.
      }
    }
    if (!selectedParam) console.log('[funding-crawler] WARNING: pagination param not found — indexing first page only');
  }

  const raw = [...first.rows];
  if (selectedParam) {
    let offset = PAGE_SIZE;
    while (raw.length < Math.min(options.limit, first.hitCount)) {
      await new Promise((resolve) => setTimeout(resolve, MIN_DELAY_MS));
      const page = await fetchPage(selectedParam, offset, options.keyword, STATUS_PARAMS[0]);
      if (page.rows.length === 0) break;
      raw.push(...page.rows);
      offset += page.rows.length;
    }
  }

  const byId = new Map();
  const skipped = [];
  for (const row of raw) {
    const entry = adapt(row);
    if (!entry) continue;
    if (entry.skipped) { skipped.push(entry); continue; }
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  const entries = [...byId.values()].slice(0, options.limit);
  console.log(JSON.stringify({
    mode: options.execute ? 'execute' : 'dry-run',
    api: process.env.GRANTS_GOV_API_KEY ? 'v2' : 'v1',
    unique_calls: entries.length,
    closed_skipped: skipped.length,
    entries: entries.slice(0, 15),
  }, null, 2));

  if (!options.execute) return;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  let stored = 0;
  for (const entry of entries) {
    const { error } = await admin.from('funding_documents').upsert(entry, { onConflict: 'id' });
    if (error) throw error;
    stored += 1;
  }
  console.log(`[funding-crawler] upserted ${stored} calls into funding_documents`);
}

main().catch((error) => { console.error(`[funding-crawler] ${error.message || error}`); process.exitCode = 1; });
