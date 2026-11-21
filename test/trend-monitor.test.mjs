import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTrendMonitor } from "../lib/trend-monitor.js";

const minute = 60_000;
const fixtureDate = "2026-11-17T03:00:00Z";

function json(value, init) {
  return Response.json(value, init);
}

function aihotItem(id, rank, original = "https://example.com/model?utm_source=aihot&id=42") {
  return {
    id, rank, title: `AIHOT ${id}`, source: { name: "Developer Blog" },
    links: { original, aihot: `https://aihot.news/items/${id}`, story: `https://aihot.news/story/${id}` },
    sourceCount: 4, signalCount: 9, latestAt: fixtureDate, sourceNames: ["Industry outlet"]
  };
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ip-trends-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("normalizes public feeds with native rank, separates coverage from original evidence, and persists history", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(fixtureDate) });
  const dataDir = await tempDir(t);
  const seen = [];
  let aihotRank = 3;
  let revision = 1;
  const fetcher = async (raw, { headers }) => {
    const url = new URL(raw);
    seen.push({ url, headers });
    if (url.hostname === "aihot.news") return json({ items: [aihotItem("alpha", aihotRank)] }, { headers: { etag: `W/"rev${revision}"` } });
    if (url.pathname.endsWith("topstories.json")) return json([42, 43, 44]);
    const id = Number(url.pathname.match(/(\d+)\.json$/)[1]);
    if (id === 43) return json({ id, type: "job", title: "Job listing" });
    return json({
      id, type: "story", title: `HN ${id}`, score: 81, descendants: 13,
      url: id === 42 ? "https://example.com/model?id=42&utm_source=hn" : null,
      time: Date.parse(fixtureDate) / 1000
    });
  };
  const monitor = createTrendMonitor({ dataDir, fetcher });
  const initial = await monitor.read();
  assert.equal(initial.intervalMs, 30 * minute);
  assert.deepEqual(initial.sources.map(source => source.status), ["waiting", "waiting", "candidate", "candidate", "candidate"]);
  assert.equal(seen.length, 0);

  const first = await monitor.refresh();
  assert.deepEqual(first.outcomes.map(({ sourceId, status }) => ({ sourceId, status })), [{ sourceId: "aihot", status: "ok" }, { sourceId: "hn", status: "ok" }]);
  assert.equal(first.outcomes[0].snapshotAt, "2026-11-17T03:00:00.000Z");
  assert.equal(first.outcomes[0].itemCount, 1);
  assert.equal(first.items.length, 3);
  assert.equal(first.items[0].updatedAt, "2026-11-17T03:00:00.000Z");
  assert.equal(first.items[0].publishedAt, null);
  assert.equal(first.items[0].rankKind, "reported_rank");
  assert.equal(first.items.find(item => item.id === "hn:44").rank, 3);
  const hnItem = first.items.find(item => item.id === "hn:42");
  assert.equal(hnItem.comments, 13);
  assert.equal(hnItem.publishedAt, null);
  assert.equal(hnItem.submittedAt, "2026-11-17T03:00:00.000Z");
  assert.equal(hnItem.collectedAt, first.sources[1].snapshotAt);
  assert.equal(hnItem.sourceApiUrl, "https://hacker-news.firebaseio.com/v0/item/42.json");
  assert.equal(first.groups.length, 2);
  assert.deepEqual(first.groups[0].items.map(item => item.id), ["aihot:alpha", "hn:42"]);
  assert.ok(first.groups[0].evidence.some(entry => entry.kind === "reported_source" && entry.url === null));
  assert.ok(first.groups[0].evidence.some(entry => entry.kind === "discussion" && entry.url.endsWith("?id=42")));
  assert.equal(first.groups[0].evidence.filter(entry => entry.kind === "original").length, 1);

  const cooldown = await monitor.refresh("aihot");
  assert.equal(cooldown.outcomes[0].status, "cooldown");
  assert.equal(cooldown.outcomes[0].retryAt, "2026-11-17T03:01:00.000Z");
  assert.equal(seen.filter(entry => entry.url.hostname === "aihot.news").length, 1);
  t.mock.timers.tick(minute);
  aihotRank = 1;
  revision += 1;
  const second = await monitor.refresh("aihot");
  assert.equal(second.items[0].previousRank, 3);
  assert.equal(second.items[0].rankDelta, 2);
  assert.equal(second.items[0].previousCollectedAt, "2026-11-17T03:00:00.000Z");
  const headers = seen.filter(entry => entry.url.hostname === "aihot.news").map(entry => entry.headers);
  assert.equal(headers[1]["if-none-match"], 'W/"rev1"');
  assert.equal(headers[0]["user-agent"], headers[1]["user-agent"]);

  assert.equal((await monitor.setEnabled("hn", false)).items.length, 1);
  await assert.rejects(monitor.setEnabled("github", true), { status: 409 });
  const reloaded = createTrendMonitor({ dataDir, fetcher });
  const restored = await reloaded.read();
  assert.equal(restored.sources[1].status, "disabled");
  assert.equal(restored.sources[0].history.length, 2);
  assert.equal(restored.sources[0].history[1].ranks[0].rank, 3);
  assert.equal(restored.items[0].rankDelta, 2);
  const persisted = JSON.parse(await readFile(path.join(dataDir, "trend-monitor.json"), "utf8"));
  assert.equal(persisted.sources.hn.items.length, 2);
});

