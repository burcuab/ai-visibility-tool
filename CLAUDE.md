# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # start dev server at http://localhost:3000
npm run build    # production build
npm run lint     # run ESLint
```

No tests. Verify changes by running `npm run dev` and using the app in a browser.

> **Note:** Read `node_modules/next/dist/docs/` before writing Next.js code — version 16.x has breaking changes from earlier releases.

## Architecture

Single-page Next.js app with one API route. No database, no auth, no external services.

**Request flow:** user submits a URL → `POST /api/analyze` → fetches page + `robots.txt` + `llms.txt` in parallel → runs 18 weighted checks with cheerio → returns `AnalysisResult` JSON → frontend renders score circle, per-category scores, top recommendations, and expandable check list.

### Key files

- [app/api/analyze/route.ts](app/api/analyze/route.ts) — all analysis logic. Exports `Check` and `AnalysisResult` types imported directly by the frontend.
- [app/page.tsx](app/page.tsx) — entire frontend: URL input, score circle, top recommendations, expandable check rows grouped by category with per-category scores.

### The check system

Each check is a `Check` object with: `id`, `label`, `description`, `passed`, `weight` (5–15), `category` (`crawlability` | `structure` | `content` | `technical`), `recommendation`, optional `helpUrl`, and optional `suggestedContent` (pre-generated fix content shown inline — currently used by the `llms-txt` check to render a ready-to-copy llms.txt template scraped from the page).

Score = `sum(weight of passed checks) / sum(all weights) * 100`, rounded. Per-category scores use the same formula scoped to each category's checks.

To add a check: implement a helper inside `POST`, evaluate it, push a `Check` into the array. Score and UI update automatically — no other wiring needed.

### Check categories (18 checks total)

- **Crawlability** (3): AI crawlers allowed in robots.txt, llms.txt present with content, sitemap referenced
- **Structure** (6): Schema.org/JSON-LD, meta description, Open Graph tags, single H1, H2 subheadings, heading hierarchy
- **Content** (5): content depth ≥300 words, author markup, external citations, image alt text ≥80%, FAQ content
- **Technical** (4): HTTPS, language declaration, canonical URL, response time <3s

### robots.txt parsing

Handles `User-agent`, `Disallow`, and `Allow` rules per agent block. A wildcard `Disallow: /` fails the check unless a specific AI bot (`GPTBot`, `ClaudeBot`, `PerplexityBot`, `anthropic-ai`) has an explicit `Allow: /` override.
