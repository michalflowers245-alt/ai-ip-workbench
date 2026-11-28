import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { XhsStore } from "../lib/xhs-store.js";

async function withStore(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xhs-store-test-"));
  const file = path.join(dir, "research.sqlite");
  const store = new XhsStore(file);
  t.after(async () => { try { store.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  return { store, file };
}

test("SQLite creates and updates a search task", async (t) => {
  const { store } = await withStore(t);
  const task = store.createTask("AI 职业", 8);
  assert.equal(task.status, "queued");
  const updated = store.updateTask(task.id, { status: "searching", total_links: 3, progress_message: "采集中" });
  assert.equal(updated.status, "searching");
  assert.equal(updated.total_links, 3);
  assert.equal(store.listTasks()[0].keyword, "AI 职业");
});

test("post URL is de-duplicated while task relationships are preserved", async (t) => {
  const { store } = await withStore(t);
  const one = store.createTask("大学", 2);
  const two = store.createTask("青年", 2);
  const input = { postUrl: "https://www.xiaohongshu.com/explore/abc123", postKey: "abc123", title: "第一版", body: "正文", mergedCopy: "正文", extractionStatus: "success", completeness: 80, tags: ["AI"], fieldSources: { body: "DOM" } };
  const first = store.savePost(one.id, one.keyword, input, 1);
  const second = store.savePost(two.id, two.keyword, { ...input, title: "更新版" }, 1);
  assert.equal(first.id, second.id);
  assert.equal(store.countPosts(), 1);
  assert.equal(store.getTaskResults(one.id).length, 1);
  assert.equal(store.getTaskResults(two.id)[0].title, "更新版");
  assert.equal(store.queryPosts({ keyword: "青年" }).length, 1);
  assert.equal(store.queryPosts({ keyword: "不存在" }).length, 0);
  assert.equal(store.listTasks({ keyword: "大学" }).length, 1);
});

test("field sources, diagnostics and failures survive SQLite hydration", async (t) => {
  const { store } = await withStore(t);
  const task = store.createTask("测试", 1);
  const saved = store.savePost(task.id, task.keyword, {
    postUrl: "https://www.xiaohongshu.com/explore/failure1", postKey: "failure1", tags: ["测试"],
    extractionStatus: "partial", completeness: 25, failureStage: "content_extract", errorMessage: "结构变化",
    fieldSources: { title: "Accessibility Tree" }, diagnostics: { visibleTextLength: 19 }, ocrStatus: "unavailable", asrStatus: "unavailable"
  }, 1);
  assert.deepEqual(saved.tags, ["测试"]);
  assert.equal(saved.fieldSources.title, "Accessibility Tree");
  assert.equal(saved.diagnostics.visibleTextLength, 19);
  assert.equal(saved.failure_stage, "content_extract");
  store.addError(task.id, { postUrl: saved.post_url, failureStage: "content_extract", errorMessage: "结构变化", loginDetected: true });
  assert.equal(store.getErrors(task.id)[0].login_detected, 1);
});

test("unfinished tasks are marked interrupted after a restart", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xhs-restart-test-"));
  const file = path.join(dir, "research.sqlite");
  let store = new XhsStore(file);
  const task = store.createTask("重启", 1);
  store.updateTask(task.id, { status: "extracting" });
  store.close();
  store = new XhsStore(file);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(store.getTask(task.id).status, "interrupted");
});

test("automation settings survive SQLite close and reopen", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xhs-automation-restart-"));
  const file = path.join(dir, "research.sqlite");
  let store = new XhsStore(file);
  store.updateAutomation({ enabled: true, keywords_json: JSON.stringify(["AI OPC", "大学生 AI"]), interval_hours: 12, target_count: 5, state: "scheduled", next_run_at: "2026-11-29T00:00:00.000Z" });
  store.close();
  store = new XhsStore(file);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const saved = store.getAutomation();
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.keywords, ["AI OPC", "大学生 AI"]);
  assert.equal(saved.interval_hours, 12);
  assert.equal(saved.state, "scheduled");
  assert.equal(saved.next_run_at, "2026-11-29T00:00:00.000Z");
});
