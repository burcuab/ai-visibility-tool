"use client";

import { useState } from "react";
import type { AnalysisResult, Check } from "./api/analyze/route";

const CATEGORY_LABELS: Record<Check["category"], string> = {
  crawlability: "Crawlability",
  structure: "Page Structure",
  content: "Content Quality",
  technical: "Technical",
};

const CATEGORY_ORDER: Check["category"][] = [
  "crawlability",
  "structure",
  "content",
  "technical",
];

function scoreColor(score: number) {
  if (score >= 75) return { ring: "ring-green-400", text: "text-green-400", stroke: "stroke-green-400", label: "Good" };
  if (score >= 45) return { ring: "ring-yellow-400", text: "text-yellow-400", stroke: "stroke-yellow-400", label: "Needs Work" };
  return { ring: "ring-red-400", text: "text-red-400", stroke: "stroke-red-400", label: "Poor" };
}

function ScoreCircle({ score }: { score: number }) {
  const { ring, text, stroke, label } = scoreColor(score);
  const r = 54;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className={`relative w-36 h-36 rounded-full ring-4 ${ring} ring-offset-4 ring-offset-gray-950`}>
        <svg className="w-full h-full -rotate-90" viewBox="0 0 128 128">
          <circle cx="64" cy="64" r={r} fill="none" stroke="#1f2937" strokeWidth="10" />
          <circle
            cx="64" cy="64" r={r} fill="none"
            strokeWidth="10"
            strokeDasharray={`${dash} ${circ}`}
            strokeLinecap="round"
            className={stroke}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-4xl font-bold ${text}`}>{score}</span>
          <span className="text-xs text-gray-400 font-medium">/100</span>
        </div>
      </div>
      <span className={`text-sm font-semibold ${text}`}>{label}</span>
    </div>
  );
}

function CheckRow({ check }: { check: Check }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-800/50 transition-colors text-left"
      >
        <span className={`text-lg ${check.passed ? "text-green-400" : "text-red-400"}`}>
          {check.passed ? "✓" : "✗"}
        </span>
        <span className="flex-1 text-sm font-medium text-gray-200">{check.label}</span>
        <span className="text-xs text-gray-500 hidden sm:block">{check.description}</span>
        <span className="text-gray-600 text-xs ml-2">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 bg-gray-800/30 border-t border-gray-800 flex flex-col gap-2">
          {!check.passed ? (
            <p className="text-sm text-amber-300">
              <span className="font-semibold">Recommendation: </span>
              {check.recommendation}
            </p>
          ) : (
            <p className="text-sm text-green-400">This check passed.</p>
          )}
          {check.helpUrl && (
            <a
              href={check.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300 underline w-fit"
            >
              Learn more →
            </a>
          )}
          {check.suggestedContent && (
            <div className="mt-1 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">
                  Suggested llms.txt for your site
                </p>
                <button
                  onClick={() => copy(check.suggestedContent!)}
                  className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 px-3 py-1 rounded transition-colors"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <pre className="text-xs text-gray-300 bg-gray-900 border border-gray-700 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                {check.suggestedContent}
              </pre>
              <p className="text-xs text-gray-600">
                Save this as <span className="font-mono text-gray-500">llms.txt</span> at your domain root, then edit it to match your actual site.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CategorySection({ category, checks }: { category: Check["category"]; checks: Check[] }) {
  const passed = checks.filter((c) => c.passed).length;
  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earnedWeight = checks.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0);
  const catScore = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
  const scoreText = catScore >= 75 ? "text-green-400" : catScore >= 45 ? "text-yellow-400" : "text-red-400";
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          {CATEGORY_LABELS[category]}
        </h3>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold ${scoreText}`}>{catScore}%</span>
          <span className="text-xs text-gray-600">{passed}/{checks.length} passed</span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {checks.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    if (!url.trim()) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
      } else {
        setResult(data);
      }
    } catch {
      setError("Network error — could not reach the server.");
    } finally {
      setLoading(false);
    }
  }

  const grouped = result
    ? CATEGORY_ORDER.reduce<Record<string, Check[]>>((acc, cat) => {
        acc[cat] = result.checks.filter((c) => c.category === cat);
        return acc;
      }, {})
    : null;

  const failedChecks = result?.checks.filter((c) => !c.passed) ?? [];

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex flex-col items-center px-4 py-12">
      <div className="max-w-2xl w-full text-center mb-10">
        <h1 className="text-3xl font-bold tracking-tight mb-2">AI Visibility Score</h1>
        <p className="text-gray-400 text-sm">
          Find out how well your website is optimized for AI-powered search engines
          like ChatGPT, Perplexity, and Claude.
        </p>
      </div>

      <div className="max-w-2xl w-full mb-8">
        <div className="flex gap-2">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && analyze()}
            placeholder="https://yourwebsite.com"
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={analyze}
            disabled={loading || !url.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-semibold px-6 py-3 rounded-lg transition-colors"
          >
            {loading ? "Analyzing…" : "Analyze"}
          </button>
        </div>
      </div>

      {error && (
        <div className="max-w-2xl w-full bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm mb-6">
          {error}
        </div>
      )}

      {loading && (
        <div className="max-w-2xl w-full flex flex-col items-center gap-6 animate-pulse">
          <div className="w-36 h-36 rounded-full bg-gray-800" />
          <div className="w-full flex flex-col gap-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 rounded-lg bg-gray-800" />
            ))}
          </div>
        </div>
      )}

      {result && grouped && (
        <div className="max-w-2xl w-full flex flex-col gap-8">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col sm:flex-row items-center gap-6">
            <ScoreCircle score={result.score} />
            <div className="flex-1 flex flex-col gap-3 text-center">
              <p className="text-xs text-gray-500 break-all">{result.url}</p>
              <div className="flex items-center justify-center gap-6">
                <div>
                  <p className="text-2xl font-bold text-white">
                    {result.checks.filter((c) => c.passed).length}
                    <span className="text-gray-600 font-normal text-lg">/{result.checks.length}</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">checks passed</p>
                </div>
                <div className="w-px h-8 bg-gray-800" />
                <div>
                  <p className={`text-2xl font-bold ${failedChecks.length > 0 ? "text-amber-400" : "text-green-400"}`}>
                    {failedChecks.length}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">issues to fix</p>
                </div>
                <div className="w-px h-8 bg-gray-800" />
                <div>
                  <p className="text-2xl font-bold text-gray-300">{result.responseTimeMs}
                    <span className="text-gray-600 font-normal text-sm">ms</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">response time</p>
                </div>
              </div>
            </div>
          </div>

          {failedChecks.length > 0 && (
            <div>
              <h2 className="text-base font-semibold mb-3">Top Recommendations</h2>
              <div className="flex flex-col gap-3">
                {failedChecks.slice(0, 3).map((c, i) => (
                  <div
                    key={c.id}
                    className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex gap-3"
                  >
                    <span className="text-amber-400 font-bold text-sm mt-0.5">{i + 1}</span>
                    <div>
                      <p className="text-sm font-semibold text-gray-200 mb-0.5">{c.label}</p>
                      <p className="text-sm text-gray-400">{c.recommendation}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h2 className="text-base font-semibold mb-4">Detailed Checks</h2>
            <div className="flex flex-col gap-6">
              {CATEGORY_ORDER.map((cat) =>
                grouped[cat]?.length ? (
                  <CategorySection key={cat} category={cat} checks={grouped[cat]} />
                ) : null
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
