import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const minute = 60_000;
const aihotEndpoint = "https://aihot.news/api/v1/hot-topics";
const hnEndpoint = "https://hacker-news.firebaseio.com/v0";
const sourceDefinitions = [
  { id: "aihot", label: "AIHOT", url: "https://aihot.news/hot", available: true },
  { id: "hn", label: "Hacker News", url: "https://news.ycombinator.com/", available: true },
  { id: "github", label: "GitHub Trending", url: "https://github.com/trending", available: false },
  { id: "huggingface", label: "Hugging Face Daily Papers", url: "https://huggingface.co/papers", available: false },
  { id: "newsnow", label: "NewsNow", url: "https://newsnow.busiyi.world/", available: false }
];

function cleanText(value, limit = 300) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, limit) : "";
}

function webUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function canonicalUrl(value) {
  const url = new URL(value);
  const query = url.search.slice(1).split("&").filter(parameter => {
    const name = parameter.split("=", 1)[0];
    return !/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(name);
  }).join("&");
  return `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

function isoDate(value) {
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function retryAfter(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return isoDate(Date.now() + Number(value) * 1000);
  return isoDate(value);
}

function evidenceLink(kind, label, url) {
  return { kind, label, url };
}

function listedLinkLabel(sourceId, publisher) {
  if (sourceId === "hn") return "Hacker News 所列外链";
  return publisher && publisher !== "原文" ? `AIHOT 所列外链 · ${publisher}` : "AIHOT 所列外链";
}

function responseCacheHeaders(headers) {
  const age = headers.get("age");
  const ageSeconds = /^\d+$/.test(age ?? "") ? count(Number(age)) : null;
  const cacheControl = cleanText(headers.get("cache-control"), 300) || null;
  const xCache = cleanText(headers.get("x-cache"), 120) || null;
  const xCacheStatus = cleanText(headers.get("x-cache-status"), 120) || null;
  const cfCacheStatus = cleanText(headers.get("cf-cache-status"), 120) || null;
  if (ageSeconds === null && !cacheControl && !xCache && !xCacheStatus && !cfCacheStatus) return null;
  const stale = [xCache, xCacheStatus, cfCacheStatus].some(status => /(?:^|[^a-z])stale(?:[^a-z]|$)/i.test(status || ""));
  return { ageSeconds, cacheControl, xCache, xCacheStatus, cfCacheStatus, stale };
}

async function requestJson(fetcher, url, headers = {}) {
  const response = await fetcher(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(9_000),
    redirect: "error"
  });
  const etag = response.headers.get("etag");
  const responseCache = responseCacheHeaders(response.headers);
  if (!response.ok && response.status !== 304) {
    const requestId = cleanText(response.headers.get("x-request-id"), 80);
    const error = new Error(`HTTP ${response.status}${requestId ? `（请求 ${requestId}）` : ""}`);
    error.httpStatus = response.status;
    error.retryAt = retryAfter(response.headers.get("retry-after"));
    error.responseCache = responseCache;
    throw error;
  }
  if (responseCache?.stale) {
    const error = new Error("上游缓存明确标记为过期，保留上次采集时间");
    error.responseCache = responseCache;
    error.retryAt = retryAfter(response.headers.get("retry-after"));
    throw error;
  }
  if (response.status === 304) return { unchanged: true, etag, responseCache };
  return { data: await response.json(), etag, responseCache };
}

async function fetchAihot(fetcher, source, actorId) {
  const headers = { "user-agent": `aihot-api/2.0.0 aihot-actor/${actorId}` };
  if (source.etag) headers["if-none-match"] = source.etag;
  const result = await requestJson(fetcher, aihotEndpoint, headers);
  if (result.unchanged) return result;
  if (!Array.isArray(result.data?.items)) throw new Error("AIHOT 响应缺少热点榜数据");

  const seenIds = new Set();
  const items = result.data.items.slice(0, 10).flatMap((item, index) => {
    const id = cleanText(item?.id, 120);
    const title = cleanText(item?.title);
    const original = webUrl(item?.links?.original);
    const article = webUrl(item?.links?.aihot);
    const story = webUrl(item?.links?.story);
    if (!id || !title || !(original || article || story) || seenIds.has(id)) return [];
    seenIds.add(id);
    const sourceName = cleanText(item.source?.name);
    const evidence = [];
    if (original) evidence.push(evidenceLink("original", listedLinkLabel("aihot", sourceName), original));
    if (story || article) evidence.push(evidenceLink("coverage", "AIHOT 事件与报道", story || article));
    if (Array.isArray(item.sourceNames)) {
      for (const name of item.sourceNames.slice(0, 12).map(value => cleanText(value)).filter(Boolean)) {
        evidence.push(evidenceLink("reported_source", name, null));
      }
    }
    const reportedRank = count(item.rank) || null;
    return [{
      id: `aihot:${id}`, sourceId: "aihot", title, url: original || story || article, originalUrl: original,
      sourceUrl: story || article || original, sourceApiUrl: aihotEndpoint,
      publishedAt: isoDate(item.publishedAt), updatedAt: isoDate(item.latestAt),
      rank: reportedRank || index + 1, rankKind: reportedRank ? "reported_rank" : "feed_order",
      score: null, comments: null, sourceCount: count(item.sourceCount), signalCount: count(item.signalCount),
      summary: cleanText(item.summary, 1000), evidence
    }];
  });
  if (result.data.items.length && !items.length) throw new Error("AIHOT 热点榜含条目，但无法识别榜单字段");
  return { items, etag: result.etag, responseCache: result.responseCache };
}

async function requestHnJson(fetcher, url) {
  try {
    return await requestJson(fetcher, url);
  } catch (error) {
    const transient = error.name === "TimeoutError" || ["ETIMEDOUT", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"].includes(error.cause?.code)
      || [502, 503, 504].includes(error.httpStatus);
    if (!transient || error.retryAt) throw error;
    return requestJson(fetcher, url);
  }
}

async function fetchHn(fetcher) {
  const result = await requestHnJson(fetcher, `${hnEndpoint}/topstories.json`);
  if (!Array.isArray(result.data) || result.data.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error("Hacker News 响应缺少有效榜单编号");
  }
  const ids = result.data.slice(0, 20);
  const items = [];
  const itemErrors = [];
  for (let offset = 0; offset < ids.length; offset += 5) {
    const batch = ids.slice(offset, offset + 5);
    const entries = await Promise.allSettled(batch.map(async (hnId, index) => {
      const rank = offset + index + 1;
      if (ids.indexOf(hnId) !== rank - 1) return null;
      const sourceApiUrl = `${hnEndpoint}/item/${hnId}.json`;
      const { data: item } = await requestHnJson(fetcher, sourceApiUrl);
      const title = cleanText(item?.title);
      if (item?.deleted || item?.dead || (item?.id === hnId && item?.type && item.type !== "story")) return null;
      if (!title || item?.id !== hnId || item.type !== "story") throw new Error("新闻条目缺少有效字段或编号不匹配");
      const original = webUrl(item.url);
      const discussion = `https://news.ycombinator.com/item?id=${hnId}`;
      const evidence = [evidenceLink("discussion", "Hacker News 讨论", discussion)];
      if (original) evidence.unshift(evidenceLink("original", listedLinkLabel("hn"), original));
      return {
        id: `hn:${hnId}`, sourceId: "hn", title, url: original || discussion, originalUrl: original,
        sourceUrl: discussion, sourceApiUrl, publishedAt: null, submittedAt: count(item.time) ? isoDate(item.time * 1000) : null,
        updatedAt: null, rank, rankKind: "feed_order", score: count(item.score), comments: count(item.descendants),
        summary: "", evidence
      };
    }));
    for (const [index, entry] of entries.entries()) {
      if (entry.status === "fulfilled") {
        if (entry.value) items.push(entry.value);
      } else {
        itemErrors.push({
          id: `hn:${batch[index]}`, rank: offset + index + 1,
          message: cleanText(entry.reason?.message, 200) || "条目读取失败",
          httpStatus: entry.reason?.httpStatus ?? null, retryAt: entry.reason?.retryAt ?? null
        });
      }
    }
  }
  const retryAt = itemErrors.reduce((latest, entry) => Date.parse(entry.retryAt) > (Date.parse(latest) || 0) ? entry.retryAt : latest, null);
  if (ids.length && !items.length) {
    throw Object.assign(new Error("Hacker News 热榜含编号，但无法核对任何新闻条目"), { itemErrors, retryAt });
  }
  return { items, itemErrors, retryAt, etag: null, responseCache: result.responseCache };
}

function getGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.originalUrl ? canonicalUrl(item.originalUrl) : item.id;
    if (!groups.has(key)) {
      const id = createHash("sha256").update(key).digest("hex").slice(0, 16);
      groups.set(key, { id, title: item.title, url: item.url, items: [], evidence: [] });
    }
    groups.get(key).items.push(item);
  }
  for (const group of groups.values()) {
    const evidence = new Map();
    for (const item of group.items) {
      for (const entry of item.evidence) {
        const key = `${entry.kind}:${entry.url ? canonicalUrl(entry.url) : entry.label}`;
        if (!evidence.has(key)) evidence.set(key, entry);
      }
    }
    group.evidence = [...evidence.values()];
  }
  const bestRank = group => Math.min(...group.items.map(item => item.rank));
  return [...groups.values()].sort((left, right) => bestRank(left) - bestRank(right));
}

function defaultSource(definition) {
  return {
    enabled: definition.available, lastAttemptAt: null, lastSuccessAt: null, snapshotAt: null, cooldownUntil: null,
    lastError: null, lastWarning: null, lastPartialAt: null, itemErrors: [], consecutiveFailures: 0,
    etag: null, responseCache: null, items: [], history: []
  };
}

function capturedAt(source) {
  return source.snapshotAt || source.history.find(entry => entry.status === "ok")?.at || null;
}

