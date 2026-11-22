import assert from "node:assert/strict";
import test from "node:test";
import { verifyResearchSources } from "../lib/research-evidence.js";

const clock = () => new Date("2026-11-17T04:35:22Z");
const htmlResponse = (body) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

async function inspect(page, html) {
  return (await verifyResearchSources([page], { fetcher: async () => htmlResponse(html), clock }))[0];
}

test("reads visible article paragraphs, decodes metadata, and keeps canonical links on the fetched host", async () => {
  const body = "CMU is offering free access to <strong>select computing courses</strong> through CS Learn. More courses will follow.";
  const check = await inspect("https://www.cmu.edu/news/cs-learn?campaign=demo", `<!doctype html>
    <head><title>CS Learn announcement | CMU</title>
      <meta content='CMU opens access &amp; explains scope' property='og:title'>
      <meta content="Public launch &mdash; details &gt; rumor" name="description">
      <link rel='canonical' href='https://github.com/cross-site'>
      <link href='/news/cs-learn' rel='canonical'>
    </head><body><nav><p>A navigation paragraph of sufficient length for a false match.</p></nav>
    <main><p>${body}</p><p id='schedule'>Additional courses will be announced at a later date.</p>
    <p>精选课程可从学校的教学平台和官方网站免费访问。</p>
    <p>Further material is not in the first three passages.</p></main></body>`);
  assert.equal(check.status, "read");
  assert.equal(check.publisher, "www.cmu.edu");
  assert.equal(check.sourceKind, "official");
  assert.equal(check.url, "https://www.cmu.edu/news/cs-learn?campaign=demo");
  assert.equal(check.canonicalUrl, "https://www.cmu.edu/news/cs-learn");
  assert.equal(check.title, "CMU opens access & explains scope");
  assert.equal(check.summary, "Public launch — details > rumor");
  assert.equal(check.excerpt, "CMU is offering free access to select computing courses through CS Learn. More courses will follow.");
  assert.equal(check.excerptFrom, "main");
  assert.equal(check.excerptUrl, check.url);
  assert.equal(check.passages.length, 4);
  assert.equal(check.passages[0].text, check.excerpt);
  assert.deepEqual(check.passages[1], { text: "Additional courses will be announced at a later date.", source: "main:paragraph:2", url: check.url + "#schedule" });
  assert.match(check.passages[2].text, /精选课程/);
  assert.match(check.passages[3].text, /Further material/);
  assert.equal(check.checkedAt, "2026-11-17T04:35:22.000Z");
});

test("publication and update are distinct, and conflicting publication declarations are not silently chosen", async () => {
  const metadata = `<meta content='2026-11-16T08:30:00-0500' property='article:published_time'>
    <meta property='article:modified_time' content='2026-11-17T09:10:00+08:00'>
    <script type='application/ld+json'>{"@graph":[{"@type":"Organization","datePublished":"2025-01-09"},
      {"@type":"NewsArticle","headline":"Courses","datePublished":"2026-11-16"}]}</script>`;
  const source = "https://www.cmu.edu/news/courses";
  const check = await inspect(source, `<head>${metadata}</head><main><time itemprop='datePublished' datetime='2020-01-09'>Related post</time></main>`);
  assert.equal(check.publishedAt, "2026-11-16T13:30:00.000Z");
  assert.equal(check.updatedAt, "2026-11-17T01:10:00.000Z");
  assert.deepEqual(check.dateFields.publishedAt, { from: "article:published_time", raw: "2026-11-16T08:30:00-0500" });
  assert.equal(check.dateConflicts, undefined);
  const conflict = await inspect(source, `<head>${metadata.replace('"datePublished":"2026-11-16"', '"datePublished":"2026-11-10"')}</head>`);
  assert.equal(conflict.publishedAt, undefined);
  assert.equal(conflict.updatedAt, "2026-11-17T01:10:00.000Z");
  assert.equal(conflict.dateConflicts.publishedAt.length, 2);
  const invalid = await inspect(source, "<title>News</title><meta property='article:published_time' content='2026-02-29T08:30:00'>");
  assert.equal(invalid.publishedAt, undefined);
});

