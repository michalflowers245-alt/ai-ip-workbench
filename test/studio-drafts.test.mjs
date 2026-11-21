import assert from "node:assert/strict";
import test from "node:test";
import { createDraftStore, taskPage } from "../public/studio-drafts.js";

function memoryStorage() {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key) || null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key)
  };
}

test("browser drafts survive a reload and remain separate for each task and stage", () => {
  const storage = memoryStorage();
  const first = createDraftStore(storage);
  const text = "  原文保留空格\n\n第二段 👨‍👩‍👧  ";
  first.write("CONTENT-20261117-01", "writing", { revision: 3, version: "v1", values: { script: text } });
  first.write("CONTENT-20261117-01", "research", { revision: 2, version: "v1", values: { body: "研究笔记" } });
  first.write("CONTENT-20261117-02", "writing", { revision: 0, version: "v1", values: { script: "另一任务" } });
  const reloaded = createDraftStore(storage);
  assert.equal(reloaded.read("CONTENT-20261117-01", "writing").values.script, text);
  reloaded.remove("CONTENT-20261117-01", "writing");
  assert.equal(reloaded.read("CONTENT-20261117-01", "writing"), null);
  assert.equal(reloaded.read("CONTENT-20261117-01", "research").values.body, "研究笔记");
  assert.equal(reloaded.read("CONTENT-20261117-02", "writing").values.script, "另一任务");
});

test("new generation removes superseded input while preserving unrelated unsaved publish targets", () => {
  const drafts = createDraftStore(memoryStorage());
  const targets = [{ platform: "x", title: "用户修改标题", account: "公开别名" }];
  drafts.write("task", "analytics", { revision: 4, version: "v1", values: {
    prediction: "尚未保存的旧预测", targets,
    "metrics.first.views": "0", "metrics.second.views": "180"
  } });
  drafts.reconcile("task", "analytics", 5, "v1", ["prediction", "metrics.first"]);
  assert.deepEqual(drafts.read("task", "analytics").values, { targets, "metrics.second.views": "180" });
  assert.equal(drafts.read("task", "analytics").revision, 5);
  drafts.reconcile("task", "analytics", 6, "v1", ["*"]);
  assert.equal(drafts.read("task", "analytics"), null);
});

test("blocked browser storage preserves the in-page draft and reports that it cannot survive reload", () => {
  const storage = {
    getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("blocked"); }
  };
  const drafts = createDraftStore(storage);
  drafts.write("task", "writing", { revision: 1, version: "v1", values: { script: "不能丢的输入" } });
  assert.equal(drafts.persistent, false);
  assert.equal(drafts.read("task", "writing").values.script, "不能丢的输入");
  drafts.remove("task", "writing");
  assert.equal(drafts.read("task", "writing"), null);
});

test("quota failure cannot resurrect an older draft over a newer edit or explicit discard", () => {
  const storage = memoryStorage();
  const drafts = createDraftStore(storage);
  drafts.write("task", "writing", { revision: 1, version: "v1", values: { script: "旧输入" } });
  storage.setItem = () => { throw new Error("quota"); };
  storage.removeItem = () => { throw new Error("blocked"); };
  drafts.write("task", "writing", { revision: 1, version: "v1", values: { script: "最新输入" } });
  assert.equal(drafts.read("task", "writing").values.script, "最新输入");
  drafts.remove("task", "writing");
  assert.equal(drafts.read("task", "writing"), null);
});

test("all tasks remain searchable and reachable beyond the former 36-row cutoff", () => {
  const tasks = Array.from({ length: 73 }, (_, index) => ({
    id: "CONTENT-20261117-" + String(index + 1).padStart(2, "0"),
    title: index === 72 ? "中文专题与 AI" : "任务 " + (index + 1), stage: "writing",
    status: index % 2 ? "DRAFTED" : "CONFIRMED"
  }));
  const visited = new Set();
  for (let page = 1; page <= 7; page++) {
    for (const task of taskPage(tasks, { role: "writing", page }).rows) visited.add(task.id);
  }
  assert.equal(visited.size, 73);
  assert.equal(taskPage(tasks, { query: "content-20261117-73" }).rows[0].title, "中文专题与 AI");
  assert.equal(taskPage(tasks, { query: "中文专题", status: "CONFIRMED" }).total, 1);
  assert.equal(taskPage(tasks, { query: "中文专题", status: "DRAFTED", page: 999 }).total, 0);
  assert.equal(taskPage(tasks, { query: "中文专题", status: "DRAFTED", page: 999 }).page, 1);
});