test("uses prior cache on failures, observes Retry-After, and revalidates stale data with 304", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(fixtureDate) });
  const dataDir = await tempDir(t);
  let attempt = 0;
  const monitor = createTrendMonitor({
    dataDir,
    fetcher: async () => {
      attempt += 1;
      if (attempt === 1) return json({ items: [aihotItem("first", 1)] }, { headers: { etag: 'W/"first"' } });
      if (attempt === 2) return json({}, { status: 429, headers: { "retry-after": "7200", "x-request-id": "blocked-1" } });
      return new Response(null, { status: 304 });
    }
  });
  const first = await monitor.refresh("aihot");
  t.mock.timers.tick(minute);
  const failed = await monitor.refresh("aihot");
  assert.equal(failed.sources[0].status, "failed");
  assert.equal(failed.sources[0].lastSuccessAt, first.sources[0].lastSuccessAt);
  assert.equal(failed.sources[0].lastError, "HTTP 429（请求 blocked-1）");
  assert.equal(failed.outcomes[0].error, failed.sources[0].lastError);
  assert.equal(failed.outcomes[0].retryAt, "2026-11-17T05:01:00.000Z");
  assert.equal(failed.items.length, 1);
  assert.equal(failed.items[0].stale, false);
  assert.equal(failed.items[0].cached, true);
  t.mock.timers.tick(61 * minute);
  const stale = await monitor.refresh("aihot");
  assert.equal(stale.outcomes[0].status, "cooldown");
  assert.equal(stale.sources[0].status, "stale");
  assert.equal(stale.items[0].stale, true);
  assert.equal(attempt, 2);
  t.mock.timers.tick(59 * minute);
  const unchanged = await monitor.refresh("aihot");
  assert.equal(unchanged.outcomes[0].status, "unchanged");
  assert.equal(unchanged.sources[0].status, "ok");
  assert.equal(unchanged.sources[0].lastError, null);
  assert.equal(unchanged.items[0].stale, false);
  assert.equal(unchanged.items[0].cached, false);
  assert.equal(unchanged.items[0].collectedAt, first.items[0].collectedAt);
  assert.equal(unchanged.items[0].verifiedAt, "2026-11-17T05:01:00.000Z");
  assert.deepEqual(unchanged.sources[0].history.map(entry => entry.status), ["unchanged", "failed", "ok"]);
});

