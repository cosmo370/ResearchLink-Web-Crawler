#!/usr/bin/env node

/**
 * Conservative academic-event (CFP) crawler.
 *
 * Source: WikiCFP public search pages (http://www.wikicfp.com). The site
 * exposes no official API, so this scrapes the HTML result tables. Two site
 * constraints are honored exactly:
 *   - The site serves over HTTP only (the HTTPS handshake fails), so every
 *     request uses http://www.wikicfp.com.
 *   - robots.txt and the site's Data page both require at most one query
 *     every five seconds.
 *
 * Result rows use a two-row layout: the first row holds the acronym link
 * (event.showcfp?eventid=NNN) plus the full name in a colspan=3 cell, the
 * second row holds when / where / deadline cells. Dates that fail to parse
 * are stored as NULL — the search RPC keeps rows with NULL end dates visible
 * and the UI marks them "deadline unverified" so a bad parse can never hide
 * a live conference.
 *
 * Default mode is dry-run (prints the entries it would store). Pass
 * --execute to upsert into event_documents.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const WIKICFP_ORIGIN = 'http://www.wikicfp.com';
const USER_AGENT = 'ResearchLinkOpportunityBot/1.0 (+https://researchlink-app.com/bot)';
// robots.txt (User-agent: *) and /cfp/data.jsp both ask for one query per
// five seconds — never go below this.
const MIN_DELAY_MS = 5000;
const MAX_HTML_BYTES = 2_000_000;
const DEFAULT_SEED_QUERIES = [
  'machine learning', 'artificial intelligence', 'computer science', 'data science',
  'bioinformatics', 'biology', 'medicine', 'neuroscience', 'genetics', 'public health',
  'physics', 'chemistry', 'materials science', 'mathematics', 'statistics',
  'engineering', 'climate', 'environment', 'economics', 'psychology', 'education',
];

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const COUNTRY_BY_NAME = {
  'usa': 'US', 'united states': 'US', 'us': 'US', 'u.s.a.': 'US', 'united kingdom': 'GB',
  'uk': 'GB', 'england': 'GB', 'scotland': 'GB', 'canada': 'CA', 'germany': 'DE',
  'france': 'FR', 'spain': 'ES', 'italy': 'IT', 'netherlands': 'NL', 'belgium': 'BE',
  'switzerland': 'CH', 'austria': 'AT', 'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK',
  'finland': 'FI', 'poland': 'PL', 'portugal': 'PT', 'ireland': 'IE', 'greece': 'GR',
  'czech republic': 'CZ', 'hungary': 'HU', 'romania': 'RO', 'turkey': 'TR', 'russia': 'RU',
  'china': 'CN', 'japan': 'JP', 'korea': 'KR', 'south korea': 'KR', 'taiwan': 'TW',
  'singapore': 'SG', 'hong kong': 'HK', 'india': 'IN', 'thailand': 'TH', 'vietnam': 'VN',
  'malaysia': 'MY', 'indonesia': 'ID', 'philippines': 'PH', 'australia': 'AU',
  'new zealand': 'NZ', 'brazil': 'BR', 'argentina': 'AR', 'chile': 'CL', 'mexico': 'MX',
  'colombia': 'CO', 'israel': 'IL', 'uae': 'AE', 'saudi arabia': 'SA', 'qatar': 'QA',
  'south africa': 'ZA', 'egypt': 'EG', 'nigeria': 'NG', 'kenya': 'KE', 'morocco': 'MA',
  'pakistan': 'PK', 'bangladesh': 'BD', 'sri lanka': 'LK', 'nepal': 'NP', 'iran': 'IR',
  'iraq': 'IQ', 'lebanon': 'LB', 'jordan': 'JO', 'estonia': 'EE', 'latvia': 'LV',
  'lithuania': 'LT', 'slovakia': 'SK', 'slovenia': 'SI', 'croatia': 'HR', 'serbia': 'RS',
  'bulgaria': 'BG', 'ukraine': 'UA', 'belarus': 'BY', 'georgia': 'GE', 'armenia': 'AM',
  'azerbaijan': 'AZ', 'kazakhstan': 'KZ', 'uzbekistan': 'UZ', 'cyprus': 'CY', 'malta': 'MT',
  'luxembourg': 'LU', 'monaco': 'MC', 'iceland': 'IS',
};

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
  const result = { execute: false, limit: 400, queries: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--execute') result.execute = true;
    else if (flag === '--limit') result.limit = Math.max(1, Math.min(2000, Number(argv[++i] || 400)));
    else if (flag === '--queries') result.queries = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return result;
}

function compact(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 3).trim()}...`;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

function robotsAllows(robotsText, targetUrl) {
  const path = new URL(targetUrl).pathname;
  let applies = false;
  let disallow = [];
  let crawlDelayMs = 5000;
  for (const raw of robotsText.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') { applies = value === '*' || value.toLowerCase() === 'researchlinkopportunitybot'; disallow = []; }
    else if (applies && key === 'disallow' && value) disallow.push(value);
    else if (applies && key === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 1) crawlDelayMs = seconds * 1000;
    }
  }
  return { allowed: !disallow.some((rule) => path.startsWith(rule)), crawlDelayMs };
}

async function fetchRobots(origin) {
  try {
    const response = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return { allowed: true, text: '', crawlDelayMs: 5000 };
    if (!response.ok) return { allowed: false, text: '', crawlDelayMs: 5000 };
    return { allowed: true, text: await response.text(), crawlDelayMs: 5000 };
  } catch {
    return { allowed: false, text: '', crawlDelayMs: 5000 };
  }
}

async function fetchSearchPage(query) {
  // year=f restricts results to this year and later — past events would
  // only be parsed and thrown away by the expiry check.
  const url = `${WIKICFP_ORIGIN}/cfp/servlet/tool.search?q=${encodeURIComponent(query)}&year=f`;
  const response = await fetch(url, {
    headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`wikicfp ${response.status}`);
  const html = await response.text();
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('wikicfp page too large');
  return html;
}

/** "Feb 01, 2026" / "2026-02-01" → Date; ranges are handled by the caller. */
export function parseSingleDate(text) {
  const trimmed = String(text || '').trim()
    // Deadline cells can carry a notification date: "Jan 22, 2027 (Jan 14, 2027)".
    .replace(/\([^)]*\)\s*$/, '').trim();
  if (!trimmed || /^(tbd|n\/?a|unknown|none)$/i.test(trimmed)) return null;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(trimmed);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    if (month) return isoDate(Number(match[3]), month, Number(match[2]));
  }
  match = /^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})/.exec(trimmed);
  if (match) {
    const month = MONTHS[match[2].toLowerCase()];
    if (month) return isoDate(Number(match[3]), month, Number(match[1]));
  }
  return null;
}