test("recognizes visible release dates from NVIDIA Newsroom and the Anthropic launch hero", async () => {
  const release = await inspect("https://nvidianews.nvidia.com/news/release", `<title>Release</title>
    <div class='article-date'>November 12, 2026</div><div class='article-body'>
    <p>Here is the official announcement issued by the board of directors on November 12.</p></div>`);
  assert.equal(release.status, "read");
  assert.equal(release.publishedAt, "2026-11-12");
  assert.deepEqual(release.dateFields.publishedAt, { from: "nvidia:article-date", raw: "November 12, 2026" });
  const launch = await inspect("https://www.anthropic.com/claude-launch", `<title>Release</title>
    <section aria-labelledby="launch-hero-title"><time dateTime="2026-11-09">November 9, 2026</time><h1 id="launch-hero-title">Launch</h1></section>
    <article><p>Here is the published launch article about the newly released model.</p></article>
    <article><time datetime="2026-11-16">Later unrelated release card</time></article>`);
  assert.equal(launch.status, "read");
  assert.equal(launch.publishedAt, "2026-11-09");
  assert.deepEqual(launch.dateFields.publishedAt, { from: "anthropic:launch-hero", raw: "2026-11-09" });
});

test("records discussion text as community evidence with the exact public comment anchor", async () => {
  const page = "https://news.ycombinator.com/item?id=42";
  const check = await inspect(page, `<title>News | Hacker News</title><span class="age" title="2026-11-16T20:43:36"></span>
    <div class="toptext"></div><tr class="athing comtr" id='1234'><td class='default'>
      <div class="commtext c00">I&#x27;m the first commenter in the discussion.<p>Here are additional details.</p></div></td></tr>`);
  assert.equal(check.status, "read");
  assert.equal(check.publisher, "news.ycombinator.com");
  assert.equal(check.sourceKind, "community");
  assert.equal(check.publishedAt, "2026-11-16");
  assert.equal(check.excerptFrom, "hn-comment");
  assert.equal(check.excerptUrl, `${page}#1234`);
  assert.equal(check.excerpt, "I'm the first commenter in the discussion. Here are additional details.");
  assert.equal(check.passages, undefined);
});

test("separates a metadata-only JavaScript shell or title-only page from blocked and failed pages", async () => {
  const page = "https://qwen.ai/blog?id=article";
  const shell = await inspect(page, `<head><title>Qwen</title><meta name='description' content='Qwen models'></head>
    <main><p>Please enable JavaScript before opening this website and reading the contents.</p></main>
    <!-- <article><p>Old unrelated source body captured in a template placeholder.</p></article> -->`);
  assert.equal(shell.status, "metadata");
  assert.equal(shell.summary, "Qwen models");
  assert.equal(shell.excerpt, undefined);
  assert.equal(shell.publishedAt, undefined);
  assert.equal((await inspect(page, "<title>访问受限</title><main><p>这段足够长的文字来自拦截页面，不能作为正文使用。</p></main>")).status, "unavailable");
  const [failed] = await verifyResearchSources([page], { fetcher: async () => new Response("gone", { status: 404 }), clock });
  assert.equal(failed.status, "unavailable");
  assert.match(failed.message, /404/);
});

test("checks original and discussion URLs once, keeps redirect provenance and blocks unsafe requests", async () => {
  const visited = [];
  const fetcher = async (url) => {
    visited.push(url);
    if (url.endsWith("/redirect")) return new Response("", { status: 302, headers: { location: "/published" } });
    if (url.endsWith("/unsafe")) return new Response("", { status: 302, headers: { location: "http://127.0.0.1:5186/api/state" } });
    return htmlResponse("<title>Release</title>");
  };
  const results = await verifyResearchSources([
    { originalUrl: "https://openai.com/redirect#tracking", sourceUrl: "https://news.ycombinator.com/item?id=42" },
    "https://openai.com/redirect#duplicate", "https://openai.com/unsafe", "https://openai.com@127.0.0.1/internal",
    "https://evil.openai.com/unsupported", "https://openai.com/exceeds-the-source-cap"
  ], { fetcher, clock });
  assert.deepEqual(new Set(visited), new Set([
    "https://openai.com/redirect", "https://openai.com/published", "https://news.ycombinator.com/item?id=42", "https://openai.com/unsafe"
  ]));
  assert.deepEqual(results.map((entry) => entry.status), ["metadata", "metadata", "unavailable", "manual", "manual"]);
  assert.equal(results[0].url, "https://openai.com/published");
  assert.equal(results[0].requestedUrl, "https://openai.com/redirect");
  assert.ok(results.every((entry) => entry.checkedAt === "2026-11-17T04:35:22.000Z"));
});

