const publishers = new Set([
  "aihot.news", "arxiv.org", "anthropic.com", "blog.google", "deepmind.google", "github.com", "news.ycombinator.com", "www.cmu.edu", "www.cs.cmu.edu",
  "huggingface.co", "m.ithome.com", "microsoft.com", "nvidianews.nvidia.com", "oag.ca.gov", "openai.com", "qwen.ai", "research.google", "www.anthropic.com",
  "www.ithome.com", "www.microsoft.com", "www.openai.com", "x.ai"
]);
const publishingPlatforms = new Set(["arxiv.org", "github.com", "huggingface.co", "m.ithome.com", "www.ithome.com"]);
const reportedBy = [
  ["Reuters", "路透社|Reuters"], ["Bloomberg", "彭博社|Bloomberg"], ["Financial Times", "金融时报|Financial Times"],
  ["The Verge", "The Verge"], ["TechCrunch", "TechCrunch"], ["CNBC", "CNBC"], ["NBC News", "NBC News"],
  ["The Wall Street Journal", "华尔街日报|The Wall Street Journal|Wall Street Journal"],
  ["The Washington Post", "华盛顿邮报|The Washington Post|Washington Post"], ["Associated Press", "美联社|Associated Press"],
  ["The New York Times", "纽约时报|The New York Times|New York Times"], ["The Information", "The Information"]
];
const maxPageBytes = 350_000;
const tags = {
  meta: /<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi,
  link: /<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi,
  script: /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi,
  time: /<time\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi,
  div: /<(\/?)div\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi,
  tr: /<tr\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi
};
const entities = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

function publicUrl(value) {
  try {
    const target = new URL(value);
    if (target.protocol === "https:" && !target.username && !target.password && !target.port && publishers.has(target.hostname)) {
      target.hash = "";
      return target;
    }
  } catch {}
  return null;
}

function sourceKind(host) {
  if (host === "news.ycombinator.com") return "community";
  if (host === "aihot.news") return "catalog";
  return publishingPlatforms.has(host) ? "publisher" : "official";
}

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, key) => {
    const name = key.toLowerCase();
    if (name[0] !== "#") return Object.hasOwn(entities, name) ? entities[name] : entity;
    const codePoint = name[1] === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : entity;
  });
}

