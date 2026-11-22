import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbench } from "../lib/workbench-routes.js";
import { WorkflowStore } from "../lib/workflow-store.js";

async function setup(t, modelResult = { body: "供人工审阅的测试草稿", needsInput: [] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-routes-"));
  const configDir = path.join(root, "自媒体员工配置");
  await mkdir(configDir, { recursive: true });
  for (const name of ["01-热点与竞品研究员.md", "02-文案制作.md", "03-剪辑.md", "04-数据分析.md"]) {
    const config = await readFile(new URL(`../自媒体员工配置/${name}`, import.meta.url), "utf8");
    await writeFile(path.join(configDir, name), config);
  }
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
  async function request(task, body) {
    payload = { revision: task.revision, ...body };
    await workbench.route({ method: "POST" }, {}, new URL(`http://localhost/api/workbench/tasks/${task.id}/action`));
    return response;
  }
  async function raw(task, body) {
    try { return await request(task, body); }
    catch (error) { response = { status: error.status || 500, error: error.message }; }
    return response;
  }
  async function act(task, body) {
    const result = await request(task, body);
    assert.equal(result.status, 200);
    return result.task;
  }
  return { store: new WorkflowStore({ projectRoot: root }), calls, raw, act };
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

test("exact quote matches stay pending until reviewed, source snapshots persist, and writing receives only reviewed claims", async (t) => {
  const claim = "The announcement is a personal claim, not an accepted mathematical result.";
  const { store, calls, act, raw } = await setup(t, {
    title: "AI proof claim", body: "保留其个人主张与机构状态的区别。",
    claims: [{ claim, sourceId: "E1", quote: excerpt }], needsInput: []
  });
  t.mock.method(globalThis, "fetch", async () => response(html(excerpt)));
  const task = await store.create({ title: "可复核来源", inputs: { text: "https://openai.com/index/example/" } });
  const researched = await act(task, { action: "generate" });
  const source = researched.stages.research.data.sourceChecks[0];
  assert.equal(source.status, "read");
  assert.match(source.responseHash, /^[a-f0-9]{64}$/);
  assert.ok(source.snapshotPath);
  assert.equal(researched.stages.research.data.claims[0].reviewStatus, "pending");
  assert.deepEqual(researched.stages.research.data.skillTrace.skills.map((item) => item.status), ["loaded", "loaded", "loaded", "loaded"]);
  const blocked = await raw(researched, { action: "handoff", toStage: "writing" });
  assert.equal(blocked.status, 409);
  const corrupted = await act(researched, { action: "save", data: { claims: [{ claimId: "C1", claim, sourceId: "E1", quote: "A quote that is absent from the official page." }] } });
  const fakeReview = await raw(corrupted, { action: "review_claims", reviews: [{ claimId: "C1", status: "supported", reason: "有足够长的理由仍然不应通过。" }] });
  assert.equal(fakeReview.status, 409);
  const restored = await act(corrupted, { action: "save", data: { claims: researched.stages.research.data.claims } });
  const reviewed = await act(restored, { action: "review_claims", reviews: [{ claimId: "C1", status: "qualified", reason: "原文只支持本人提出了这一主张。" }] });
  assert.equal(reviewed.stages.research.data.claims[0].reviewStatus, "qualified");
  assert.equal(reviewed.stages.research.data.claimReview.complete, true);
  const confirmed = await act(reviewed, { action: "confirm_topic", confirmation: "采用已复核的研究结论" });
  const handedOff = await act(confirmed, { action: "handoff", toStage: "writing", note: "完成主张复核" });
  const written = await act(handedOff, { action: "generate" });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].compact.user.includes("qualified"));
  assert.ok(calls[1].compact.user.includes("原文只支持本人提出了这一主张"));
  assert.equal(written.stages.writing.data.skillTrace.skills.every((item) => item.status === "loaded"), true);
});

test("preview-only analytics loads review guidance without the formal prediction skill", async (t) => {
  const { store, calls, act } = await setup(t, { body: "仅供预览的发布说明", needsInput: [] });
  const task = await store.create({ title: "仅发布预览", format: "video", entryStage: "analytics" });
  const result = await act(task, { action: "generate", input: { previewOnly: true } });
  assert.deepEqual(result.stages.analytics.data.skillTrace.skills.map((skill) => skill.name), ["publishing-and-performance-review"]);
  assert.match(calls[0].compact.user, /previewOnly/);
  assert.match(calls[0].compact.user, /true/);
});

