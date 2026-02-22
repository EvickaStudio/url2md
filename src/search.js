/**
 * search.js – SearXNG JSON API client.
 */
import cfg from "./config.js";

export async function searxngSearch(opts) {
  const {
    query,
    numResults = 10,
    engines = [],
    categories = [],
    language = "auto",
    timeRange,
    page = 1,
    includeDomains = [],
    excludeDomains = [],
  } = opts;

  if (!query?.trim()) throw new Error("Missing search query");

  let effectiveQuery = query;
  if (includeDomains.length > 0) {
    const siteOps = includeDomains.map((d) => `site:${d}`).join(" OR ");
    effectiveQuery = `${query} (${siteOps})`;
  }

  const params = new URLSearchParams({
    q: effectiveQuery,
    format: "json",
    pageno: String(page),
    language,
  });

  if (engines.length)    params.set("engines", engines.join(","));
  if (categories.length) params.set("categories", categories.join(","));
  if (timeRange)         params.set("time_range", timeRange);

  const url = `${cfg.searxngUrl}/search?${params}`;

  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(cfg.searxngTimeoutMs),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`SearXNG error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();

  let results = (data.results || []).map((r) => ({
    title:         r.title || "",
    url:           r.url || "",
    snippet:       r.content || "",
    engines:       Array.isArray(r.engines) ? r.engines : [r.engine].filter(Boolean),
    score:         r.score ?? 0,
    publishedDate: r.publishedDate || null,
    category:      r.category || "general",
  }));

  if (excludeDomains.length > 0) {
    const excl = excludeDomains.map((d) => d.toLowerCase());
    results = results.filter((r) => {
      try {
        const host = new URL(r.url).hostname.toLowerCase();
        return !excl.some((d) => host === d || host.endsWith(`.${d}`));
      } catch {
        return true;
      }
    });
  }

  const seen = new Set();
  results = results.filter((r) => {
    const key = r.url.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  results.sort((a, b) => b.score - a.score);
  results = results.slice(0, numResults);

  return {
    results,
    meta: {
      query,
      effectiveQuery,
      totalResults: data.number_of_results ?? results.length,
      suggestions:  data.suggestions || [],
      answers:      data.answers || [],
      unresponsiveEngines: data.unresponsive_engines || [],
    },
  };
}
