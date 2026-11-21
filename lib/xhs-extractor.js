const XHS_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);

function compact(value, max = 20_000) {
  return String(value || "").replace(/\u200b/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

function unique(values) {
  return [...new Set(values.map((value) => compact(value, 500)).filter(Boolean))];
}

export function parseMetric(value) {
  const text = String(value || "").replace(/,/g, "");
  const match = text.match(/(\d+(?:\.\d+)?)\s*([万wW千kK]?)/);
  if (!match) return null;
  let number = Number(match[1]);
  if (["万", "w", "W"].includes(match[2])) number *= 10_000;
  if (["千", "k", "K"].includes(match[2])) number *= 1_000;
  return Math.round(number);
}

export function normalizePostUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    if (![...XHS_HOSTS].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return "";
    const match = url.pathname.match(/\/(?:explore|discovery\/item|search_result)\/([a-zA-Z0-9]+)/);
    if (!match) return "";
    const kept = new URLSearchParams();
    for (const key of ["xsec_token", "xsec_source"]) {
      const found = url.searchParams.get(key);
      if (found) kept.set(key, found);
    }
    const query = kept.toString();
    return `https://www.xiaohongshu.com${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return "";
  }
}

export function postKeyFromUrl(value) {
  return normalizePostUrl(value).match(/\/(?:explore|discovery\/item|search_result)\/([a-zA-Z0-9]+)/)?.[1] || "";
}

export function detectPageState({ url = "", title = "", text = "" } = {}) {
  const raw = `${url}\n${title}\n${text}`.slice(0, 20_000);
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep the original diagnostic text */ }
  const haystack = `${raw}\n${decoded}`;
  const verification = /验证码|安全验证|验证后继续|完成验证|verify|captcha/i.test(haystack);
  const login = /扫码登录|手机号登录|登录后查看|请先登录|\/login/i.test(haystack);
  const unavailable = /内容不存在|笔记不存在|已删除|暂时无法查看|页面不存在|访问受限/i.test(haystack);
  const platformLimited = /IP存在风险|网络环境.*重试|访问过于频繁|操作频繁|账号存在风险|error_code=300012/i.test(haystack);
  if (platformLimited) return { status: "platform_limited", message: "小红书限制了当前网络或浏览器环境。请稍后在可靠网络中手动打开专用浏览器再试；工作台不会规避平台限制。" };
  if (verification) return { status: "needs_verification", message: "小红书要求用户完成安全验证，请在专用浏览器处理后重试。" };
  if (login) return { status: "needs_login", message: "小红书登录已失效，请在专用浏览器扫码登录后重试。" };
  if (unavailable) return { status: "unavailable", message: "帖子不存在、已删除或当前账号不可访问。" };
  return { status: "ready", message: "页面可以继续读取。" };
}

export async function expandCollapsedText(page) {
  const patterns = [/展开$/, /全文$/, /展开正文/, /更多$/];
  let clicked = 0;
  for (const pattern of patterns) {
    const candidates = page.getByText(pattern).or(page.getByRole("button", { name: pattern }));
    const count = Math.min(await candidates.count().catch(() => 0), 4);
    for (let index = 0; index < count; index += 1) {
      const item = candidates.nth(index);
      if (await item.isVisible().catch(() => false)) {
        await item.click({ timeout: 1_500 }).catch(() => {});
        clicked += 1;
      }
    }
  }
  if (clicked) await page.waitForTimeout(250);
  return clicked;
}

function subtitleTextFromVtt(value) {
  return unique(String(value || "").split(/\r?\n/).filter((line) => line && !/^WEBVTT|^\d+$|-->/.test(line))).join("\n");
}

export async function extractAccessibleSubtitles(page) {
  const visible = await page.locator('[class*="subtitle"],[class*="caption"],[data-testid*="subtitle"]').allTextContents().catch(() => []);
  const visibleText = unique(visible).join("\n");
  if (visibleText) return { text: visibleText, source: "DOM 可见字幕", status: "success" };

  const tracks = await page.locator('video track[kind="captions"],video track[kind="subtitles"]').evaluateAll((nodes) => nodes.map((node) => node.src).filter(Boolean)).catch(() => []);
  for (const source of tracks.slice(0, 3)) {
    try {
      const content = await page.evaluate(async (url) => {
        const response = await fetch(url, { credentials: "include" });
        return response.ok ? response.text() : "";
      }, source);
      const text = subtitleTextFromVtt(await content);
      if (text) return { text, source: "可访问字幕轨", status: "success" };
    } catch {
      // The track exists but is not accessible with the current page session.
    }
  }
  return { text: "", source: "", status: "not_found" };
}

export async function extractPageContent(page) {
  const expandedCount = await expandCollapsedText(page);
  const raw = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\u200b/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const visible = (node) => Boolean(node && (node.getClientRects().length || node.offsetParent !== null));
    const texts = (selectors) => selectors.flatMap((selector) => [...document.querySelectorAll(selector)]
      .filter(visible).map((node) => clean(node.innerText || node.textContent)).filter(Boolean));
    const first = (selectors) => texts(selectors).sort((a, b) => b.length - a.length)[0] || "";
    const meta = (selector) => document.querySelector(selector)?.getAttribute("content")?.trim() || "";
    const jsonLd = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const value = JSON.parse(node.textContent || "null");
        if (Array.isArray(value)) jsonLd.push(...value);
        else if (value) jsonLd.push(value);
      } catch { /* malformed third-party metadata */ }
    }
    const walk = (value, output = []) => {
      if (!value || typeof value !== "object") return output;
      output.push(value);
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") walk(child, output);
      }
      return output;
    };
    const objects = jsonLd.flatMap((value) => walk(value));
    const article = objects.find((value) => value.articleBody || value.headline || /Article|Posting/i.test(String(value["@type"] || ""))) || {};
    const authorValue = article.author;
    const structuredAuthor = typeof authorValue === "string" ? authorValue : authorValue?.name || "";
    const keywords = Array.isArray(article.keywords) ? article.keywords : String(article.keywords || "").split(/[,，]/);
    const interactions = objects.flatMap((value) => Array.isArray(value.interactionStatistic) ? value.interactionStatistic : value.interactionStatistic ? [value.interactionStatistic] : []);
    const metricFromLd = (name) => interactions.find((value) => String(value.interactionType?.["@type"] || value.interactionType || "").toLowerCase().includes(name))?.userInteractionCount ?? null;
    const bodySelectors = [
      '[data-testid="note-content"]', '[data-testid="post-content"]', '#detail-desc', '.note-content .desc',
      '[class*="note-content"] [class*="desc"]', '[class*="note-detail"] [class*="desc"]',
      'article [class*="content"]', 'main article'
    ];
    const titleSelectors = ['h1', '[data-testid="note-title"]', '#detail-title', '[class*="note-detail"] [class*="title"]', 'article [class*="title"]'];
    const authorSelectors = ['[data-testid="author-name"]', 'a[href*="/user/profile"] [class*="name"]', '[class*="author"] [class*="name"]', '[class*="nickname"]'];
    const timeSelectors = ['time', '[data-testid="publish-time"]', '[class*="publish-time"]', '[class*="date"]'];
    const bodyCandidates = texts(bodySelectors).filter((value) => value.length >= 8 && !/评论\s*\d*/.test(value.slice(0, 12)));
    const domBody = bodyCandidates.sort((a, b) => b.length - a.length)[0] || "";
    const tagTexts = texts(['a[href*="/search_result"]', 'a[href*="/search?keyword"]', '[class*="tag"]'])
      .flatMap((value) => value.split(/\s+/)).filter((value) => value.startsWith("#"));
    return {
      pageTitle: document.title,
      finalUrl: location.href,
      visibleText: clean(document.body?.innerText || "").slice(0, 30_000),
      structured: {
        title: clean(article.headline || meta('meta[property="og:title"]') || meta('meta[name="title"]')),
        author: clean(structuredAuthor || meta('meta[name="author"]')),
        body: clean(article.articleBody || meta('meta[name="description"]') || meta('meta[property="og:description"]')),
        publishedAt: clean(article.datePublished || meta('meta[property="article:published_time"]')),
        tags: keywords.map(clean).filter(Boolean),
        likes: metricFromLd("like"), favorites: metricFromLd("save"), comments: metricFromLd("comment")
      },
      dom: {
        title: first(titleSelectors), author: first(authorSelectors), body: domBody, publishedAt: first(timeSelectors), tags: tagTexts
      },
      counts: {
        title: texts(titleSelectors).length, body: bodyCandidates.length, author: texts(authorSelectors).length,
        tags: tagTexts.length, images: document.querySelectorAll('article img,[class*="note-detail"] img,[class*="swiper"] img').length,
        videos: document.querySelectorAll('video').length
      }
    };
  });

  const pageState = detectPageState({ url: raw.finalUrl, title: raw.pageTitle, text: raw.visibleText });
  let ariaText = "";
  if (!raw.dom.body && !raw.structured.body) {
    ariaText = compact(await page.locator("body").ariaSnapshot({ timeout: 2_000 }).catch(() => ""), 20_000);
  }
  const fieldSources = {};
  const pick = (structured, dom, fallback, name) => {
    if (compact(structured)) { fieldSources[name] = "网页结构化数据"; return compact(structured); }
    if (compact(dom)) { fieldSources[name] = "DOM（文档对象模型）"; return compact(dom); }
    if (compact(fallback)) { fieldSources[name] = ariaText ? "Accessibility Tree（无障碍结构树）" : "页面可见文字"; return compact(fallback); }
    return "";
  };
  const visibleLines = raw.visibleText.split("\n").map((line) => compact(line, 2_000)).filter(Boolean);
  const titleFallback = visibleLines.find((line) => line.length >= 4 && line.length <= 100) || "";
  const bodyFallback = ariaText || visibleLines.filter((line) => line.length >= 12 && !/评论|登录|首页|消息|我$/.test(line)).slice(0, 12).join("\n");
  const title = pick(raw.structured.title, raw.dom.title, titleFallback, "title");
  const author = pick(raw.structured.author, raw.dom.author, "", "author");
  const body = pick(raw.structured.body, raw.dom.body, bodyFallback, "body");
  const publishedAt = pick(raw.structured.publishedAt, raw.dom.publishedAt, "", "publishedAt");
  const tags = unique([
    ...(raw.structured.tags || []),
    ...(raw.dom.tags || []),
    ...(`${title}\n${body}`.match(/#[^#\s，。！？]{1,30}/g) || []),
  ]);
  if (tags.length) fieldSources.tags = raw.structured.tags?.length ? "网页结构化数据" : "DOM（文档对象模型）";
  const metricText = raw.visibleText;
  const metric = (structured, labels, name) => {
    const fromStructured = parseMetric(structured);
    if (fromStructured !== null) { fieldSources[name] = "网页结构化数据"; return fromStructured; }
    for (const label of labels) {
      const match = metricText.match(new RegExp(`(?:${label})[ \\t]*[：:]?[ \\t]*(\\d+(?:\\.\\d+)?[ \\t]*[万wW千kK]?)`));
      const value = parseMetric(match?.[1]);
      if (value !== null) { fieldSources[name] = "页面可见文字"; return value; }
    }
    return null;
  };
  const subtitles = await extractAccessibleSubtitles(page);
  if (subtitles.text) fieldSources.videoSubtitle = subtitles.source;
  return {
    pageState,
    pageTitle: raw.pageTitle,
    finalUrl: raw.finalUrl,
    visibleTextLength: raw.visibleText.length,
    domLocatorCount: Object.values(raw.counts).reduce((sum, count) => sum + Number(count || 0), 0),
    domCounts: raw.counts,
    expandedCount,
    title, author, body, publishedAt, tags,
    likes: metric(raw.structured.likes, ["点赞", "获赞", "赞"], "likes"),
    favorites: metric(raw.structured.favorites, ["收藏"], "favorites"),
    comments: metric(raw.structured.comments, ["评论"], "comments"),
    videoSubtitle: subtitles.text,
    subtitleStatus: subtitles.status,
    fieldSources,
    raw: { structured: raw.structured, dom: raw.dom, ariaUsed: Boolean(ariaText) }
  };
}
