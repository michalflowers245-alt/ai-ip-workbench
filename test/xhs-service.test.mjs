import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { XhsStore } from "../lib/xhs-store.js";
import { XhsResearchService, XhsStageError } from "../lib/xhs-research.js";

async function setup(t, browser, cleaner = null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xhs-service-test-"));
  const store = new XhsStore(path.join(dir, "research.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, service: new XhsResearchService({ store, browser: { capability: () => ({ ocr: {}, asr: {} }), ...browser }, cleaner }) };
}

function post(url, status = "success") {
  return {
    postUrl: url, postKey: url.split("/").pop(), title: "可用标题", author: "作者", body: "真实页面正文",
    mergedCopy: "真实页面正文", tags: ["主题"], likes: 20, favorites: 3, comments: 2,
    extractionStatus: status, completeness: status === "success" ? 90 : 45, fieldSources: { body: "DOM" },
    ocrStatus: "not_needed", asrStatus: "not_needed", cleaningStatus: "not_configured"
  };
}

test("service de-duplicates links, extracts sequentially and cleans via local model adapter", async (t) => {
  const calls = [];
  const url = "https://www.xiaohongshu.com/explore/one";
  const { store, service } = await setup(t, {
    collectLinks: async (_keyword, _target, progress) => { progress({ count: 2 }); return [{ url }, { url }]; },
    extractPost: async (_task, value) => { calls.push(value); return post(value); }
  }, async () => ({ status: "completed", text: "清洗后的真实正文", message: "已清洗" }));
  const task = store.createTask("大学 AI", 5);
  const done = await service.run(task.id);
  assert.equal(done.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(store.getTaskResults(task.id)[0].merged_copy, "清洗后的真实正文");
});

test("service preserves partial successes and detailed per-post failures", async (t) => {
  const urls = ["https://www.xiaohongshu.com/explore/ok", "https://www.xiaohongshu.com/explore/bad"];
  const { store, service } = await setup(t, {
    collectLinks: async () => urls.map((url) => ({ url })),
    extractPost: async (_task, url) => {
      if (url.endsWith("bad")) throw new XhsStageError("content_extract", "页面结构变化", { visibleTextLength: 12, domLocatorCount: 0 });
      return post(url);
    }
  });
  const task = store.createTask("真实内容", 2);
  const done = await service.run(task.id);
  assert.equal(done.status, "partial");
  assert.equal(done.success_count, 1);
  assert.equal(done.failed_count, 1);
  assert.equal(store.getErrors(task.id)[0].failure_stage, "content_extract");
  assert.equal(store.getTaskResults(task.id).length, 2);
});

test("login and verification gates become actionable task states", async (t) => {
  const { store, service } = await setup(t, {
    collectLinks: async () => { throw new XhsStageError("login_check", "请扫码登录", { loginDetected: true }); },
    extractPost: async () => { throw new Error("should not run"); }
  });
  const task = store.createTask("登录测试", 1);
  const done = await service.run(task.id);
  assert.equal(done.status, "needs_login");
  assert.match(done.progress_message, /扫码登录/);
});

test("a transient detail failure is retried once and then succeeds", async (t) => {
  let attempts = 0;
  const url = "https://www.xiaohongshu.com/explore/retry";
  const { store, service } = await setup(t, {
    collectLinks: async () => [{ url }],
    extractPost: async (_task, value, retryCount) => {
      attempts += 1;
      if (!retryCount) throw new XhsStageError("detail_extract", "短暂加载失败");
      return post(value);
    }
  });
  const task = store.createTask("有限重试", 1);
  const done = await service.run(task.id);
  assert.equal(done.status, "completed");
  assert.equal(attempts, 2);
});

test("an evidenced platform limit is not mislabeled as generic failure", async (t) => {
  const { store, service } = await setup(t, {
    collectLinks: async () => { throw new XhsStageError("login_check", "当前网络受限", { platformLimited: true }); },
    extractPost: async () => null
  });
  const task = store.createTask("平台状态", 1);
  const done = await service.run(task.id);
  assert.equal(done.status, "platform_limited");
  assert.equal(store.getErrors(task.id)[0].platform_limited, 1);
});

test("stop requests are honored at a safe boundary", async (t) => {
  let store;
  const setupResult = await setup(t, {
    collectLinks: async (_keyword, _target, progress, shouldStop) => {
      progress({ count: 1 });
      store.updateTask(store.listTasks()[0].id, { stop_requested: 1 });
      assert.equal(shouldStop(), true);
      return [{ url: "https://www.xiaohongshu.com/explore/stop" }];
    },
    extractPost: async () => { throw new Error("should not run"); }
  });
  store = setupResult.store;
  const task = store.createTask("停止测试", 1);
  const done = await setupResult.service.run(task.id);
  assert.equal(done.status, "stopped");
  assert.equal(done.processed_count, 0);
});

test("search input is validated and target count is capped", async (t) => {
  const { service } = await setup(t, { collectLinks: async () => [], extractPost: async () => null });
  assert.throws(() => service.start("a", 1), /至少需要 2 个字/);
  const task = service.start("合格主题", 999);
  assert.equal(task.target_count, 20);
});