/** "Nov 15, 2027 - Nov 18, 2027" → { start, end }; single dates get start === end. */
export function parseDateSpan(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || /^(tbd|n\/?a|unknown|none)$/i.test(trimmed)) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) {
    const start = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return start ? { start, end: start } : null;
  }
  // WikiCFP "When" format: each side carries its own year.
  const bothYears = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\s*[-–]\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})?$/.exec(trimmed);
  if (bothYears) {
    const m1 = MONTHS[bothYears[1].toLowerCase()];
    const m2 = MONTHS[bothYears[4].toLowerCase()];
    if (m1 && m2) {
      const year1 = Number(bothYears[3]);
      const year2 = bothYears[6] ? Number(bothYears[6]) : year1;
      const start = isoDate(year1, m1, Number(bothYears[2]));
      const end = isoDate(year2, m2, Number(bothYears[5]));
      if (start && end) return { start, end };
    }
  }
  // Same-month range: "Aug 22-27, 2026".
  const range = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s*(\d{4})/.exec(trimmed);
  if (range) {
    const month = MONTHS[range[1].toLowerCase()];
    if (!month) return null;
    const year = Number(range[4]);
    const start = isoDate(year, month, Number(range[2]));
    const end = isoDate(year, month, Number(range[3]));
    if (start && end) return { start, end };
  }
  const single = parseSingleDate(trimmed);
  if (single) return { start: single, end: single };
  // Cross-month ranges without a first year: "Mar 28 - Apr 02, 2026".
  const months = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-–]\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})/.exec(trimmed);
  if (months) {
    const m1 = MONTHS[months[1].toLowerCase()];
    const m2 = MONTHS[months[3].toLowerCase()];
    if (m1 && m2) {
      const year = Number(months[5]);
      const start = isoDate(year, m1, Number(months[2]));
      const end = isoDate(year, m2, Number(months[4]));
      if (start && end) return { start, end };
    }
  }
  return null;
}

function isoDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function detectCountry(whereText) {
  const lower = String(whereText || '').toLowerCase();
  for (const [name, code] of Object.entries(COUNTRY_BY_NAME)) {
    if (lower.endsWith(` ${name}`) || lower === name || lower.includes(`${name},`) || lower.includes(`, ${name}`)) return code;
  }
  return null;
}

export function detectSubtype(title) {
  const lower = ` ${String(title || '').toLowerCase()} `;
  if (/\bhackathon\b/.test(lower)) return 'hackathon';
  if (/\b(workshop|tutorial|summer school|winter school|minisymposium)\b/.test(lower)) return 'workshop';
  if (/\b(seminar|colloquium|symposium)\b/.test(lower)) return 'seminar';
  return 'conference';
}

function tdCells(rowHtml) {
  return [...rowHtml.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)]
    .map((m) => ({ attrs: m[1], text: stripHtml(m[2]) }))
    .filter((cell) => cell.text.length > 0);
}

/**
 * Parse one WikiCFP event from its two-row pair:
 *   row 1: acronym link (event.showcfp?eventid=N) + full name in a colspan=3 cell
 *   row 2: when / where / deadline cells
 */
function parseEventPair(headerRow, detailRow) {
  const idMatch = /event\.showcfp\?eventid=(\d+)/.exec(headerRow);
  if (!idMatch) return null;
  const externalId = idMatch[1];

  const acronymAnchor = stripHtml(headerRow.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '');
  const headerCells = tdCells(headerRow);
  const fullName = headerCells.find((cell) => /colspan/i.test(cell.attrs))?.text
    || headerCells.find((cell) => cell.text !== acronymAnchor)?.text
    || '';
  const title = compact(fullName || acronymAnchor, 400);
  if (!title) return null;

  const detailCells = tdCells(detailRow || '');
  const whenCell = detailCells.find((cell) => parseDateSpan(cell.text) !== null);
  const whenText = whenCell ? whenCell.text : null;
  const deadlineCell = detailCells.filter((cell) => cell !== whenCell).find((cell) => parseSingleDate(cell.text) !== null);
  const whereCell = detailCells.filter((cell) => cell !== whenCell && cell !== deadlineCell)[0];
  let whereText = whereCell ? whereCell.text : null;
  if (whereText && /^(n\/?a|tbd)$/i.test(whereText)) whereText = null;

  const span = whenText ? parseDateSpan(whenText) : null;
  const today = new Date().toISOString().slice(0, 10);
  if (span && span.end < today) return { externalId, skipped: 'event already ended' };

  const description = compact(
    [
      acronymAnchor && acronymAnchor !== title ? `Acronym: ${acronymAnchor}.` : '',
      whenText ? `When: ${whenText}.` : '',
      whereText ? `Where: ${whereText}.` : '',
    ].join(' '),
    600,
  );

  return {
    id: `wikicfp:${externalId}`,
    title,
    description,
    event_subtype: detectSubtype(title),
    organizer: null,
    location: whereText ? compact(whereText, 300) : null,
    location_country: whereText ? detectCountry(whereText) : null,
    event_start_date: span ? span.start : null,
    event_end_date: span ? span.end : null,
    cfp_deadline: deadlineCell ? parseSingleDate(deadlineCell.text) : null,
    url: `${WIKICFP_ORIGIN}/cfp/servlet/event.showcfp?eventid=${externalId}`,
    source: 'wikicfp',
    external_id: String(externalId),
    fields: [],
    indexed_at: new Date().toISOString(),
  };
}