test("preserves response status and explicit cache signals without classifying age as staleness", async () => {
  const page = "https://qwen.ai/blog?id=launch";
  const make = (headers, status = 200) => new Response("<title>Qwen Blog</title>", { status, headers: { "content-type": "text/html", ...headers } });
  const check = async (headers, status) => (await verifyResearchSources([page], { fetcher: async () => make(headers, status), clock }))[0];
  const cached = await check({ age: "300", "x-cache": "HIT", "x-cache-status": "HIT", "cache-control": "max-age=30, stale-while-revalidate=300" });
  assert.equal(cached.httpStatus, 200);
  assert.deepEqual(cached.cache, { ageSeconds: 300, xCache: "HIT", xCacheStatus: "HIT", cacheControl: "max-age=30, stale-while-revalidate=300" });
  const stale = await check({ age: "0", "cf-cache-status": "STALE" });
  assert.deepEqual(stale.cache, { ageSeconds: 0, cfCacheStatus: "STALE", stale: true });
  const unavailable = await check({ warning: '110 cache "Response is stale"' }, 503);
  assert.equal(unavailable.httpStatus, 503);
  assert.equal(unavailable.cache.stale, true);
});

test("keeps known upstream names only where the page declares a reporting relationship", async () => {
  const page = "https://www.ithome.com/1/027/470.htm";
  const check = await inspect(page, `<title>IT之家科技报道</title><span id="pubtime_baidu">2026/11/16 7:26:25</span>
    <div id="paragraph" class="post_content"><div class="tougao-user">感谢读者提供新闻线索</div>
    <p>IT之家 11 月 16 日消息，据英国《金融时报》昨天报道，公司正考虑调整内部治理流程。</p>
    <p>The known follow-up is still being considered, according to a report by Bloomberg.</p>
    <p>路透社、金融时报和 CNBC 都有各自的科技新闻栏目和公开新闻档案。</p></div>`);
  assert.equal(check.sourceKind, "publisher");
  assert.equal(check.publishedAt, "2026-11-16");
  assert.deepEqual(check.declaredAttribution, [
    { publisher: "Financial Times", quote: "据英国《金融时报》昨天报道", source: "article:paragraph:1", url: page },
    { publisher: "Bloomberg", quote: "according to a report by Bloomberg", source: "article:paragraph:2", url: page }
  ]);
  const unrelated = await inspect(page, `<title>IT之家科技报道</title><div class="post_content">
    <p>据外媒报道，公司正在考虑调整内部治理流程。据知情人士表示，路透社也曾受邀参加活动。</p></div>`);
  assert.equal(unrelated.declaredAttribution, undefined);
});

