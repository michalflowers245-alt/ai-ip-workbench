import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbench } from "../lib/workbench-routes.js";
import { WorkflowStore } from "../lib/workflow-store.js";

async function setup(t, modelResult = { body: "供人工审阅的测试草稿", needsInput: [] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-routes-"));
  const calls = [];
  let payload;
  let response;
  const workbench = createWorkbench({
    projectRoot: root, workerRoot: root, dataDir: path.join(root, "data"), monitorEnabled: false,
    bodyJson: async () => payload,
    send: (_response, status, value) => { response = { status, ...value }; },
    model: async (messages) => {
      calls.push(messages);
      if (modelResult instanceof Error) throw modelResult;
      return JSON.stringify(modelResult);
    },
    knowledge: async () => []
  });
  t.after(async () => { workbench.stop(); await rm(root, { recursive: true, force: true }); });
  return {
    store: new WorkflowStore({ projectRoot: root }), calls,
    async act(task, body) {
      payload = { revision: task.revision, ...body };
      await workbench.route({ method: "POST" }, {}, new URL(`http://localhost/api/workbench/tasks/${task.id}/action`));
      assert.equal(response.status, 200);
      return response.task;
    }
  };
}

const html = (body, metadata = "") => `<html><head><title>Official article</title>${metadata}</head><article><p>${body}</p></article></html>`;
const excerpt = "A verifiable passage containing the official announcement and its specific limits.";
const response = (body, headers = {}) => new Response(body, { headers: { "content-type": "text/html", ...headers } });

test("explicitly stale official pages remain visible but cannot invoke a model or auto-draft", async (t) => {
  const { store, calls, act } = await setup(t);
  t.mock.method(globalThis, "fetch", async () => response(html(excerpt), { "x-cache": "HIT, STALE" }));
  const task = await store.create({ title: "待核实热点", inputs: { text: "https://openai.com/index/example/" } });
  const result = await act(task, { action: "generate", autoDraft: true });
  assert.equal(result.stage, "research");
  assert.equal(calls.length, 0);
  assert.match(result.researchNotice, /过期缓存或时间异常/);
  assert.equal(result.stages.research.data.sourceChecks[0].status, "read");
  assert.equal(result.stages.research.data.sourceChecks[0].cache.stale, true);
  assert.equal(result.stages.research.data.sourceChecks[0].excerpt, excerpt);
  assert.equal((await store.get(task.id)).stages.writing.data.script, undefined);
});

test("conflicting or future release times block auto-drafting and retain the source record", async (t) => {
  const { store, calls, act } = await setup(t);
  const fixtures = [
    `<meta property="article:published_time" content="2020-01-02"><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2020-01-05"}</script>`,
    `<meta property="article:published_time" content="${new Date(Date.now() + 7 * 86400_000).toISOString()}">`
  ];
  let metadata;
  t.mock.method(globalThis, "fetch", async () => response(html(excerpt, metadata)));
  for (metadata of fixtures) {
    const task = await store.create({ title: "时间待核实", inputs: { text: "https://openai.com/index/example/" } });
    const result = await act(task, { action: "generate", autoDraft: true });
    assert.equal(result.stage, "research");
    assert.equal(result.stages.research.data.sourceChecks[0].excerpt, excerpt);
    assert.match(result.researchNotice, /时间异常/);
  }
  assert.equal(calls.length, 0);
});

test("invalid persisted timestamps and cached previous passages cannot leak through nested model inputs", async (t) => {
  const invalidPassage = "INVALID_TIME_PASSAGE must stay in the record but never enter a factual prompt.";
  const stalePassage = "STALE_PASSAGE must stay in the record but never enter a factual prompt.";
  const previousPassage = "FAILED_PREVIOUS_READ must stay in the record but never enter a factual prompt.";
  const sourceText = "https://openai.com/index/valid/";
  const checkedAt = new Date().toISOString();
  const source = { sourceKind: "official", status: "read", publisher: "openai.com", checkedAt };
  const sourceChecks = [
    { ...source, evidenceId: "E1", url: sourceText, excerpt },
    { ...source, evidenceId: "E2", url: sourceText + "old", excerpt: stalePassage, cache: { stale: true } },
    { ...source, evidenceId: "E3", url: sourceText + "invalid", excerpt: invalidPassage, publishedAt: "not-a-date" },
    { ...source, evidenceId: "E4", url: sourceText + "failed", status: "unavailable", previousRead: { excerpt: previousPassage } }
  ];
  const { store, calls, act } = await setup(t, { body: "只引用当前可用原文", claims: [{ claim: "过期的主张", quote: stalePassage, sourceId: "E2" }], needsInput: [] });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("recent checks must be reused"); });
  const task = await store.create({ title: "混合来源", inputs: { text: sourceText, stageData: { sourceText, checkedSourceText: sourceText, sourceChecks } } });
  const result = await act(task, { action: "generate", autoDraft: true });
  assert.equal(result.stage, "writing");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    for (const text of [call.user, call.compact.user]) {
      assert.ok(text.includes(excerpt));
      assert.ok(!text.includes(stalePassage));
      assert.ok(!text.includes(invalidPassage));
      assert.ok(!text.includes(previousPassage));
      assert.match(text, /发布时间未知/);
    }
  }
  assert.deepEqual(result.stages.research.data.claims, []);
  assert.equal(result.stages.research.data.sourceChecks[1].excerpt, stalePassage);
});