test("writing cannot hand off a script before its four factual and editorial checks are recorded", async (t) => {
  const { store, act, raw } = await setup(t);
  let task = await store.create({ title: "待复核文案", entryStage: "writing" });
  task = await act(task, { action: "save", data: { script: "AI写的口播稿", body: "AI写的口播稿" } });
  const blocked = await raw(task, { action: "handoff", toStage: "editing", data: { script: "AI写的口播稿" } });
  assert.equal(blocked.status, 409);
  task = await act(task, { action: "save", data: { manualReview: { status: "accepted_for_editing", reviewedAt: new Date().toISOString(), checks: ["source_facts", "attribution_limits", "example_truth", "script_logic"] } } });
  const handed = await act(task, { action: "handoff", toStage: "editing", data: { script: "AI写的口播稿", manualReview: task.stages.writing.data.manualReview } });
  assert.equal(handed.stage, "editing");
  assert.equal(handed.stages.writing.data.manualReview.status, "accepted_for_editing");
});

test("a short official status label can be cited exactly but still requires explicit review", async (t) => {
  const page = `<html><head><title>Riemann Hypothesis | Clay Mathematics Institute</title></head>
    <main><p>The Riemann Hypothesis is one of the Millennium Prize Problems.</p>
    <p class="meta-tag">Unsolved</p></main></html>`;
  const { store, act } = await setup(t, {
    title: "AI claim and official status", body: "分清个人主张与官方页面状态。",
    claims: [{ claim: "Clay's current page labels the problem unsolved.", sourceId: "E1", quote: "Unsolved" }],
    needsInput: []
  });
  t.mock.method(globalThis, "fetch", async () => response(page));
  const task = await store.create({ title: "Clay 状态核验", inputs: { text: "https://www.claymath.org/millennium/Riemann-Hypothesis/" } });
  const researched = await act(task, { action: "generate" });
  assert.equal(researched.stages.research.data.claims[0].quote, "Unsolved");
  assert.equal(researched.stages.research.data.claims[0].reviewStatus, "pending");
  assert.equal(researched.stages.research.data.claimReview.complete, false);
  const reviewed = await act(researched, { action: "review_claims", reviews: [{
    claimId: "C1", status: "qualified", reason: "该标签说明页面当前标注，不能推断机构已审阅此新主张。"
  }] });
  assert.equal(reviewed.stages.research.data.claims[0].reviewStatus, "qualified");
  assert.equal(reviewed.stages.research.data.claimReview.complete, true);
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
  const conflictPassage = "CONFLICTING_UPDATE_PASSAGE must stay in the record but never enter a factual prompt.";
  const sourceText = "https://openai.com/index/valid/";
  const checkedAt = new Date().toISOString();
  const source = { sourceKind: "official", status: "read", publisher: "openai.com", checkedAt };
  const sourceChecks = [
    { ...source, evidenceId: "E1", url: sourceText, excerpt },
    { ...source, evidenceId: "E2", url: sourceText + "old", excerpt: stalePassage, cache: { stale: true } },
    { ...source, evidenceId: "E3", url: sourceText + "invalid", excerpt: invalidPassage, publishedAt: "not-a-date" },
    { ...source, evidenceId: "E4", url: sourceText + "failed", status: "unavailable", previousRead: { excerpt: previousPassage } },
    { ...source, evidenceId: "E5", url: sourceText + "conflict", excerpt: conflictPassage,
      dateConflicts: { updatedAt: [{ from: "page-header", value: "2026-11-21T12:55:00Z" }, { from: "body-log", value: "2026-11-21T21:55:00Z" }] } }
  ];
  const { store, calls, act } = await setup(t, { body: "只引用当前可用原文", claims: [{ claim: "过期的主张", quote: stalePassage, sourceId: "E2" }], needsInput: [] });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("recent checks must be reused"); });
  const task = await store.create({ title: "混合来源", inputs: { text: sourceText, stageData: { sourceText, checkedSourceText: sourceText, sourceChecks } } });
  const result = await act(task, { action: "generate", autoDraft: true });
  assert.equal(result.stage, "research");
  assert.equal(calls.length, 1);
  for (const text of [calls[0].user, calls[0].compact.user]) {
    assert.ok(text.includes(excerpt));
    assert.ok(!text.includes(stalePassage));
    assert.ok(!text.includes(invalidPassage));
    assert.ok(!text.includes(previousPassage));
    assert.ok(!text.includes(conflictPassage));
  }
  assert.match(calls[0].user, /发布时间未知/);
  assert.deepEqual(result.stages.research.data.claims, []);
  assert.equal(result.stages.research.data.claimReview.complete, false);
  assert.match(result.researchNotice, /尚无逐条复核记录/);
  assert.equal(result.stages.research.data.sourceChecks[1].excerpt, stalePassage);
  assert.deepEqual(result.stages.research.data.sourceChecks[4].dateConflicts.updatedAt.map(({ value }) => value),
    ["2026-11-21T12:55:00Z", "2026-11-21T21:55:00Z"]);
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
  assert.equal(calls[0].compact.user.split(previousDraft).length - 1, 1);
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
  assert.equal(calls[0].compact.user.split(script).length - 1, 1);
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