test("reports observed HTTP cache headers and does not refresh from an explicitly stale representation", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(fixtureDate) });
  const dataDir = await tempDir(t);
  const validators = [];
  const monitor = createTrendMonitor({ dataDir, fetcher: async (url, { headers }) => {
    validators.push(headers["if-none-match"]);
    if (validators.length === 1) return json({ items: [aihotItem("trusted", 1)] }, { headers: {
      etag: 'W/"trusted"', age: "42", "cache-control": "max-age=60, stale-if-error=30", "x-cache-status": "HIT"
    } });
    if (validators.length === 2) return json({ items: [aihotItem("outdated", 2)] }, { headers: {
      etag: 'W/"outdated"', age: "125", "x-cache": "HIT, STALE", "cf-cache-status": "STALE"
    } });
    return new Response(null, { status: 304, headers: { age: "0", "x-cache-status": "REVALIDATED" } });
  } });
  const first = await monitor.refresh("aihot");
  assert.equal(first.outcomes[0].responseCache.ageSeconds, 42);
  assert.equal(first.outcomes[0].responseCache.stale, false);
  t.mock.timers.tick(minute);
  const stale = await monitor.refresh("aihot");
  assert.equal(stale.outcomes[0].status, "failed");
  assert.equal(stale.outcomes[0].responseCache.stale, true);
  assert.equal(stale.sources[0].responseCache.ageSeconds, 125);
  assert.equal(stale.items[0].id, "aihot:trusted");
  assert.equal(stale.items[0].verifiedAt, first.items[0].verifiedAt);
  assert.equal(stale.items[0].collectedAt, first.items[0].collectedAt);
  t.mock.timers.tick(30 * minute);
  const revalidated = await monitor.refresh("aihot");
  assert.deepEqual(validators, [undefined, 'W/"trusted"', 'W/"trusted"']);
  assert.equal(revalidated.outcomes[0].status, "unchanged");
  assert.equal(revalidated.sources[0].responseCache.ageSeconds, 0);
  assert.equal(revalidated.items[0].collectedAt, first.items[0].collectedAt);
  assert.notEqual(revalidated.items[0].verifiedAt, first.items[0].verifiedAt);
});

test("preserves native HN rank, recovers a transient transport error, and compares only observed metrics", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(fixtureDate) });
  const dataDir = await tempDir(t);
  let phase = 1;
  let retries = 0;
  const monitor = createTrendMonitor({ dataDir, fetcher: async raw => {
    const url = new URL(raw);
    if (url.pathname.endsWith("topstories.json")) return json(phase === 1 ? [42, 42, 43] : [43, 42]);
    const id = Number(url.pathname.match(/(\d+)\.json$/)[1]);
    if (phase === 1 && id === 43 && retries++ === 0) throw new DOMException("Read timed out", "TimeoutError");
    if (phase === 3 && id === 43) return json({}, { status: 503, headers: { "retry-after": "900" } });
    return json({ id, type: "story", title: `HN ${id}`, score: 10 * phase, descendants: id === 42 ? 3 * phase : -1 });
  } });
  const first = await monitor.refresh("hn");
  assert.equal(retries, 2);
  assert.deepEqual(first.items.map(({ id, rank }) => [id, rank]), [["hn:42", 1], ["hn:43", 3]]);
  assert.equal(first.items[1].comments, null);
  t.mock.timers.tick(minute);
  phase = 2;
  const second = await monitor.refresh("hn");
  assert.equal(second.items[1].previousRank, 1);
  assert.equal(second.items[1].rankDelta, -1);
  assert.equal(second.items[1].scoreDelta, 10);
  assert.equal(second.items[1].commentsDelta, 3);
  assert.equal(second.items[0].commentsDelta, null);
  t.mock.timers.tick(minute);
  phase = 3;
  const partial = await monitor.refresh("hn");
  assert.equal(partial.outcomes[0].status, "partial");
  assert.deepEqual(partial.items.map(item => [item.id, item.rank, item.score]), [["hn:42", 2, 30]]);
  assert.equal(partial.items[0].cached, false);
  assert.notEqual(partial.items[0].collectedAt, second.items[0].collectedAt);
  assert.equal(partial.sources[1].lastSuccessAt, second.sources[1].lastSuccessAt);
  assert.equal(partial.sources[1].lastPartialAt, partial.items[0].collectedAt);
  assert.equal(partial.outcomes[0].retryAt, "2026-11-17T03:17:00.000Z");
  assert.deepEqual(partial.outcomes[0].itemErrors.map(({ id, rank, httpStatus }) => ({ id, rank, httpStatus })), [{ id: "hn:43", rank: 1, httpStatus: 503 }]);
});