function verifiedAt(entry) {
  return Date.parse(entry.lastPartialAt) > (Date.parse(entry.lastSuccessAt) || 0) ? entry.lastPartialAt : entry.lastSuccessAt;
}

function readItem(item, entry, snapshotAt, stale) {
  const hn = item.sourceId === "hn";
  const sourceApiUrl = item.sourceApiUrl || (hn ? `${hnEndpoint}/item/${item.id.slice(3)}.json` : aihotEndpoint);
  const evidence = item.sourceApiUrl ? item.evidence : item.evidence.map(link => {
    if (link.kind !== "original") return link;
    return { ...link, label: listedLinkLabel(item.sourceId, link.label) };
  });
  return {
    ...item, sourceApiUrl, evidence, rankKind: item.rankKind || (hn ? "feed_order" : null),
    publishedAt: hn ? null : item.publishedAt, submittedAt: hn ? item.submittedAt ?? item.publishedAt : null,
    collectedAt: item.collectedAt || snapshotAt, verifiedAt: verifiedAt(entry), stale, cached: stale || Boolean(entry.lastError)
  };
}

function apiError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function createTrendMonitor({ dataDir, fetcher = globalThis.fetch, intervalMs = 30 * minute, onError = () => {} }) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("热点监测间隔必须为正数");
  const file = path.join(dataDir, "trend-monitor.json");
  const cooldownMs = Math.min(intervalMs, minute);
  const staleAfterMs = intervalMs * 2;
  const pending = new Map();
  let snapshot;
  let loading;
  let timer;
  let running = false;
  let scheduleRevision = 0;
  let writes = Promise.resolve();

  async function load() {
    if (snapshot) return snapshot;
    if (!loading) {
      loading = (async () => {
        let saved;
        try {
          saved = JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (saved && (saved.version !== 1 || !saved.sources)) throw new Error("无法识别热点监测快照版本");
        snapshot = {
          version: 1, actorId: saved?.actorId || randomUUID(),
          sources: Object.fromEntries(sourceDefinitions.map(definition => [
            definition.id, { ...defaultSource(definition), ...saved?.sources?.[definition.id] }
          ]))
        };
        return snapshot;
      })().finally(() => { loading = undefined; });
    }
    return loading;
  }

  function update(id, apply) {
    const operation = writes.then(async () => {
      const current = await load();
      const source = apply(current.sources[id]);
      if (source === current.sources[id]) return;
      const next = { ...current, sources: { ...current.sources, [id]: source } };
      await mkdir(dataDir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      snapshot = next;
    });
    writes = operation.catch(() => {});
    return operation;
  }

  function dueAt(source, manual) {
    const lastAttempt = Date.parse(source.lastAttemptAt) || 0;
    const lastSuccess = Date.parse(source.lastSuccessAt) || 0;
    const base = lastAttempt + (manual ? cooldownMs : intervalMs);
    // Failed runs use the retry cutoff. Successful runs count from the last completed fetch.
    const scheduled = source.lastError ? 0 : lastSuccess + intervalMs;
    return Math.max(base, Date.parse(source.cooldownUntil) || 0, manual ? 0 : scheduled);
  }

  async function read() {
    const current = await load();
    const now = Date.now();
    const items = [];
    const sources = sourceDefinitions.map(definition => {
      const entry = current.sources[definition.id];
      const snapshotAt = capturedAt(entry);
      const verification = verifiedAt(entry);
      const verificationAgeMs = verification ? Math.max(0, now - Date.parse(verification)) : null;
      const stale = verificationAgeMs !== null && verificationAgeMs > staleAfterMs;
      let status = "waiting";
      if (!definition.available) status = "candidate";
      else if (!entry.enabled) status = "disabled";
      else if (stale) status = "stale";
      else if (entry.lastError) status = "failed";
      else if (entry.lastWarning) status = "partial";
      else if (entry.lastSuccessAt) status = "ok";
      if (definition.available && entry.enabled) {
        items.push(...entry.items.map(item => readItem(item, entry, snapshotAt, stale)));
      }
      const next = dueAt(entry, false);
      return {
        ...definition, enabled: definition.available && entry.enabled, status, stale, refreshing: pending.has(definition.id),
        lastAttemptAt: entry.lastAttemptAt, lastSuccessAt: entry.lastSuccessAt, lastError: entry.lastError,
        lastPartialAt: entry.lastPartialAt, lastWarning: entry.lastWarning, itemErrors: entry.itemErrors,
        snapshotAt, verificationAgeMs, responseCache: entry.responseCache,
        cooldownUntil: entry.lastAttemptAt ? isoDate(dueAt(entry, true)) : null,
        nextRefreshAt: definition.available && entry.enabled ? isoDate(Math.max(now, next)) : null,
        itemCount: entry.items.length, history: entry.history
      };
    });
    return structuredClone({ intervalMs, staleAfterMs, sources, items, groups: getGroups(items) });
  }

  async function runSource(id, manual) {
    const current = await load();
    const definition = sourceDefinitions.find(entry => entry.id === id);
    const source = current.sources[id];
    if (!definition.available) return { sourceId: id, status: "candidate" };
    if (!source.enabled) return { sourceId: id, status: "disabled" };
    if (pending.has(id)) return pending.get(id);
    if (Date.now() < dueAt(source, manual)) return { sourceId: id, status: manual ? "cooldown" : "waiting" };

    const operation = (async () => {
      const lastAttemptAt = new Date().toISOString();
      await update(id, latest => ({ ...latest, lastAttemptAt }));
      let result;
      let failure;
      try {
        result = await (id === "aihot" ? fetchAihot(fetcher, source, current.actorId) : fetchHn(fetcher));
        if (result.unchanged && !source.lastSuccessAt) throw new Error("收到 304，但本地没有可用快照");
      } catch (error) {
        failure = error;
      }
      const at = new Date().toISOString();
      const partial = !failure && Boolean(result.itemErrors?.length);
      const status = failure ? "failed" : partial ? "partial" : result.unchanged ? "unchanged" : "ok";
      await update(id, latest => {
        const failures = failure ? latest.consecutiveFailures + 1 : 0;
        const cutoff = failure ? Date.parse(at) + Math.min(6 * 60 * minute, intervalMs * 2 ** Math.min(8, failures - 1)) : 0;
        const lastError = failure ? cleanText(failure.message, 200) || "请求失败" : null;
        const itemErrors = failure?.itemErrors || result?.itemErrors || [];
        const lastWarning = partial ? `已更新 ${result.items.length} 条，另有 ${itemErrors.length} 条读取失败；榜单排名保留原位。` : null;
        const unchanged = !!result?.unchanged;
        const previous = new Map(latest.items.map(item => [item.id, item]));
        const previousSnapshotAt = capturedAt(latest);
        const nextItems = failure || unchanged ? latest.items : result.items.map(item => {
          const prior = previous.get(item.id);
          const previousRankKind = prior?.rankKind ?? (id === "hn" ? "feed_order" : null);
          const previousRank = prior?.rank ?? null;
          const comparableRank = previousRank !== null && previousRankKind === item.rankKind;
          return {
            ...item, collectedAt: at, previousCollectedAt: prior ? prior.collectedAt || previousSnapshotAt : null,
            previousRank, rankDelta: comparableRank ? previousRank - item.rank : null,
            scoreDelta: Number.isFinite(prior?.score) && Number.isFinite(item.score) ? item.score - prior.score : null,
            commentsDelta: Number.isFinite(prior?.comments) && Number.isFinite(item.comments) ? item.comments - prior.comments : null
          };
        });
        const history = { at, status, itemCount: nextItems.length, error: lastError, warning: lastWarning, itemErrors };
        if (!failure && !unchanged) {
          history.ranks = nextItems.map(({ id: itemId, title, url, rank, score, comments }) => ({ id: itemId, title, url, rank, score, comments }));
        }
        return {
          ...latest, items: nextItems, lastSuccessAt: failure || partial ? latest.lastSuccessAt : at,
          lastPartialAt: partial ? at : latest.lastPartialAt, lastWarning, itemErrors,
          snapshotAt: failure || unchanged ? previousSnapshotAt : at,
          cooldownUntil: cutoff ? isoDate(Math.max(cutoff, Date.parse(failure.retryAt) || 0)) : result?.retryAt || null,
          lastError, consecutiveFailures: failures, etag: failure || unchanged ? latest.etag : result.etag,
          responseCache: (failure || result)?.responseCache ?? null,
          history: [history, ...latest.history].slice(0, 48)
        };
      });
      return { sourceId: id, status };
    })();
    pending.set(id, operation);
    try {
      return await operation;
    } finally {
      pending.delete(id);
    }
  }

  async function run(source, manual) {
    const ids = source ? [source] : sourceDefinitions.filter(entry => entry.available).map(entry => entry.id);
    return Promise.all(ids.map(id => runSource(id, manual)));
  }

  async function armTimer() {
    const revision = ++scheduleRevision;
    clearTimeout(timer);
    if (!running) return;
    try {
      const current = await load();
      if (!running || revision !== scheduleRevision) return;
      const next = sourceDefinitions.filter(({ id, available }) => available && current.sources[id].enabled && !pending.has(id))
        .map(({ id }) => dueAt(current.sources[id], false));
      if (!next.length) return;
      const delay = Math.max(1, Math.min(...next) - Date.now());
      timer = setTimeout(async () => {
        try {
          await run(null, false);
        } catch (error) {
          onError(error);
          // Persistence can fail before recording an attempt. Wait one interval before retrying.
          if (running && revision === scheduleRevision) {
            timer = setTimeout(() => { void armTimer(); }, intervalMs);
            timer.unref();
          }
          return;
        }
        if (running && revision === scheduleRevision) void armTimer();
      }, delay);
      timer.unref();
    } catch (error) {
      onError(error);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      void armTimer();
    },
    stop() {
      running = false;
      ++scheduleRevision;
      clearTimeout(timer);
    },
    read,
    async refresh(source) {
      if (source != null && !sourceDefinitions.some(entry => entry.id === source)) throw apiError(404, "找不到该热点来源");
      const outcomes = await run(source, true);
      void armTimer();
      const current = await read();
      return { ...current, outcomes: outcomes.map(outcome => {
        const entry = current.sources.find(item => item.id === outcome.sourceId);
        const retryAt = ["failed", "partial", "cooldown"].includes(outcome.status) ? entry.cooldownUntil : null;
        return {
          ...outcome, lastSuccessAt: entry.lastSuccessAt, snapshotAt: entry.snapshotAt,
          retryAt, error: outcome.status === "failed" ? entry.lastError : null, itemCount: entry.itemCount,
          warning: entry.lastWarning, itemErrors: entry.itemErrors, lastPartialAt: entry.lastPartialAt,
          responseCache: entry.responseCache
        };
      }) };
    },
    async setEnabled(id, enabled) {
      const definition = sourceDefinitions.find(entry => entry.id === id);
      if (!definition) throw apiError(404, "找不到该热点来源");
      if (typeof enabled !== "boolean") throw apiError(400, "请指定是否启用该来源");
      if (!definition.available && enabled) throw apiError(409, "该候选来源尚未接入自动监测");
      await update(id, latest => latest.enabled === enabled ? latest : { ...latest, enabled });
      void armTimer();
      return read();
    }
  };
}