/** Parser entry point exported for tests. */
export function parseRowForTest(rowHtml) {
  const blocks = [...String(rowHtml).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  if (blocks.length >= 2) {
    const headerIdx = blocks.findIndex((b) => /event\.showcfp\?eventid=/.test(b));
    if (headerIdx >= 0 && headerIdx + 1 < blocks.length && !/event\.showcfp\?eventid=/.test(blocks[headerIdx + 1])) {
      return parseEventPair(blocks[headerIdx], blocks[headerIdx + 1]);
    }
  }
  return parseEventPair(blocks[0] ?? rowHtml, null);
}

/**
 * Extract all events from a search page. Rows come in header/detail pairs;
 * the parser walks the <tr> stream and pairs each eventid header row with
 * the next row that has no eventid (its when/where/deadline cells).
 */
function parseResults(html) {
  const blocks = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!/event\.showcfp\?eventid=\d+/.test(block)) continue;
    // Skip rows that are themselves detail rows of the previous header.
    let detail = null;
    if (i + 1 < blocks.length && !/event\.showcfp\?eventid=/.test(blocks[i + 1])) {
      detail = blocks[i + 1];
      i += 1;
    }
    const entry = parseEventPair(block, detail);
    if (!entry) continue;
    if (entry.skipped) { rows.push({ id: entry.externalId, skipped: entry.skipped }); continue; }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    rows.push(entry);
  }
  return rows;
}

async function main() {
  loadEnvLocal();
  const options = args(process.argv.slice(2));
  const queries = (options.queries.length > 0 ? options.queries : DEFAULT_SEED_QUERIES).slice(0, 30);

  const robots = await fetchRobots(WIKICFP_ORIGIN);
  if (!robots.allowed) throw new Error('wikicfp robots.txt unavailable — refusing to crawl');

  const byId = new Map();
  const skipped = [];
  for (const query of queries) {
    const target = `${WIKICFP_ORIGIN}/cfp/servlet/tool.search?q=${encodeURIComponent(query)}&year=f`;
    const rules = robotsAllows(robots.text, target);
    if (!rules.allowed) {
      skipped.push({ query, reason: 'robots.txt disallowed' });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(MIN_DELAY_MS, rules.crawlDelayMs)));
    console.log(`[conference-crawler] searching "${query}"`);
    try {
      const html = await fetchSearchPage(query);
      for (const row of parseResults(html)) {
        if (row.skipped) continue;
        if (!byId.has(row.id)) byId.set(row.id, row);
      }
    } catch (error) {
      skipped.push({ query, reason: compact(error?.message || error, 200) });
    }
    if (byId.size >= options.limit) break;
  }

  const entries = [...byId.values()].slice(0, options.limit);
  console.log(JSON.stringify({
    mode: options.execute ? 'execute' : 'dry-run',
    queries_run: queries.length,
    unique_events: entries.length,
    entries: entries.slice(0, 25),
    skipped,
  }, null, 2));

  if (!options.execute) return;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  let stored = 0;
  for (const entry of entries) {
    const { error } = await admin.from('event_documents').upsert(entry, { onConflict: 'id' });
    if (error) throw error;
    stored += 1;
  }
  console.log(`[conference-crawler] upserted ${stored} events into event_documents`);
}

// Run only when executed directly — importing the module (tests, future
// tooling) must not start a crawl.
const invokedDirectly = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => { console.error(`[conference-crawler] ${error.message || error}`); process.exitCode = 1; });
}