test("local-model revisions use the current edited draft and the complete normal-length correction", async (t) => {
  const { store, calls, act } = await setup(t);
  const previousDraft = "手工新稿开头：" + "只改第二段，其他内容是已经审定的真实个人素材。".repeat(50) + "手工新稿结尾。";
  const corrections = "只修改第二段的解释，保留第一段和最后一句。".repeat(18);
  const task = await store.create({ title: "继续改稿", entryStage: "writing", inputs: { stageData: { script: "旧保存稿不应覆盖用户手改稿" } } });
  await act(task, { action: "generate", input: { previousDraft, corrections } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].compact.user.includes(previousDraft));
  assert.ok(calls[0].compact.user.includes(corrections));
  assert.ok(!calls[0].compact.user.includes("旧保存稿不应覆盖用户手改稿"));
  assert.ok(calls[0].user.includes(previousDraft));
});

test("saved drafts are the fallback for a revision and long drafts keep their complete body", async (t) => {
  const { store, calls, act } = await setup(t);
  const script = "保存稿开头。" + "这是保留的原稿段落。".repeat(400) + "中段唯一的真实案例不能删。" + "后半部分的论证。".repeat(400) + "原稿结尾的行动。";
  const task = await store.create({ title: "长稿", entryStage: "writing", inputs: { stageData: { script } } });
  await act(task, { action: "generate", input: { corrections: "调整结尾" } });
  assert.ok(calls[0].compact.user.includes(script));
  assert.ok(calls[0].user.includes(script));
  assert.ok(!calls[0].compact.user.includes("中段未提供"));
  assert.ok(calls[0].compact.user.length - script.length < 900);
});

test("a model context-limit error leaves the saved draft and task revision untouched", async (t) => {
  const { store, calls, act } = await setup(t, Object.assign(new Error("model context length exceeded"), { status: 400 }));
  const script = "已经保存并审定的原稿。".repeat(500);
  const previousDraft = script + "本次手工补充的末段。";
  const task = await store.create({ title: "超长改稿失败", entryStage: "writing", inputs: { stageData: { script } } });
  await assert.rejects(act(task, { action: "generate", input: { previousDraft, corrections: "调整开头" } }), /context length exceeded/);
  assert.ok(calls[0].compact.user.includes(previousDraft));
  const after = await store.get(task.id);
  assert.equal(after.revision, task.revision);
  assert.equal(after.stages.writing.data.script, script);
});