test("HN partial refresh continues later batches, survives restart and clears warnings after a full recovery", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(fixtureDate) });
  const dataDir = await tempDir(t);
  let phase = "partial";
  const requests = [];
  const fetcher = async raw => {
    if (raw.endsWith("topstories.json")) return json([1, 2, 3, 4, 5, 6, 7, 8]);
    const id = Number(raw.match(/item\/(\d+)/)[1]);
    requests.push(id);
    if (phase === "partial" && id === 2) return json({}, { status: 429, headers: { "retry-after": "120" } });
    if (phase === "partial" && id === 6) return json({ id: 999, title: "Wrong story", type: "story" });
    if (phase === "failed") return json({}, { status: 503, headers: { "retry-after": "60" } });
    return json({ id, type: id === 4 ? "job" : "story", title: `Story ${id}`, score: phase === "partial" ? 10 : 20 });
  };
  const monitor = createTrendMonitor({ dataDir, fetcher });
  const first = await monitor.refresh("hn");
  const source = first.sources[1];
  assert.equal(source.status, "partial");
  assert.equal(source.lastSuccessAt, null);
  assert.equal(source.lastError, null);
  assert.match(source.lastWarning, /更新 5 条.*2 条读取失败/);
  assert.deepEqual(first.items.map(({ rank }) => rank), [1, 3, 5, 7, 8]);
  assert.deepEqual(source.itemErrors.map(({ id, rank }) => [id, rank]), [["hn:2", 2], ["hn:6", 6]]);
  assert.ok(first.items.every(item => !item.cached && !item.stale && item.verifiedAt === source.lastPartialAt));
  assert.ok(requests.includes(8));
  assert.equal(first.outcomes[0].retryAt, "2026-11-17T03:02:00.000Z");

  const restarted = createTrendMonitor({ dataDir, fetcher });
  assert.equal((await restarted.read()).sources[1].status, "partial");
  t.mock.timers.tick(minute);
  assert.equal((await restarted.refresh("hn")).outcomes[0].status, "cooldown");
  phase = "failed";
  t.mock.timers.tick(minute);
  const failed = await restarted.refresh("hn");
  assert.equal(failed.sources[1].status, "failed");
  assert.equal(failed.sources[1].lastSuccessAt, null);
  assert.equal(failed.sources[1].itemErrors.length, 8);
  assert.deepEqual(failed.items.map(({ rank }) => rank), [1, 3, 5, 7, 8]);
  assert.ok(failed.items.every(item => item.cached && item.collectedAt === source.snapshotAt));

  phase = "complete";
  t.mock.timers.tick(30 * minute);
  const recovered = await restarted.refresh("hn");
  assert.equal(recovered.sources[1].status, "ok");
  assert.equal(recovered.sources[1].lastWarning, null);
  assert.deepEqual(recovered.sources[1].itemErrors, []);
  assert.equal(recovered.items.length, 7);
  assert.ok(recovered.items.every(item => !item.cached && item.verifiedAt === recovered.sources[1].lastSuccessAt));
  assert.deepEqual(recovered.sources[1].history.map(({ status }) => status), ["ok", "failed", "partial"]);
});

