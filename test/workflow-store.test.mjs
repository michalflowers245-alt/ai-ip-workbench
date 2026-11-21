import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WorkflowStore } from "../lib/workflow-store.js";

const at = "2026-11-17T17:30:00.000Z";
const recently = "2026-11-16T12:00:00.000Z";
const exec = promisify(execFile);

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "content-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new WorkflowStore({ projectRoot: root, now: () => new Date(at) }) };
}

function update(store, task, action, fields = {}) {
  return store.update(task.id, { revision: task.revision, action, ...fields });
}

test("existing notes are preserved when adopting a legacy task, creates are serialized in Shanghai time", async (t) => {
  const { root, store } = await setup(t);
  const legacyId = "CONTENT-20261118-05";
  const legacyPath = path.join(root, "运行状态", "任务记录", `${legacyId}.md`);
  await mkdir(path.dirname(legacyPath), { recursive: true });
  const legacyNotes = "## 人工记录\n\n不丢失 [资料](./old.md) 或$符号。\n";
  await writeFile(legacyPath, `# 任务状态记录\n\n## 基本信息\n\n- task_id：${legacyId}\n- task_type：old-research\n- current_status：AWAITING_TOPIC_CONFIRMATION\n- owner_employee：01-热点与竞品研究员\n- version：v2\n- user_goal：保留历史题\n\n${legacyNotes}`);
  const old = await store.get(legacyId);
  assert.equal(old.stage, "research");
  assert.equal(old.version, "v2");
  const confirmed = await update(store, old, "confirm_topic", { confirmation: "这题继续" });
  const written = await update(store, confirmed, "handoff");
  assert.equal(written.stage, "writing");
  const markdown = await readFile(legacyPath, "utf8");
  assert.ok(markdown.includes(legacyNotes.trimEnd()));
  assert.match(markdown, /task_type：old-research/);
  assert.match(markdown, /owner_employee：02-文案制作/);

  const created = await Promise.all([store.create({ title: "新题 1" }), store.create({ title: "新题 2", entryStage: "analytics" })]);
  assert.deepEqual(created.map((task) => task.id), ["CONTENT-20261118-06", "CONTENT-20261118-07"]);
  const newMarkdown = await readFile(created[0].recordPath, "utf8");
  assert.equal(newMarkdown.match(/^## 基本信息$/gm)?.length, 1);
  assert.match(newMarkdown, /^## 基本信息\n\n- task_id：CONTENT-20261118-06$/m);
  assert.deepEqual((await store.list("writing")).map((task) => task.id), [legacyId]);
  await assert.rejects(update(store, old, "save", { data: { summary: "旧输入" } }), { status: 409 });
});

test("supports research handoff, text direct to analytics, and video verification", async (t) => {
  const { root, store } = await setup(t);
  let task = await store.create({ title: "内容", format: "text" });
  task = await update(store, task, "request_input", { note: "等待本人案例" });
  assert.equal(task.status, "NEEDS_INPUT");
  task = await update(store, task, "save", { data: { summary: "建议已整理", attachments: [{ url: "https://example.org/original" }] } });
  await assert.rejects(update(store, task, "handoff"), { status: 409 });
  task = await update(store, task, "confirm_topic", { confirmation: "确认写作" });
  task = await update(store, task, "handoff", { note: "研究交接" });
  await assert.rejects(update(store, task, "handoff", { data: { caption: "仅有标题" } }), { status: 409 });
  task = await update(store, task, "handoff", { data: { script: "真实正文" }, toStage: "analytics" });
  assert.equal(task.stage, "analytics");
  assert.equal(task.stages.editing.state, "pending");
  assert.equal(task.stages.research.data.attachments.length, 1);

  let video = await store.create({ title: "旧片接入", entryStage: "editing" });
  await assert.rejects(update(store, video, "handoff", { data: { verified: true, videoPath: "missing.mp4" } }), { status: 409 });
  const final = path.join(root, "final video.mp4");
  await writeFile(final, "fixture file");
  video = await update(store, video, "handoff", { data: { verified: true, videoPath: final } });
  assert.equal(video.stage, "analytics");
  video = await update(store, video, "revise", { toStage: "editing", note: "换结尾" });
  assert.equal(video.versions[0].stages.editing.data.verified, true);
  assert.equal(video.stages.editing.data.verified, undefined);
  await assert.rejects(update(store, video, "handoff"), { status: 409 });
});

test("two workbench processes cannot begin the same publish attempt", async (t) => {
  const { root, store } = await setup(t);
  let task = await store.create({ title: "跨进程发布锁", format: "text", entryStage: "analytics" });
  task = await update(store, task, "prepare_publish", {
    targets: [{ platform: "x", account: "example", title: "标题", content: "测试正文" }], prediction: "测试预测"
  });
  task = await update(store, task, "approve_publish", { batchId: task.batch.id, confirmation: "测试确认" });
  const fields = { revision: task.revision, action: "begin_publish", targetId: task.batch.targets[0].id };
  const module = new URL("../lib/workflow-store.js", import.meta.url).href;
  const args = ["--input-type=module", "-e", `
    import { WorkflowStore } from ${JSON.stringify(module)};
    const store = new WorkflowStore({ projectRoot: process.argv[1] });
    try { await store.update(process.argv[2], JSON.parse(process.argv[3])); console.log(200); }
    catch (error) { console.log(error.status); }
  `, root, task.id, JSON.stringify(fields)];
  const responses = await Promise.all([exec(process.execPath, args), exec(process.execPath, args)]);
  assert.deepEqual(responses.map(({ stdout }) => Number(stdout.trim())).sort(), [200, 409]);
  assert.equal((await store.get(task.id)).publications[0].attempts.length, 1);
});

test("publication requires frozen approval and reconciles unknown attempts without double posting", async (t) => {
  const { store, root } = await setup(t);
  let task = await store.create({ title: "待发布", entryStage: "analytics" });
  await writeFile(path.join(root, "video.mp4"), "original bytes");
  const target = { platform: "x", account: "example", file: "video.mp4", title: "首版" };
  task = await update(store, task, "prepare_publish", { targets: [target], prediction: "预测先于实绩" });
  const batchId = task.batch.id;
  let targetId = task.batch.targets[0].id;
  await assert.rejects(update(store, task, "begin_publish", { targetId }), { status: 409 });
  task = await update(store, task, "approve_publish", { batchId, confirmation: "确认发布这个版本" });
  await writeFile(path.join(root, "video.mp4"), "changed bytes");
  await assert.rejects(update(store, task, "begin_publish", { targetId }), { status: 409 });

  task = await update(store, task, "revise", { note: "换成新素材" });
  assert.equal(task.version, "v2");
  assert.equal(task.approval, null);
  assert.equal(task.versions[0].approval.batchId, batchId);
  await assert.rejects(update(store, task, "approve_publish", { batchId, confirmation: "误用旧批次" }), { status: 409 });
  task = await update(store, task, "prepare_publish", { targets: [target], prediction: "新预测" });
  targetId = task.batch.targets[0].id;
  task = await update(store, task, "approve_publish", { batchId: task.batch.id, confirmation: "确认新版" });
  task = await update(store, task, "begin_publish", { targetId });
  let attemptId = task.publications[0].attempts[0].id;
  const restarted = new WorkflowStore({ projectRoot: root, now: () => new Date(at) });
  task = await restarted.get(task.id);
  await assert.rejects(update(restarted, task, "begin_publish", { targetId }), { status: 409 });
  task = await update(restarted, task, "record_publish", { targetId, attemptId, state: "failed", reason: "请求连接断开" });
  assert.equal(task.publications[0].state, "unknown");
  await assert.rejects(update(restarted, task, "begin_publish", { targetId }), { status: 409 });
  await assert.rejects(update(restarted, task, "revise", { note: "结果未知" }), { status: 409 });
  task = await update(restarted, task, "record_publish", { targetId, attemptId, state: "failed", reason: "平台明确未接收请求", confirmedUnpublished: true });
  task = await update(restarted, task, "begin_publish", { targetId });
  attemptId = task.publications[0].attempts.at(-1).id;
  task = await update(restarted, task, "record_publish", { targetId, attemptId, state: "published", platformPostId: "123", publishedAt: recently });
  assert.equal(task.status, "AWAITING_DATA");
  assert.equal(task.publications[0].attempts.length, 2);
  await assert.rejects(update(restarted, task, "begin_publish", { targetId }), { status: 409 });
  await assert.rejects(update(restarted, task, "register_publish", { target, platformPostId: "123", publishedAt: recently }), { status: 409 });
});

test("real metrics with zero, nullable values, and matching receipt feed both roles", async (t) => {
  const { root, store } = await setup(t);
  let task = await store.create({ title: "历史发布接入", entryStage: "analytics", format: "text" });
  task = await update(store, task, "register_publish", {
    target: { platform: "x", account: "example", title: "历史作品" },
    url: "https://x.com/example/status/123", platformPostId: "123", publishedAt: recently
  });
  const targetId = task.publications[0].targetId;
  const retro = { summary: "样本结果", research: "优先具体处境", writing: "从动作切入", nextExperiment: "只换开头" };
  const snapshot = { platform: "x", platform_post_id: "123", collected_at: at, source_type: "creator_center_snapshot", metrics: { likes: 0, views: null } };
  await assert.rejects(update(store, task, "complete_retro", retro), { status: 409 });
  await assert.rejects(update(store, task, "record_metrics", { targetId, snapshot: { ...snapshot, platform_post_id: "124" } }), { status: 400 });
  await assert.rejects(update(store, task, "record_metrics", { targetId, snapshot: { ...snapshot, metrics: { likes: null } } }), { status: 400 });
  await assert.rejects(update(store, task, "record_metrics", { targetId, snapshot: { ...snapshot, metrics: { completion_rate: 85 } } }), { status: 400 });
  await assert.rejects(update(store, task, "record_metrics", { targetId, snapshot: { ...snapshot, raw: { synthetic: true } } }), { status: 400 });
  task = await update(store, task, "record_metrics", { targetId, snapshot });
  task = await update(store, task, "complete_retro", retro);
  assert.equal(task.status, "RETRO_DONE");
  assert.equal((await store.feedback("research"))[0].text, retro.research);
  assert.equal((await store.feedback("writing"))[0].text, retro.writing);
  assert.equal(task.publications[0].snapshots[0].metrics.likes, 0);
  assert.equal(task.publications[0].snapshots[0].metrics.views, null);
  const files = await readdir(path.join(root, "数据飞轮", "采集记录", task.id));
  assert.equal(files.length, 1);
  const ledger = await readFile(path.join(root, "数据飞轮", "发布数据台账.md"), "utf8");
  assert.match(ledger, /创作|复盘/);
  task = await update(store, task, "archive");
  assert.equal(task.status, "ARCHIVED");
});

test("a manual batch receipt reuses its frozen target and preserves the T+3 choice", async (t) => {
  const { store } = await setup(t);
  let task = await store.create({ title: "同批次登记", format: "text", entryStage: "analytics" });
  const targets = [
    { platform: "x", account: "example", title: "原始标题", content: "稿件", autoCollect: true },
    { platform: "bilibili", account: "example", title: "同步标题", content: "稿件" }
  ];
  for (const prediction of [{ source: "未提供正文" }, { body: " \n " }, { body: ["不是文本"] }]) {
    await assert.rejects(update(store, task, "prepare_publish", { prediction, targets }), { status: 400 });
  }
  const prediction = { body: "发布前猜测", source: "参考项目历史" };
  task = await update(store, task, "prepare_publish", { prediction, targets });
  assert.deepEqual(task.batch.prediction, prediction);
  task = await update(store, task, "approve_publish", { batchId: task.batch.id, confirmation: "采用此范围" });
  const [target, remaining] = task.batch.targets;
  task = await update(store, task, "register_publish", {
    target: { ...target, title: "意外混入的标题" }, url: "https://x.com/example/status/876", publishedAt: recently
  });
  assert.equal(task.publications[0].targetId, target.id);
  assert.equal(task.publications[0].target.title, "原始标题");
  assert.equal(task.publications[0].target.autoCollect, true);
  task = await update(store, task, "skip_publish", { targetId: remaining.id, reason: "此平台未发布" });
  assert.equal(task.publications[1].state, "skipped");
});