function plain(text = "") {
  return decodeEntities(String(text).replace(/<\/?(?:br|p|div|li)\b[^>]*>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function canonicalUrl(html, target) {
  for (const [, markup] of html.matchAll(tags.link)) {
    const attrs = attributes(markup);
    if (!attrs.rel?.toLowerCase().split(/\s+/).includes("canonical") || !attrs.href?.trim()) continue;
    try {
      const canonical = publicUrl(new URL(decodeEntities(attrs.href.trim()), target));
      if (canonical?.hostname === target.hostname) return canonical.href;
    } catch {}
  }
}

function attributes(source) {
  return Object.fromEntries(Array.from(source.matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"=<>`]+)))?/g),
    ([, name, double, single, bare]) => [name.toLowerCase(), double ?? single ?? bare ?? ""]));
}

async function sample(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let html = "";
  try {
    while (size < maxPageBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const content = value.subarray(0, maxPageBytes - size);
      size += content.length;
      html += decoder.decode(content, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return html + decoder.decode();
}

function metadata(html) {
  const fields = new Map();
  for (const [, markup] of html.matchAll(tags.meta)) {
    const attrs = attributes(markup);
    for (const name of [attrs.property, attrs.name, attrs.itemprop].filter(Boolean)) {
      if (attrs.content && !fields.has(name.toLowerCase())) fields.set(name.toLowerCase(), attrs.content);
    }
  }
  return fields;
}

function articleSchema(html) {
  for (const [, markup, text] of html.matchAll(tags.script)) {
    if (attributes(markup).type?.toLowerCase().split(";")[0].trim() !== "application/ld+json") continue;
    let data;
    try { data = JSON.parse(text.trim()); } catch { continue; }
    const list = Array.isArray(data) ? data : [data];
    for (const entry of list.flatMap((item) => [item, ...(Array.isArray(item?.["@graph"]) ? item["@graph"] : [])])) {
      if ([entry?.["@type"]].flat().some((type) => typeof type === "string" && /(?:article|blogposting)$/i.test(type))) return entry;
    }
  }
  return {};
}

function dateValue(value) {
  const raw = typeof value === "string" ? plain(value) : "";
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (!match) return undefined;
  const [, day, hour, minute, second, fraction, zone] = match;
  const calendar = new Date(day);
  if (!Number.isFinite(+calendar) || calendar.toISOString().slice(0, 10) !== day || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  if (!zone) return day;
  const timestamp = new Date(`${day}T${hour}:${minute}:${second ?? "00"}${fraction ?? ""}${zone.toUpperCase()}`);
  return Number.isFinite(+timestamp) ? timestamp.toISOString() : undefined;
}

function visibleReleaseDate(html, host) {
  if (host === "oag.ca.gov") {
    const span = html.match(/<span\b([^>]*\bproperty=["']dc:date["'][^>]*)>/i);
    const raw = span && attributes(span[1]).content;
    if (raw && dateValue(raw)) return ["oag:release-date", raw, raw.slice(0, 10)];
  }
  if (host === "www.ithome.com" || host === "m.ithome.com") {
    const raw = plain(html.match(/<span\b[^>]*\bid=["']pubtime_baidu["'][^>]*>([^<]*)<\/span>/i)?.[1]);
    const date = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2}) /);
    const normalized = date && [date[1], date[2].padStart(2, "0"), date[3].padStart(2, "0")].join("-");
    if (normalized && dateValue(normalized)) return ["ithome:published-date", raw, normalized];
  }
  if (host === "nvidianews.nvidia.com") {
    const raw = plain(classText(html, "article-date"));
    if (!/^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/.test(raw)) return [];
    const timestamp = new Date(raw + " UTC");
    if (!Number.isFinite(+timestamp) || timestamp.getUTCDate() !== Number(raw.match(/\d+/)[0])) return [];
    return ["nvidia:article-date", raw, timestamp.toISOString().slice(0, 10)];
  }
  if (["anthropic.com", "www.anthropic.com"].includes(host)) {
    const hero = html.match(/<section\b[^>]*aria-labelledby=["']launch-hero-title["'][^>]*>([\s\S]*?)<\/section\s*>/i)?.[1] || "";
    const time = hero.matchAll(tags.time).next().value?.[1];
    if (time) return ["anthropic:launch-hero", attributes(time).datetime];
  }
  return [];
}

function dates(fields, article, html, host) {
  const marked = new Map();
  for (const [, markup] of withoutChrome(html).matchAll(tags.time)) {
    const attrs = attributes(markup);
    if (attrs.itemprop && attrs.datetime && !marked.has(attrs.itemprop.toLowerCase())) marked.set(attrs.itemprop.toLowerCase(), attrs.datetime);
  }
  const hnDate = host === "news.ycombinator.com"
    ? html.match(/<span class="age" title="([^" ]+)[^"]*"/i)?.[1]
    : undefined;
  const candidates = {
    publishedAt: [["article:published_time", fields.get("article:published_time")], ["schema:datePublished", article.datePublished],
      ["meta:datePublished", fields.get("datepublished")], visibleReleaseDate(html, host), ["hn:submission", hnDate]],
    updatedAt: [["article:modified_time", fields.get("article:modified_time")], ["schema:dateModified", article.dateModified],
      ["meta:dateModified", fields.get("datemodified")]]
  };
  const result = {};
  for (const [field, entries] of Object.entries(candidates)) {
    const values = entries.map(([from, raw, normalized]) => ({ from, raw, value: normalized || dateValue(raw) })).filter((entry) => entry.value);
    if (!values.length) {
      const name = field === "publishedAt" ? "datePublished" : "dateModified";
      const raw = marked.get(name.toLowerCase());
      const value = dateValue(raw);
      if (value) values.push({ from: "time:" + name, raw, value });
    }
    if (!values.length) continue;
    const primary = values.find((entry) => entry.value.length > 10) || values[0];
    if (values.some(({ value, raw }) => value !== primary.value && !(value.length === 10 && (primary.value.startsWith(value) || primary.raw.startsWith(value))) &&
        !(primary.value.length === 10 && raw.startsWith(primary.value)))) {
      (result.dateConflicts ??= {})[field] = values;
      continue;
    }
    result[field] = primary.value;
    (result.dateFields ??= {})[field] = { from: primary.from, raw: primary.raw };
  }
  return result;
}

function withoutChrome(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|template|noscript|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
}

function excerpt(text) {
  const normalized = plain(text);
  const substantive = normalized.length >= 40 || (normalized.match(/\p{Script=Han}/gu)?.length ?? 0) >= 18;
  if (!substantive || /^(?:(?:please )?(?:enable javascript|sign in|log in|subscribe|loading|access denied|verify (?:that )?you|checking (?:if|your))\b|安全验证|请(?:开启|启用)\s*javascript)/i.test(normalized)) return "";
  const limit = 300;
  if (normalized.length <= limit) return normalized;
  const prefix = normalized.slice(0, limit);
  const lastSentence = [...prefix.matchAll(/(?:[。！？]|[.!?](?=\s|$))/g)].at(-1);
  return lastSentence && lastSentence.index > 110 ? prefix.slice(0, lastSentence.index + 1) : prefix.trimEnd();
}

function classText(html, name) {
  const matches = html.matchAll(tags.div);
  for (const match of matches) {
    if (match[1] || !attributes(match[2]).class?.split(/\s+/).includes(name)) continue;
    let depth = 1;
    const start = match.index + match[0].length;
    for (const tag of matches) {
      depth += tag[1] ? -1 : 1;
      if (!depth) return html.slice(start, tag.index);
    }
    return html.slice(start);
  }
  return "";
}

function discussionExcerpt(html, target) {
  if (target.pathname !== "/item" || !/^\d+$/.test(target.searchParams.get("id") || "")) return {};
  const submission = excerpt(classText(html, "toptext"));
  if (submission) return { excerpt: submission, excerptFrom: "hn-submission", excerptUrl: target.href };
  const comments = Array.from(html.matchAll(tags.tr)).filter((match) => attributes(match[1]).class?.split(/\s+/).includes("comtr"));
  for (const [index, row] of comments.entries()) {
    const id = attributes(row[1]).id;
    if (!/^\d+$/.test(id || "")) continue;
    const comment = html.slice(row.index + row[0].length, comments[index + 1]?.index);
    const text = excerpt(classText(comment, "commtext"));
    if (text) {
      const anchor = new URL(target);
      anchor.hash = id;
      return { excerpt: text, excerptFrom: "hn-comment", excerptUrl: anchor.href };
    }
  }
  return {};
}

function pageExcerpt(html, target) {
  if (target.hostname === "news.ycombinator.com") return discussionExcerpt(html, target);
  const content = withoutChrome(html);
  const regions = [];
  const oagRelease = target.hostname === "oag.ca.gov" && target.pathname.startsWith("/news/press-releases/");
  if (target.hostname === "nvidianews.nvidia.com") regions.push(["article", classText(content, "article-body")]);
  if (oagRelease) regions.push(["article", classText(content, "field-name-body")]);
  if (target.hostname === "www.ithome.com" || target.hostname === "m.ithome.com") regions.push(["article", classText(content, "post_content")]);
  for (const region of ["article", "main"]) {
    for (const [, section] of content.matchAll(new RegExp(`<${region}\\b[^>]*>([\\s\\S]*?)(?:<\\/${region}\\s*>|$)`, "gi"))) regions.push([region, section]);
  }
  for (const [region, section] of regions) {
    const passages = [];
    let index = 0;
    let pullQuote;
    for (const [, markup, value] of section.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p\s*>/gi)) {
      index++;
      const text = excerpt(value);
      if (!text || passages.some((passage) => passage.text === text)) continue;
      const targetUrl = new URL(target);
      const attrs = attributes(markup);
      const anchor = attrs.id;
      if (anchor && /^[\w-]+$/.test(anchor)) targetUrl.hash = anchor;
      const passage = { text, source: `${region}:paragraph:${index}`, url: targetUrl.href };
      if (oagRelease && index === 1 && attrs.align?.toLowerCase() === "center" && /^\s*<em\b[^>]*>[\s\S]*<\/em>\s*$/i.test(value)) pullQuote = passage;
      if (index === 2 && pullQuote && /^[A-Z][A-Z .'-]{1,36}\s*[—–-]\s+/.test(text)) passages.shift();
      passages.push(passage);
      if (passages.length === 3) break;
    }
    if (passages.length) return { excerpt: passages[0].text, excerptFrom: region, excerptUrl: passages[0].url, passages };
  }
  return {};
}

function declaredAttribution(passages = []) {
  const named = new Map();
  for (const { text, source, url } of passages.slice(0, 2)) {
    for (const [publisher, labels] of reportedBy) {
      if (named.has(publisher)) continue;
      const name = `(?:${labels})`;
      const cue = new RegExp(`(?:据\\s*(?:英国|美国)?\\s*[《“]?\\s*${name}\\s*[》”]?\\s*(?:(?:今天|昨天|昨日|今日|此前)\\s*)?报[道导]|${name}[》”]?\\s*报[道导]称|\\baccording to\\s+(?:a report (?:by|from|in)\\s+)?(?:the\\s+)?${name}(?=[\\s,.;:!?]|$))`, "i");
      const quote = text.match(cue)?.[0];
      if (quote) named.set(publisher, { publisher, quote, source, url });
    }
  }
  return [...named.values()];
}

function responseSignals(response) {
  if (!response) return {};
  const cache = {};
  for (const [field, header] of Object.entries({ xCache: "x-cache", xCacheStatus: "x-cache-status", cfCacheStatus: "cf-cache-status", cacheControl: "cache-control", warning: "warning" })) {
    const value = response.headers.get(header)?.trim();
    if (value) cache[field] = value.slice(0, 220);
  }
  const age = response.headers.get("age")?.trim();
  if (/^\d+$/.test(age || "") && Number.isSafeInteger(Number(age))) cache.ageSeconds = Number(age);
  if ([cache.xCache, cache.xCacheStatus, cache.cfCacheStatus].some((value) => /\bstale\b/i.test(value || "")) || /(?:^|,)\s*110\s/.test(cache.warning || "")) cache.stale = true;
  return { httpStatus: response.status, ...(Object.keys(cache).length ? { cache } : {}) };
}

async function inspect(value, fetcher, clock) {
  let target = publicUrl(value);
  if (!target) return { url: value, status: "manual", checkedAt: clock().toISOString(), message: "可打开原文或粘贴有用摘录。此域名未接入自动核对。" };
  const requestedUrl = target.href;
  const provenance = () => ({ url: target.href, ...(target.href === requestedUrl ? {} : { requestedUrl }), publisher: target.hostname, sourceKind: sourceKind(target.hostname) });
  let response;
  try {
    const signal = AbortSignal.timeout(7000);
    for (let redirects = 0; redirects <= 2; redirects++) {
      response = undefined;
      response = await fetcher(target.href, { redirect: "manual", signal, headers: { Accept: "text/html, application/xhtml+xml" } });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      const redirect = location ? publicUrl(new URL(location, target)) : null;
      if (!redirect || redirects === 2) throw new Error("跳转目标需要手动检查");
      target = redirect;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("原文返回 HTTP " + response.status);
    }
    if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel().catch(() => {});
      throw new Error("原文需要手动打开核对");
    }
    const html = (await sample(response)).replace(/<!--[\s\S]*?-->/g, "");
    const content = html.replace(/<(script|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
    const head = content.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1] || content;
    const fields = metadata(head);
    const article = articleSchema(html);
    const pageTitle = plain(content.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]);
    const title = plain(fields.get("og:title") || article.headline || pageTitle || content.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1]).slice(0, 200);
    const summary = plain(fields.get("og:description") || fields.get("description") || article.description).slice(0, 260);
    if (!title || /^(?:(?:just a moment|access denied|security check|sign in to github|attention required|verify you are human|request blocked|checking your browser)\b|人机验证|访问受限)/i.test(pageTitle || title)) throw new Error("没有取得可核对的原始页面");
    const extracted = pageExcerpt(content, target);
    const attribution = declaredAttribution(extracted.passages);
    const canonical = canonicalUrl(head, target);
    const checkedAt = clock().toISOString();
    return {
      ...provenance(), ...responseSignals(response), ...(canonical ? { canonicalUrl: canonical } : {}), title, summary,
      ...dates(fields, article, content, target.hostname), ...extracted, checkedAt,
      ...(attribution.length ? { declaredAttribution: attribution } : {}),
      status: extracted.excerpt ? "read" : "metadata",
      ...(!extracted.excerpt ? { message: "仅取得标题或摘要，正文需手动核对。" } : {})
    };
  } catch (error) {
    return { ...provenance(), ...responseSignals(response), status: "unavailable", checkedAt: clock().toISOString(), message: error.name === "TimeoutError" ? "原文响应超时" : String(error.message).slice(0, 150) };
  }
}

export async function verifyResearchSources(inputs, options = {}) {
  const { fetcher = globalThis.fetch, clock = () => new Date() } = options;
  const links = new Map();
  for (const source of Array.isArray(inputs) ? inputs : []) {
    const candidates = typeof source === "string" ? [source] : [source?.originalUrl || source?.url, source?.sourceUrl || source?.discussionUrl];
    for (const url of candidates) if (typeof url === "string" && url.trim()) {
      const value = url.trim();
      const normalized = publicUrl(value)?.href || value;
      if (!links.has(normalized)) links.set(normalized, value);
    }
    if (links.size >= 5) break;
  }
  return Promise.all([...links.values()].slice(0, 5).map((url) => inspect(url, fetcher, clock)));
}