test("only groups links with matching content addresses and rejects incomparable rank changes", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(fixtureDate) });
  const dataDir = await tempDir(t);
  let rank = null;
  const monitor = createTrendMonitor({ dataDir, fetcher: async () => json({ items: [
    aihotItem("first", rank, "https://example.org/#/releases/a"),
    aihotItem("second", 2, "https://example.org/#/releases/b"),
    aihotItem("third", 3, "https://example.org/?id=42#article"),
    aihotItem("fourth", 4, "https://example.org/?id=42&utm_medium=social#article"),
    aihotItem("fifth", 5, "https://example.org/?id=43#article"),
    aihotItem("fifth", 6, "https://example.org/?id=44#article"),
    aihotItem("sixth", 7, "https://www.example.org/?id=42#article")
  ] }) });
  const first = await monitor.refresh("aihot");
  assert.equal(first.items[0].rankKind, "feed_order");
  assert.deepEqual(first.groups.map(group => group.items.length), [1, 1, 2, 1, 1]);
  t.mock.timers.tick(minute);
  rank = 9;
  const second = await monitor.refresh("aihot");
  assert.equal(second.items[0].rankKind, "reported_rank");
  assert.equal(second.items[0].rankDelta, null);
});

test("reads prior persisted HN timestamps correctly without a migration write", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(fixtureDate) });
  const dataDir = await tempDir(t);
  const priorFile = path.join(dataDir, "trend-monitor.json");
  const original = JSON.stringify({ version: 1, actorId: "example", sources: { hn: {
    lastSuccessAt: fixtureDate, items: [{ id: "hn:42", sourceId: "hn", rank: 1, publishedAt: "2026-11-16T17:00:00.000Z",
      evidence: [{ kind: "original", label: "原文", url: "https://example.com/story" }] }],
    history: [{ at: fixtureDate, status: "unchanged" }, { at: "2026-11-17T02:30:00.000Z", status: "ok" }]
  } } });
  await writeFile(priorFile, original);
  const monitor = createTrendMonitor({ dataDir });
  const read = await monitor.read();
  assert.equal(read.items[0].publishedAt, null);
  assert.equal(read.items[0].submittedAt, "2026-11-16T17:00:00.000Z");
  assert.equal(read.items[0].collectedAt, "2026-11-17T02:30:00.000Z");
  assert.equal(read.items[0].verifiedAt, fixtureDate);
  assert.equal(read.items[0].evidence[0].label, "Hacker News 所列外链");
  assert.equal(await readFile(priorFile, "utf8"), original);
});

test("joins an in-flight refresh while keeping a concurrent source-disable decision", async t => {
  const dataDir = await tempDir(t);
  const { promise: started, resolve: announce } = Promise.withResolvers();
  const { promise: finish, resolve: release } = Promise.withResolvers();
  let calls = 0;
  const monitor = createTrendMonitor({
    dataDir, fetcher: async () => { calls += 1; announce(); await finish; return json({ items: [aihotItem("test", 1)] }); }
  });
  const first = monitor.refresh("aihot");
  await started;
  const second = monitor.refresh("aihot");
  const disabled = await monitor.setEnabled("aihot", false);
  assert.equal(disabled.sources[0].refreshing, true);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.outcomes[0].status, "ok");
    assert.equal(result.sources[0].status, "disabled");
    assert.equal(result.sources[0].itemCount, 1);
    assert.equal(result.items.length, 0);
  }
});

test("scheduler refreshes on startup and stops starting requests after stop", async t => {
  const dataDir = await tempDir(t);
  const { promise: ran, resolve: announce } = Promise.withResolvers();
  let attempts = 0;
  const monitor = createTrendMonitor({
    dataDir, intervalMs: 25, fetcher: async () => { attempts += 1; if (attempts === 2) announce(); return json({ items: [] }); }
  });
  t.after(() => monitor.stop());
  await monitor.setEnabled("hn", false);
  monitor.start();
  await Promise.race([ran, delay(500).then(() => assert.fail("scheduler did not refresh twice"))]);
  monitor.stop();
  await delay(75);
  assert.equal(attempts, 2);
  assert.equal((await monitor.read()).sources[0].history.length, 2);
});