test("keeps an official release body when its metadata and visible release date disagree", async () => {
  const page = "https://oag.ca.gov/news/press-releases/example";
  const check = await inspect(page, `<head><title>Official release</title>
    <meta property="article:published_time" content="2026-11-15T07:41:21-08:00"></head>
    <span class="date-display-single" property="dc:date" content="2026-11-16T00:00:00-08:00">Monday, November 16, 2026</span>
    <div class="field-name-body"><div class="field-items"><div class="field-item even">
    <p align="center"><em>The first paragraph highlights the office's view of the issue.</em></p>
    <p><b>SAN FRANCISCO&nbsp;</b>— The office filed a lawsuit and published a statement about its allegations.</p></div></div></div>`);
  assert.equal(check.status, "read");
  assert.equal(check.sourceKind, "official");
  assert.equal(check.publishedAt, undefined);
  assert.deepEqual(check.dateConflicts.publishedAt.map(({ raw }) => raw), ["2026-11-15T07:41:21-08:00", "2026-11-16T00:00:00-08:00"]);
  assert.match(check.excerpt, /SAN FRANCISCO — The office filed a lawsuit/);
  assert.equal(check.passages[0].source, "article:paragraph:2");
  const ordinary = await inspect(page, `<title>Official release</title><div class="field-name-body">
    <p align="center"><em>The first paragraph highlights the office's view of the issue.</em></p>
    <p>The office filed a lawsuit and published a statement about its allegations.</p></div>`);
  assert.equal(ordinary.passages[0].source, "article:paragraph:1");
});

test("captures Clay's Riemann Hypothesis status as a distinct, attributable passage", async () => {
  const page = "https://www.claymath.org/millennium/Riemann-Hypothesis/";
  const check = await inspect(page, `<title>Riemann Hypothesis | Clay Mathematics Institute</title>
    <main><p>The Riemann Hypothesis is one of the Millennium Prize Problems.</p>
    <p class="meta-tag">Unsolved</p></main>`);
  assert.equal(check.status, "read");
  assert.equal(check.sourceKind, "official");
  assert.equal(check.publisherStatus, "Unsolved");
  assert.ok(check.passages.some((passage) => passage.source === "publisher:status" && passage.text === "Unsolved"));
  assert.ok(check.passages.some((passage) => passage.url === page + "#publisher-status"));
});

test("reads primary Lean community and MIT verification records as official evidence", async () => {
  const pages = new Map([
    ["https://leanprover-community.github.io/blog/posts/riemann-hypothesis/", `<html><head><title>Lean verification of the Riemann Hypothesis</title></head>
      <main><time datetime="2026-11-21T13:55:00Z">November 21, 2026</time>
      <p>We have full confidence that Alpöge's proof of the Riemann Hypothesis is correct, and we congratulate him on this achievement.</p>
      <ol><li>The statement matches the accepted Riemann Hypothesis in Mathlib.</li>
      <li>Independent proof checkers validate the exported proof.</li></ol>
      <p>The Lean and Mathlib communities certify the statement and proof after checking compilation, theorem statement, and independent kernels.</p></main></html>`],
    ["https://math.mit.edu/~drew/grh/", `<html><head><title>Verification files for the Lean proof of the Riemann Hypothesis</title></head>
      <main><p>Andrew Sutherland (MIT), checks run with Claude Code. Page last updated 2026-11-21 12:55 UTC.</p>
      <p>The published Lean source compiles without errors, and independent proof checkers accept the full exported proof.</p>
      <table><tr id="checker-result"><td>Independent kernel</td><td>accepted</td><td>Full exported proof replay finished 16:43:21 UTC.</td></tr></table></main></html>`]
  ]);
  const results = await verifyResearchSources([...pages.keys()], { fetcher: async (url) => htmlResponse(pages.get(url)), clock });
  assert.deepEqual(results.map((entry) => entry.sourceKind), ["official", "official"]);
  assert.deepEqual(results.map((entry) => entry.status), ["read", "read"]);
  assert.match(results[0].passages[0].text, /full confidence/);
  assert.equal(results[0].publishedAt, "2026-11-21T13:55:00.000Z");
  assert.ok(results[0].passages.some((passage) => passage.source === "main:list-item:1" && /accepted Riemann Hypothesis/.test(passage.text)));
  assert.ok(results[1].passages.some((passage) => passage.source === "main:table-row:1" && /Independent kernel accepted/.test(passage.text)));
  assert.equal(results[1].updatedAt, undefined);
  assert.equal(results[1].dateFields.updatedAt.from, "mit:page-update");
  assert.equal(results[1].dateConflicts.updatedAt[0].value, "2026-11-21T12:55:00.000Z");
  assert.equal(results[1].dateConflicts.updatedAt[1].value, "2026-11-21T16:43:21.000Z");
});
