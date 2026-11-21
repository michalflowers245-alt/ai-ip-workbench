import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { detectPageState, extractPageContent, normalizePostUrl, parseMetric, postKeyFromUrl } from "../lib/xhs-extractor.js";

let browser;
test.before(async () => { browser = await chromium.launch({ channel: "chrome", headless: true }); });
test.after(async () => { await browser.close(); });

test("normalizes Xiaohongshu links and removes unrelated query data", () => {
  const normalized = normalizePostUrl("https://www.xiaohongshu.com/explore/abc123?xsec_token=allowed&utm_source=nope");
  assert.equal(normalized, "https://www.xiaohongshu.com/explore/abc123?xsec_token=allowed");
  assert.equal(postKeyFromUrl(normalized), "abc123");
  assert.equal(normalizePostUrl("https://example.com/explore/abc123"), "");
});

test("parses visible Chinese social metrics", () => {
  assert.equal(parseMetric("1.2万"), 12000);
  assert.equal(parseMetric("3,208"), 3208);
  assert.equal(parseMetric("没有"), null);
});

test("distinguishes login, verification and unavailable pages", () => {
  assert.equal(detectPageState({ text: "请先登录后查看" }).status, "needs_login");
  assert.equal(detectPageState({ text: "完成安全验证" }).status, "needs_verification");
  assert.equal(detectPageState({ text: "笔记不存在" }).status, "unavailable");
  assert.equal(detectPageState({ url: "https://www.xiaohongshu.com/website-login/error?error_msg=IP%E5%AD%98%E5%9C%A8%E9%A3%8E%E9%99%A9" }).status, "platform_limited");
  assert.equal(detectPageState({ text: "普通内容" }).status, "ready");
});

test("extracts structured metadata, DOM fields, tags and metrics", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <main><article>
      <h1>大学生如何开始 AI 项目</h1>
      <a href="/user/profile/u1"><span class="name">小西</span></a>
      <div data-testid="note-content">这是完整正文，先做一个可以交付的小项目。 #大学生 #AI</div>
      <time>2026-09-15</time><div>点赞 1.2万 收藏 860 评论 72</div>
    </article></main>
    <script type="application/ld+json">{"@type":"SocialMediaPosting","headline":"结构化标题","author":{"name":"结构化作者"},"datePublished":"2026-09-14","keywords":["AI实践"]}</script>
  `);
  const result = await extractPageContent(page);
  assert.equal(result.title, "结构化标题");
  assert.equal(result.author, "结构化作者");
  assert.match(result.body, /完整正文/);
  assert.equal(result.likes, 12000);
  assert.equal(result.favorites, 860);
  assert.ok(result.tags.includes("AI实践"));
  assert.equal(result.fieldSources.title, "网页结构化数据");
  await page.close();
});

test("clicks an expand control before reading the full body", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <article><h1>可展开文章</h1><div data-testid="note-content" id="copy">短正文</div>
    <button onclick="document.querySelector('#copy').textContent='展开后的完整正文，包含足够的信息和一个具体案例。'">展开正文</button></article>
  `);
  const result = await extractPageContent(page);
  assert.match(result.body, /展开后的完整正文/);
  assert.ok(result.expandedCount >= 1);
  await page.close();
});

test("falls back to visible accessibility content after selector changes", async () => {
  const page = await browser.newPage();
  await page.setContent(`<main aria-label="帖子详情"><div class="totally-new-structure">当 DOM 选择器变化以后，这段足够长的可见文字仍应作为兜底正文被读取。</div></main>`);
  const result = await extractPageContent(page);
  assert.match(result.body, /DOM 选择器变化/);
  assert.match(result.fieldSources.body, /Accessibility Tree|页面可见文字/);
  await page.close();
});
