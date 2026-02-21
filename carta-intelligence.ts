#!/usr/bin/env bun
/**
 * Carta Intelligence Layer v1.0.0
 * Maritime RSS + IMO monitor + daily brief generator
 *
 * Part of ANKR Labs AI-CMO infrastructure.
 * Polls 7 maritime RSS feeds + IMO.org every 30 min.
 * Generates a structured morning brief at 06:30 via Claude (through ai-proxy).
 * Archives briefs to /root/carta-briefs/ and indexes them in ankr-interact.
 *
 * Run: bun /root/carta-intelligence.ts
 * Port: 4055
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = 4055;
const AI_PROXY_URL = 'http://localhost:4444';
const INTAKE_URL = 'http://localhost:3199/api/intake';
const SOURCES_FILE = '/root/carta-sources.json';
const STATE_FILE = '/root/carta-state.json';
const BRIEFS_DIR = '/root/carta-briefs';
const INTAKE_DIR = '/root/ankr-intake';

const BRIEF_HOUR = 6;       // 06:30 local time daily
const BRIEF_MINUTE = 30;
const POLL_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes
const FETCH_TIMEOUT_MS = 8_000;            // 8s per source
const LOOKBACK_HOURS = 48;                 // ignore items older than 48h

// ─── Types ────────────────────────────────────────────────────────────────────

interface Source {
  name: string;
  url: string;
  category: string;
}

interface IntelItem {
  id: string;
  title: string;
  link: string;
  pubDate: string;
  summary: string;
  source: string;
  category: string;
  isAlert?: boolean;
}

interface State {
  seenIds: string[];
  lastBriefDate: string | null;
  lastPollTime: string | null;
  itemBuffer: IntelItem[];
}

// ─── State Management ─────────────────────────────────────────────────────────

function loadState(): State {
  if (!existsSync(STATE_FILE)) {
    return { seenIds: [], lastBriefDate: null, lastPollTime: null, itemBuffer: [] };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { seenIds: [], lastBriefDate: null, lastPollTime: null, itemBuffer: [] };
  }
}

function saveState(state: State): void {
  // Cap seenIds to prevent unbounded growth
  if (state.seenIds.length > 5000) {
    state.seenIds = state.seenIds.slice(-3000);
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── RSS Fetcher ──────────────────────────────────────────────────────────────

function extractXmlText(xml: string, tag: string): string {
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const cdataMatch = cdataRe.exec(xml);
  if (cdataMatch) return cdataMatch[1].trim();

  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const plainMatch = plainRe.exec(xml);
  return plainMatch ? plainMatch[1].replace(/<[^>]+>/g, '').trim() : '';
}

function parseRssItems(xml: string): Array<{ title: string; link: string; pubDate: string; description: string }> {
  const items: Array<{ title: string; link: string; pubDate: string; description: string }> = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const chunk = match[1];
    items.push({
      title: extractXmlText(chunk, 'title'),
      link:
        extractXmlText(chunk, 'link') ||
        extractXmlText(chunk, 'guid'),
      pubDate:
        extractXmlText(chunk, 'pubDate') ||
        extractXmlText(chunk, 'dc:date') ||
        extractXmlText(chunk, 'published'),
      description:
        extractXmlText(chunk, 'description') ||
        extractXmlText(chunk, 'summary') ||
        extractXmlText(chunk, 'content:encoded'),
    });
  }
  return items;
}

async function fetchFeed(source: Source, seenIds: string[]): Promise<IntelItem[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Carta-Intelligence/1.0 (ANKR Labs maritime AI; +https://ankr.in)' },
    });
    clearTimeout(timer);

    if (!res.ok) return [];
    const xml = await res.text();
    const rawItems = parseRssItems(xml);
    const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
    const results: IntelItem[] = [];

    for (const raw of rawItems) {
      if (!raw.title || !raw.link) continue;
      const pubTime = raw.pubDate ? new Date(raw.pubDate).getTime() : 0;
      if (pubTime > 0 && pubTime < cutoff) continue;
      const id = `${source.name}::${raw.link}`;
      if (seenIds.includes(id)) continue;
      results.push({
        id,
        title: raw.title,
        link: raw.link,
        pubDate: raw.pubDate || new Date().toISOString(),
        summary: raw.description.slice(0, 400),
        source: source.name,
        category: source.category,
      });
    }
    return results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[carta] Feed failed (${source.name}): ${msg}`);
    return [];
  }
}

// ─── IMO Monitor ──────────────────────────────────────────────────────────────

async function fetchImoCirculars(seenIds: string[]): Promise<IntelItem[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch('https://www.imo.org/en/MediaCentre/Pages/WhatsNew.aspx', {
      signal: controller.signal,
      headers: { 'User-Agent': 'Carta-Intelligence/1.0 (ANKR Labs; +https://ankr.in)' },
    });
    clearTimeout(timer);
    if (!res.ok) return [];

    const html = await res.text();
    const results: IntelItem[] = [];
    const linkRe = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = linkRe.exec(html)) !== null) {
      const href = match[1];
      const text = match[2].replace(/<[^>]+>/g, '').trim();
      if (!text || text.length < 10) continue;

      const relevant = /MEPC|MSC|Circular|CII|EEXI|ETS|decarbonisation|carbon|emission/i.test(text + href);
      if (!relevant) continue;

      const fullUrl = href.startsWith('http') ? href : `https://www.imo.org${href}`;
      const id = `IMO::${fullUrl}`;
      if (seenIds.includes(id)) continue;

      results.push({
        id,
        title: text.slice(0, 200),
        link: fullUrl,
        pubDate: new Date().toISOString(),
        summary: `IMO publication: ${text.slice(0, 300)}`,
        source: 'IMO',
        category: 'regulatory',
        isAlert: true,
      });
    }

    // Deduplicate by URL
    const seen = new Set<string>();
    return results.filter(item => {
      if (seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[carta] IMO fetch failed: ${msg}`);
    return [];
  }
}

// ─── Brief Generator ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Carta, ANKR Labs' AI Chief Marketing Officer.
ANKR Labs builds maritime AI — AIS analytics, carbon compliance (CII/EEXI/EU ETS),
and freight intelligence for ship operators, brokers, and maritime tech companies.

Your job: synthesise raw maritime intelligence into a structured morning brief
for ANKR's founder. The brief must be:
- Specific: real sources, real dates, verifiable claims only
- Actionable: every item includes a recommended next step
- Prioritised: regulatory > competitor > market > content opportunity
- In your voice: sharp, technical, confident, occasionally pirate — not corporate

Brief format:
# Carta Morning Brief — [DATE]
## [PRIORITY EMOJI] [CATEGORY]: [Title]
[What was found, source, timestamp]
*Carta's note: [Strategic implication + recommended action]*
---

Priority emojis: 🔴 REGULATORY, 🟠 MARKET, 🟡 COMPETITOR, 🟢 CONTENT OPPORTUNITY

If no new items, write a brief noting quiet seas and suggest a proactive content angle.`;

async function generateBrief(items: IntelItem[], date: string): Promise<string> {
  const hasAlert = items.some(i => i.isAlert);

  const itemsText =
    items.length === 0
      ? 'No new intelligence items in the last 24 hours.'
      : items
          .map(
            item =>
              `SOURCE: ${item.source} (${item.category})\nTITLE: ${item.title}\nURL: ${item.link}\nDATE: ${item.pubDate}\nSUMMARY: ${item.summary}${item.isAlert ? '\n⚠️ ALERT: IMO regulatory item' : ''}`,
          )
          .join('\n\n---\n\n');

  const userPrompt = `Generate the Carta Morning Brief for ${date}.

New intelligence items (${items.length} total${hasAlert ? ', ⚠️ REGULATORY ALERT' : ''}):

${itemsText}`;

  try {
    const res = await fetch(`${AI_PROXY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2000,
      }),
    });

    if (!res.ok) {
      throw new Error(`ai-proxy ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '[empty response from ai-proxy]';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[carta] Brief generation failed: ${msg}`);
    // Fallback: plain item list
    return [
      `# Carta Morning Brief — ${date}`,
      '',
      `**Status:** AI proxy unavailable — ${msg}`,
      `**Items buffered:** ${items.length}`,
      '',
      ...items.map(i => `- **${i.source}**: ${i.title} — ${i.link}`),
    ].join('\n');
  }
}

// ─── Brief Publisher ──────────────────────────────────────────────────────────

async function publishBrief(brief: string, date: string): Promise<void> {
  // 1. Archive to carta-briefs/
  if (!existsSync(BRIEFS_DIR)) mkdirSync(BRIEFS_DIR, { recursive: true });
  const briefPath = join(BRIEFS_DIR, `carta-brief-${date}.md`);
  writeFileSync(briefPath, brief);
  console.log(`[carta] Brief archived → ${briefPath}`);

  // 2. POST to ankr-interact /api/intake for RAG indexing
  try {
    const res = await fetch(INTAKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: brief,
        filename: `carta-brief-${date}.md`,
        source: 'carta-intelligence',
        tags: ['carta', 'morning-brief', 'maritime', 'intelligence'],
      }),
    });
    if (res.ok) {
      console.log('[carta] Brief indexed in ankr-interact ✓');
    } else {
      console.warn(`[carta] Intake POST ${res.status} — falling back to file drop`);
      dropToIntakeDir(brief, date);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[carta] Intake POST error: ${msg} — falling back to file drop`);
    dropToIntakeDir(brief, date);
  }
}

function dropToIntakeDir(brief: string, date: string): void {
  if (!existsSync(INTAKE_DIR)) mkdirSync(INTAKE_DIR, { recursive: true });
  const path = join(INTAKE_DIR, `carta-brief-${date}.md`);
  writeFileSync(path, brief);
  console.log(`[carta] Brief dropped to intake dir → ${path}`);
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let state = loadState();
let lastBriefGenerated: string | null = state.lastBriefDate;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function pollSources(): Promise<void> {
  let sources: Source[] = [];
  try {
    sources = JSON.parse(readFileSync(SOURCES_FILE, 'utf-8'));
  } catch (err) {
    console.error('[carta] Cannot load sources file:', err instanceof Error ? err.message : err);
    return;
  }

  console.log(`[carta] Polling ${sources.length} RSS feeds + IMO at ${new Date().toISOString()}`);
  const newItems: IntelItem[] = [];

  // Fetch RSS feeds (sequential to be polite; fast enough at 30-min interval)
  for (const source of sources) {
    const items = await fetchFeed(source, state.seenIds);
    newItems.push(...items);
  }

  // Fetch IMO circulars
  const imoItems = await fetchImoCirculars(state.seenIds);
  newItems.push(...imoItems);

  if (newItems.length > 0) {
    console.log(`[carta] ${newItems.length} new items found`);
    state.seenIds.push(...newItems.map(i => i.id));
    state.itemBuffer = [...(state.itemBuffer ?? []), ...newItems];

    // Immediate alert for regulatory items found outside brief window
    const alerts = newItems.filter(i => i.isAlert);
    if (alerts.length > 0) {
      console.log(`[carta] ⚠️  REGULATORY ALERT: ${alerts.length} new IMO items`);
      immediateAlert(alerts).catch(console.error);
    }
  } else {
    console.log('[carta] No new items');
  }

  state.lastPollTime = new Date().toISOString();
  saveState(state);
}

async function generateDailyBrief(): Promise<void> {
  const today = todayStr();
  if (lastBriefGenerated === today) {
    console.log(`[carta] Brief already generated for ${today}`);
    return;
  }
  console.log(`[carta] Generating daily brief for ${today}`);
  const items = state.itemBuffer ?? [];
  const brief = await generateBrief(items, today);
  await publishBrief(brief, today);
  lastBriefGenerated = today;
  state.lastBriefDate = today;
  state.itemBuffer = [];   // Clear buffer after publishing
  saveState(state);
  console.log(`[carta] Daily brief complete (${items.length} items)`);
}

async function immediateAlert(alertItems: IntelItem[]): Promise<void> {
  const tag = `${todayStr()}-alert-${Date.now()}`;
  const brief = await generateBrief(alertItems, `${todayStr()} (Regulatory Alert)`);
  const wrapped = `> ⚠️ **IMMEDIATE REGULATORY ALERT** — Generated outside regular brief window\n\n${brief}`;
  await publishBrief(wrapped, tag);
}

function startScheduler(): void {
  // Immediate first poll
  pollSources().catch(console.error);

  // Recurring 30-min poll
  setInterval(() => pollSources().catch(console.error), POLL_INTERVAL_MS);

  // Schedule daily brief at 06:30
  function scheduleNextBrief(): void {
    const now = new Date();
    const next = new Date();
    next.setHours(BRIEF_HOUR, BRIEF_MINUTE, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    console.log(`[carta] Daily brief scheduled for ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`);
    setTimeout(() => {
      generateDailyBrief().catch(console.error);
      setInterval(() => generateDailyBrief().catch(console.error), 24 * 60 * 60 * 1000);
    }, delay);
  }
  scheduleNextBrief();
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function listBriefs(): string[] {
  if (!existsSync(BRIEFS_DIR)) return [];
  return readdirSync(BRIEFS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();
}

function getLatestBrief(): string | null {
  const briefs = listBriefs();
  if (!briefs.length) return null;
  try {
    return readFileSync(join(BRIEFS_DIR, briefs[0]), 'utf-8');
  } catch {
    return null;
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (req.method === 'GET' && pathname === '/health') {
      let sourcesCount = 0;
      try {
        sourcesCount = (JSON.parse(readFileSync(SOURCES_FILE, 'utf-8')) as Source[]).length;
      } catch {}
      return Response.json({
        status: 'ok',
        service: 'carta-intelligence',
        version: '1.0.0',
        lastBrief: lastBriefGenerated,
        lastPollTime: state.lastPollTime,
        sourcesLoaded: sourcesCount,
        itemsInBuffer: (state.itemBuffer ?? []).length,
        seenIdsCount: state.seenIds.length,
        briefsArchived: listBriefs().length,
        uptime: Math.round(process.uptime()),
      });
    }

    if (req.method === 'POST' && pathname === '/api/brief/generate') {
      // Force regeneration even if already generated today
      const today = todayStr();
      lastBriefGenerated = null;   // reset guard
      generateDailyBrief().catch(console.error);
      lastBriefGenerated = today;
      return Response.json({ status: 'generating', message: 'Brief generation triggered — check /api/brief/latest in ~30s' });
    }

    if (req.method === 'GET' && pathname === '/api/brief/latest') {
      const brief = getLatestBrief();
      if (!brief) return new Response('No briefs generated yet', { status: 404 });
      return new Response(brief, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
    }

    if (req.method === 'GET' && pathname === '/api/brief/list') {
      return Response.json({ briefs: listBriefs() });
    }

    return new Response('Not found', { status: 404 });
  },
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

if (!existsSync(BRIEFS_DIR)) mkdirSync(BRIEFS_DIR, { recursive: true });

console.log(`
╔══════════════════════════════════════════════════╗
║   Carta Intelligence Layer v1.0.0                ║
║   Maritime RSS + IMO Monitor + Brief Generator   ║
║   Port: ${PORT}  |  Poll: 30 min  |  Brief: 06:30   ║
╚══════════════════════════════════════════════════╝
`);
console.log(`[carta] HTTP server listening on port ${PORT}`);

startScheduler();
