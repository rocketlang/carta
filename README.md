# Carta — ANKR Labs AI-CMO Intelligence Layer

Carta is ANKR's AI Chief Marketing Officer. This repository contains the **intelligence layer** — a Bun daemon that monitors maritime regulatory bodies, news sources, and market signals 24/7, and distills them into a structured morning brief before the founder starts the day.

## What Carta Does

- **Monitors** 7 maritime RSS feeds (Splash247, Hellenic Shipping News, The Loadstar, MarineLog, Maritime Executive, Port Technology, Seatrade Maritime)
- **Monitors** IMO.org for MEPC/MSC circulars, CII/EEXI/EU ETS regulatory updates
- **Deduplicates** via persistent state so you never see the same item twice
- **Generates** a structured morning brief at 06:30 daily via Claude (through ANKR ai-proxy)
- **Archives** briefs to `/root/carta-briefs/` and indexes them in ankr-interact for RAG retrieval
- **Triggers immediate alerts** when IMO regulatory items are detected outside the brief window

## Architecture

Single TypeScript file, zero npm dependencies. Uses Bun built-ins only: `fetch`, `Bun.serve`, `fs`.

```
carta-intelligence.ts   ← Main daemon (port 4055)
carta-sources.json      ← Editable source list (edit without restart)
carta-state.json        ← Auto-created: seen item IDs + item buffer
carta-briefs/           ← Brief archive (YYYY-MM-DD.md)
```

## Running

```bash
# Start via ankr-ctl
ankr-ctl start carta-intelligence

# Or directly
bun /root/carta-intelligence.ts
```

## API

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Status, last brief date, items buffered, sources loaded |
| `/api/brief/generate` | POST | Immediately generate + publish brief |
| `/api/brief/latest` | GET | Return last brief markdown |
| `/api/brief/list` | GET | List all archived briefs |

## Brief Format

```markdown
# Carta Morning Brief — 21 February 2026

**Generated:** 06:30 | **Sources checked:** 7 RSS + IMO | **New items:** 14

---

## 🔴 REGULATORY: IMO Publishes MEPC Circular on CII Revision
**Source:** IMO.org | **Published:** 20 Feb 2026

*Carta's note: No maritime AI company has published on this yet. First-mover window: 36 hours.*

---

## 🟠 MARKET: Baltic Dry Index Falls 4.2%
...
```

## Adding Sources

Edit `carta-sources.json` — changes are picked up on the next poll (no restart needed):

```json
[
  { "name": "My Feed", "url": "https://example.com/feed/", "category": "news" }
]
```

## Part of ANKR Labs

- **ai-proxy**: `http://localhost:4444` (Claude routing)
- **ankr-interact**: `http://localhost:3199` (RAG indexing)
- **Port**: 4055 (`backend.cartaIntelligence` in ports.json)
