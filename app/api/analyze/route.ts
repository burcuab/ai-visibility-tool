import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";

export interface Check {
  id: string;
  label: string;
  description: string;
  passed: boolean;
  weight: number;
  recommendation: string;
  category: "crawlability" | "structure" | "content" | "technical";
  helpUrl?: string;
  suggestedContent?: string; // pre-generated fix content (e.g. llms.txt template)
}

export interface AnalysisResult {
  url: string;
  score: number;
  checks: Check[];
  responseTimeMs: number;
}

async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AIVisibilityBot/1.0)" },
    });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function normalizeUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

function getOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const rawUrl: string = body.url ?? "";

  if (!rawUrl) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  const url = normalizeUrl(rawUrl);
  const origin = getOrigin(url);

  const start = Date.now();

  const [pageRes, robotsRes, llmsRes] = await Promise.allSettled([
    fetchWithTimeout(url),
    fetchWithTimeout(`${origin}/robots.txt`),
    fetchWithTimeout(`${origin}/llms.txt`),
  ]);

  const responseTimeMs = Date.now() - start;

  if (pageRes.status === "rejected") {
    return NextResponse.json(
      { error: `Could not reach ${url}. Check the URL and try again.` },
      { status: 422 }
    );
  }

  const pageText = await pageRes.value.text();
  const $ = cheerio.load(pageText);

  const robotsText =
    robotsRes.status === "fulfilled" && robotsRes.value.ok
      ? await robotsRes.value.text()
      : "";

  const llmsText =
    llmsRes.status === "fulfilled" && llmsRes.value.ok
      ? await llmsRes.value.text()
      : "";

  // ── helpers ──────────────────────────────────────────────────────────────

  function isAiCrawlerAllowed(): boolean {
    if (!robotsText) return true;
    const AI_BOTS = ["gptbot", "claudebot", "perplexitybot", "anthropic-ai"];
    const lines = robotsText.split("\n").map((l) => l.trim().toLowerCase());

    let currentAgents: string[] = [];
    const agentRules: Record<string, { disallowRoot: boolean; allowRoot: boolean }> = {};

    for (const line of lines) {
      if (line.startsWith("user-agent:")) {
        const agent = line.replace("user-agent:", "").trim();
        currentAgents = [agent];
        if (!agentRules[agent]) agentRules[agent] = { disallowRoot: false, allowRoot: false };
      } else if (line === "" || line.startsWith("#")) {
        currentAgents = [];
      } else if (line.startsWith("disallow:")) {
        const path = line.replace("disallow:", "").trim();
        if (path === "/") {
          for (const a of currentAgents) {
            if (!agentRules[a]) agentRules[a] = { disallowRoot: false, allowRoot: false };
            agentRules[a].disallowRoot = true;
          }
        }
      } else if (line.startsWith("allow:")) {
        const path = line.replace("allow:", "").trim();
        if (path === "/") {
          for (const a of currentAgents) {
            if (!agentRules[a]) agentRules[a] = { disallowRoot: false, allowRoot: false };
            agentRules[a].allowRoot = true;
          }
        }
      }
    }

    // Wildcard blocks all — check if specific AI bot has an override
    const wildcard = agentRules["*"];
    if (wildcard?.disallowRoot && !wildcard?.allowRoot) {
      for (const bot of AI_BOTS) {
        if (agentRules[bot]?.allowRoot) return true;
      }
      return false;
    }

    // Check specific AI bots
    for (const bot of AI_BOTS) {
      const r = agentRules[bot];
      if (r?.disallowRoot && !r?.allowRoot) return false;
    }

    return true;
  }

  function hasSchemaOrg(): { found: boolean; types: string[] } {
    const types: string[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).text());
        if (data["@type"]) types.push(data["@type"]);
        if (Array.isArray(data["@graph"])) {
          data["@graph"].forEach((node: { "@type"?: string }) => {
            if (node["@type"]) types.push(node["@type"]);
          });
        }
      } catch { /* malformed JSON-LD */ }
    });
    const hasMicrodata = ["itemscope", "itemtype", "itemprop"].some((a) => $(`[${a}]`).length > 0);
    return { found: types.length > 0 || hasMicrodata, types };
  }

  function getH1Count(): number { return $("h1").length; }
  function getH2Count(): number { return $("h2").length; }

  function hasGoodHeadingHierarchy(): boolean {
    const headings: number[] = [];
    $("h1, h2, h3, h4").each((_, el) => {
      headings.push(parseInt(el.tagName.replace(/[^0-9]/g, ""), 10));
    });
    if (headings.length === 0) return false;
    for (let i = 1; i < headings.length; i++) {
      if (headings[i] - headings[i - 1] > 1) return false;
    }
    return true;
  }

  function hasMetaDescription(): boolean {
    return ($('meta[name="description"]').attr("content")?.trim().length ?? 0) > 0;
  }

  function hasOpenGraph(): boolean {
    return (
      ($('meta[property="og:title"]').attr("content")?.trim().length ?? 0) > 0 &&
      ($('meta[property="og:description"]').attr("content")?.trim().length ?? 0) > 0
    );
  }

  function hasLangDeclaration(): boolean {
    const lang = $("html").attr("lang");
    return !!lang && lang.trim().length > 0;
  }

  function hasAuthorMarkup(): boolean {
    const metaAuthor = $('meta[name="author"]').attr("content")?.trim();
    if (metaAuthor && metaAuthor.length > 0) return true;
    let found = false;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        if (JSON.parse($(el).text()).author) found = true;
      } catch { /* skip */ }
    });
    return found;
  }

  function getWordCount(): number {
    const clone = cheerio.load(pageText);
    clone("script, style, nav, footer, header").remove();
    return clone("body").text().replace(/\s+/g, " ").trim().split(" ").filter((w) => w.length > 0).length;
  }

  function hasExternalLinks(): boolean {
    let found = false;
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (href.startsWith("http") && !href.startsWith(origin)) found = true;
    });
    return found;
  }

  function generateLlmsTxt(): string {
    // Use only the <head> title to avoid SVG <title> elements being concatenated
    const title = $("head > title").first().text().trim() || $("h1").first().text().trim() || origin;
    const description = $('meta[name="description"]').attr("content")?.trim() ?? "";
    const SKIP = /^(footer|header|menu|navigation|nav|sidebar|cookie|skip|close|toggle|search|login|sign in|sign up)$/i;
    const seen = new Set<string>();
    const h2s: string[] = [];
    $("h2").each((_, el) => {
      const t = $(el).text().replace(/\s+/g, " ").trim();
      // skip: too short/long, starts with a digit (stats), common UI labels, duplicates
      if (
        t.length >= 4 && t.length <= 80 &&
        /[a-zA-Z]{4}/.test(t) &&
        !/^\d/.test(t) &&
        !SKIP.test(t) &&
        !seen.has(t.toLowerCase())
      ) {
        seen.add(t.toLowerCase());
        h2s.push(t);
      }
    });

    const clone = cheerio.load(pageText);
    clone("script, style, nav, footer, header").remove();
    const bodyText = clone("body").text().replace(/\s+/g, " ").trim().slice(0, 300);

    const intro = description || bodyText || "A website.";
    const topicsBlock = h2s.length > 0
      ? `\n## Topics covered\n\n${h2s.slice(0, 6).map((t) => `- ${t}`).join("\n")}`
      : "";

    return `# ${title}

> ${intro}
${topicsBlock}

## Pages

- [Home](${origin}/): Main page
- [About](${origin}/about): About us

## Notes

This llms.txt was generated by AI Visibility Score (${origin}). Edit it to reflect your actual site structure and content.
`.trim();
  }

  function hasCanonical(): boolean { return $('link[rel="canonical"]').length > 0; }

  function hasSitemap(): boolean {
    return robotsText.toLowerCase().includes("sitemap:") || $('link[rel="sitemap"]').length > 0;
  }

  function imageAltCoverage(): number {
    const imgs = $("img");
    if (imgs.length === 0) return 100;
    let withAlt = 0;
    imgs.each((_, el) => { if ($(el).attr("alt")?.trim()) withAlt++; });
    return Math.round((withAlt / imgs.length) * 100);
  }

  function hasFaqContent(): boolean {
    const text = $("body").text().toLowerCase();
    const jsonLd = $('script[type="application/ld+json"]').text().toLowerCase();
    return jsonLd.includes("faqpage") || text.includes("frequently asked") || $("[class*='faq']").length > 0;
  }

  // ── evaluate ─────────────────────────────────────────────────────────────
  const aiAllowed = isAiCrawlerAllowed();
  const llmsPresent = llmsText.trim().length > 0;
  const llmsHasContent = llmsText.trim().length > 100;
  const schema = hasSchemaOrg();
  const h1Count = getH1Count();
  const h2Count = getH2Count();
  const goodHierarchy = hasGoodHeadingHierarchy();
  const metaDesc = hasMetaDescription();
  const openGraph = hasOpenGraph();
  const langDecl = hasLangDeclaration();
  const authorMarkup = hasAuthorMarkup();
  const wordCount = getWordCount();
  const externalLinks = hasExternalLinks();
  const canonical = hasCanonical();
  const sitemap = hasSitemap();
  const altPct = imageAltCoverage();
  const faq = hasFaqContent();
  const isHttps = url.startsWith("https://");

  const checks: Check[] = [
    // ── Crawlability ─────────────────────────────────────────────────────
    {
      id: "ai-crawlers-allowed",
      label: "AI crawlers allowed",
      description: "robots.txt does not block GPTBot, ClaudeBot, or PerplexityBot",
      passed: aiAllowed,
      weight: 15,
      category: "crawlability",
      helpUrl: "https://llmstxt.org",
      recommendation:
        "Review your robots.txt and remove Disallow: / rules that block AI crawlers (GPTBot, ClaudeBot, PerplexityBot). Blocking them prevents your content from appearing in AI-powered search results.",
    },
    {
      id: "llms-txt",
      label: "llms.txt present and populated",
      description: llmsPresent
        ? llmsHasContent ? "llms.txt found with content" : "llms.txt found but appears empty or minimal"
        : "No /llms.txt file found",
      passed: llmsPresent && llmsHasContent,
      weight: 10,
      category: "crawlability",
      helpUrl: "https://llmstxt.org",
      recommendation:
        "Create a /llms.txt file at your domain root with a clear description, links to key pages, and preferred context. A file with real content (100+ chars) signals AI tools how to represent your site.",
      suggestedContent: (!llmsPresent || !llmsHasContent) ? generateLlmsTxt() : undefined,
    },
    {
      id: "sitemap",
      label: "Sitemap referenced",
      description: "robots.txt or <head> references a sitemap",
      passed: sitemap,
      weight: 8,
      category: "crawlability",
      helpUrl: "https://www.sitemaps.org/protocol.html",
      recommendation:
        "Add a Sitemap: directive to your robots.txt (e.g., Sitemap: https://yourdomain.com/sitemap.xml). This helps AI crawlers discover all your pages efficiently.",
    },
    // ── Structure ────────────────────────────────────────────────────────
    {
      id: "schema-org",
      label: "Structured data (Schema.org)",
      description: schema.types.length > 0
        ? `Found: ${schema.types.slice(0, 3).join(", ")}`
        : "No JSON-LD or microdata markup found",
      passed: schema.found,
      weight: 15,
      category: "structure",
      helpUrl: "https://schema.org/docs/gs.html",
      recommendation:
        "Add JSON-LD structured data to your pages (Article, FAQPage, Product, Organization, etc.). Structured data helps AI models understand your content type, author, and key facts precisely.",
    },
    {
      id: "meta-description",
      label: "Meta description present",
      description: 'Page has a non-empty <meta name="description"> tag',
      passed: metaDesc,
      weight: 10,
      category: "structure",
      helpUrl: "https://developers.google.com/search/docs/appearance/snippet",
      recommendation:
        "Add a clear, concise meta description (120–160 characters). AI systems use this as a quick summary of the page when crawling and indexing.",
    },
    {
      id: "open-graph",
      label: "Open Graph tags present",
      description: "Page has og:title and og:description meta tags",
      passed: openGraph,
      weight: 8,
      category: "structure",
      helpUrl: "https://ogp.me",
      recommendation:
        "Add <meta property=\"og:title\">, <meta property=\"og:description\">, and <meta property=\"og:image\"> tags. AI tools use Open Graph for link previews and content summarization.",
    },
    {
      id: "h1-present",
      label: "Single H1 heading",
      description: "Page has exactly one H1 tag",
      passed: h1Count === 1,
      weight: 10,
      category: "structure",
      helpUrl: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/Heading_Elements",
      recommendation:
        h1Count === 0
          ? "Add a single H1 heading that clearly states the page topic. AI models rely on H1 to identify the main subject."
          : `You have ${h1Count} H1 tags. Use exactly one H1 per page — multiple H1s confuse AI models about the primary topic.`,
    },
    {
      id: "h2-structure",
      label: "Content has subheadings (H2s)",
      description: "Page uses H2 headings to organize content",
      passed: h2Count >= 2,
      weight: 8,
      category: "structure",
      helpUrl: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/Heading_Elements",
      recommendation:
        "Use H2 subheadings to break your content into clearly labeled sections. AI models use heading hierarchy to parse and quote specific parts of your content.",
    },
    {
      id: "heading-hierarchy",
      label: "Heading hierarchy is valid",
      description: "Headings don't skip levels (e.g., H1 → H3 without H2)",
      passed: goodHierarchy,
      weight: 6,
      category: "structure",
      helpUrl: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/Heading_Elements",
      recommendation:
        "Fix heading levels so they increment by one (H1 → H2 → H3). Skipping levels confuses AI parsers about your content structure and makes it harder to extract accurate excerpts.",
    },
    // ── Content ──────────────────────────────────────────────────────────
    {
      id: "content-depth",
      label: `Content depth (${wordCount} words)`,
      description: "Page has at least 300 words of content",
      passed: wordCount >= 300,
      weight: 8,
      category: "content",
      recommendation:
        "Add more content — at least 300 words. Thin pages are deprioritized by AI tools when deciding what to cite or summarize. Aim for comprehensive, specific answers.",
    },
    {
      id: "author-markup",
      label: "Author markup present",
      description: 'Page declares an author via meta tag or JSON-LD',
      passed: authorMarkup,
      weight: 6,
      category: "content",
      helpUrl: "https://schema.org/author",
      recommendation:
        'Add <meta name="author" content="Author Name"> or include an "author" field in your JSON-LD. AI systems weight attributed content more highly and use author information for citations.',
    },
    {
      id: "external-citations",
      label: "External links / citations",
      description: "Page links to at least one external source",
      passed: externalLinks,
      weight: 5,
      category: "content",
      recommendation:
        "Add links to authoritative external sources relevant to your content. Pages that cite credible sources are more likely to be quoted by AI tools themselves.",
    },
    {
      id: "image-alt",
      label: `Image alt text coverage (${altPct}%)`,
      description: `${altPct}% of images have descriptive alt text`,
      passed: altPct >= 80,
      weight: 8,
      category: "content",
      helpUrl: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/img",
      recommendation:
        "Add descriptive alt text to all images. AI models cannot see images — alt text is the only way they understand visual content on your page.",
    },
    {
      id: "faq-content",
      label: "FAQ or Q&A content present",
      description: "Page contains FAQ sections or Q&A structured data",
      passed: faq,
      weight: 8,
      category: "content",
      helpUrl: "https://schema.org/FAQPage",
      recommendation:
        "Add an FAQ section or use FAQPage schema markup. AI-powered search tools (Perplexity, ChatGPT, etc.) frequently pull direct answers from FAQ content.",
    },
    // ── Technical ────────────────────────────────────────────────────────
    {
      id: "https",
      label: "Served over HTTPS",
      description: "Page uses a secure HTTPS connection",
      passed: isHttps,
      weight: 10,
      category: "technical",
      helpUrl: "https://web.dev/articles/why-https-matters",
      recommendation:
        "Migrate to HTTPS. AI crawlers deprioritize or skip insecure HTTP pages, and many modern crawlers won't follow HTTP links at all.",
    },
    {
      id: "lang-declaration",
      label: "Language declared",
      description: 'HTML element has a lang attribute (e.g., <html lang="en">)',
      passed: langDecl,
      weight: 5,
      category: "technical",
      helpUrl: "https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/lang",
      recommendation:
        'Add a lang attribute to your <html> tag (e.g., lang="en"). AI systems use this to route content to the correct language model and index.',
    },
    {
      id: "canonical",
      label: "Canonical URL set",
      description: "Page declares a canonical link to avoid duplicate content",
      passed: canonical,
      weight: 8,
      category: "technical",
      helpUrl: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
      recommendation:
        'Add a <link rel="canonical" href="..."> tag. Without it, AI crawlers may index multiple versions of the same page and dilute your content\'s authority.',
    },
    {
      id: "response-time",
      label: `Fast response time (${responseTimeMs}ms)`,
      description: "Page responds in under 3 seconds",
      passed: responseTimeMs < 3000,
      weight: 8,
      category: "technical",
      helpUrl: "https://web.dev/explore/fast",
      recommendation:
        "Improve page load time to under 3 seconds. Slow pages are more likely to be skipped or deprioritized by AI crawlers with tight timeout budgets.",
    },
  ];

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earnedWeight = checks.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0);
  const score = Math.round((earnedWeight / totalWeight) * 100);

  return NextResponse.json({ url, score, checks, responseTimeMs } satisfies AnalysisResult);
}
