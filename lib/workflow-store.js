import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const WORKFLOW_STAGES = ["research", "writing", "editing", "analytics"];

const employees = {
  research: "01-热点与竞品研究员",
  writing: "02-文案制作",
  editing: "03-剪辑",
  analytics: "04-数据分析"
};
const formats = new Set(["video", "image", "text"]);
const platformHosts = {
  douyin: ["douyin.com", "iesdouyin.com"],
  xiaohongshu: ["xiaohongshu.com", "xhslink.com"],
  tencent: ["weixin.qq.com", "weixin110.qq.com"],
  x: ["x.com", "twitter.com"],
  bilibili: ["bilibili.com", "b23.tv"]
};
const contentId = /^CONTENT-\d{8}-\d{2}$/;
const metadata = /\n?<!-- workbench-state-v1 ([A-Za-z0-9+/=]+) -->\n?/;
const currentSection = /\n?<!-- workbench-summary:begin -->\n[\s\S]*?<!-- workbench-summary:end -->\n?/;
const indexSection = /\n?<!-- workbench-index:begin -->\n[\s\S]*?<!-- workbench-index:end -->\n?/;
const terminal = new Set(["ARCHIVED", "REJECTED"]);
const pendingPublish = new Set(["in_progress", "unknown", "scheduled"]);
const queues = new Map();
const statusForStage = { research: "INTAKE", writing: "CONFIRMED", editing: "DRAFTED", analytics: "DRAFTED" };
const nextForStage = {
  research: "整理来源、竞品和候选选题",
  writing: "制作可编辑文案和拍摄交接",
  editing: "导入原片或成片，完成剪辑与核验",
  analytics: "制作发布预览，或登记外部已发布作品"
};

class WorkflowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function check(condition, message, status = 400) {
  if (!condition) throw new WorkflowError(status, message);
}

function line(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function required(value, label) {
  check(typeof value === "string" && value.trim(), `请填写${label}`);
  return value.trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value, label) {
  check(isObject(value), `${label}应为结构化对象`);
  return value;
}

function stageName(stage) {
  check(WORKFLOW_STAGES.includes(stage), "工作区无效");
  return stage;
}

function time(value, label) {
  const date = new Date(required(value, label));
  check(Number.isFinite(date.valueOf()), `${label}格式无效`);
  return date.toISOString();
}

function shanghaiDate(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type).value).join("");
}

function initialStages(stage, data = {}) {
  return Object.fromEntries(WORKFLOW_STAGES.map((key) => [key, {
    state: key === stage ? "active" : "pending",
    data: key === stage ? data : {}
  }]));
}

function newTask({ id, title, goal, stage, format, inputs, at }) {
  return {
    id, title, goal, stage, owner: stage, format, status: statusForStage[stage], version: "v1", revision: 0,
    createdAt: at, updatedAt: at, inputs, nextAction: nextForStage[stage],
    stages: initialStages(stage, isObject(inputs.stageData) ? inputs.stageData : {}),
    topicConfirmation: null, batch: null, approval: null, publications: [], feedback: [], versions: [], history: []
  };
}

function markdownField(body, key) {
  return body.match(new RegExp(`^[-*] ${key}[：:] *(.*)$`, "m"))?.[1]?.trim() || "";
}

function legacyStage(owner, status) {
  if (/热点|竞品|定位/.test(owner)) return "research";
  if (/剪辑/.test(owner)) return "editing";
  if (/文案|内容制作统筹/.test(owner)) return "writing";
  if (/数据|运营|发布/.test(owner)) return "analytics";
  return Object.keys(employees).find((key) => owner.startsWith(employees[key].slice(0, 2)))
    || (["PUBLISHED", "AWAITING_DATA", "RETRO_DONE", "AWAITING_PUBLISH_CONFIRMATION", "ARCHIVED"].includes(status) ? "analytics" : "research");
}

function parseTask(id, body) {
  const stored = body.match(metadata);
  if (stored) {
    try {
      const task = JSON.parse(Buffer.from(stored[1], "base64").toString("utf8"));
      if (task.id !== id || !Number.isInteger(task.revision)) throw new Error("invalid task metadata");
      return task;
    } catch {
      throw new WorkflowError(409, `任务状态记录无法解析：${id}`);
    }
  }
  const status = markdownField(body, "current_status") || "INTAKE";
  const stage = legacyStage(markdownField(body, "owner_employee"), status);
  const goal = markdownField(body, "user_goal");
  const task = newTask({
    id, title: markdownField(body, "title") || markdownField(body, "内容标题") || goal || id,
    goal, stage, format: "video", inputs: {}, at: markdownField(body, "created_at")
  });
  return {
    ...task, legacy: true, status, version: markdownField(body, "version") || "v1",
    nextAction: markdownField(body, "next_action") || task.nextAction,
    updatedAt: markdownField(body, "updated_at") || task.updatedAt,
    legacyInfo: {
      deliverables: markdownField(body, "deliverables"), savedPaths: markdownField(body, "saved_paths"),
      sources: markdownField(body, "source_files_or_urls"), waitingFor: markdownField(body, "waiting_for")
    }
  };
}

function taskMarkdown(task, oldBody) {
  const base = oldBody.replace(metadata, "\n").replace(currentSection, "\n").trimEnd()
    || "# 任务状态记录";
  // `$` with the multiline flag also matches blank lines in the section, so
  // use an explicit end-of-input assertion for the final section boundary.
  const header = /(^## 基本信息\s*\n)([\s\S]*?)(?=\n## |(?![\s\S]))/m;
  const priorType = header.exec(base)?.[2].match(/^[-*]\s+task_type[：:]([^\r\n]*)/m)?.[1];
  const fields = {
    task_id: task.id, task_type: priorType || "content", title: task.title, version: task.version,
    current_status: task.status, owner_employee: employees[task.owner], user_goal: task.goal,
    created_at: task.createdAt, updated_at: task.updatedAt
  };
  let body = base;
  if (!header.test(body)) body = `${body}\n\n## 基本信息\n`;
  body = body.replace(header, (_, label, oldFields) => {
    const known = new RegExp(`^[-*]\\s+(?:${Object.keys(fields).join("|")})[：:]`, "m");
    const extras = oldFields.split(/\r?\n/).filter((row) => !known.test(row)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const rows = Object.entries(fields).map(([key, value]) => `- ${key}：${line(value)}`).join("\n");
    return `${label}\n${rows}${extras ? `\n${extras}` : ""}\n`;
  });
  const current = `<!-- workbench-summary:begin -->\n## 工作台状态\n\n- 当前步骤：${line(task.nextAction)}\n- 工作台修订：${task.revision}\n- 发布目标：${task.publications.filter((item) => item.state === "published").length} 项已登记\n\n### 工作台交接与操作\n\n${task.history.map((event) => `- ${event.at}｜${event.action}｜${employees[event.from] || "用户"} → ${employees[event.to]}｜${event.status}${event.note ? `｜${line(event.note)}` : ""}`).join("\n")}\n<!-- workbench-summary:end -->`;
  const stored = Buffer.from(JSON.stringify(task), "utf8").toString("base64");
  return `${body.trimEnd()}\n\n${current}\n\n<!-- workbench-state-v1 ${stored} -->\n`;
}

function mergeStage(task, data) {
  if (data === undefined) return;
  task.stages[task.stage].data = { ...task.stages[task.stage].data, ...record(data, "工作区内容") };
}

function handoffDetails(task, from, change) {
  const output = task.stages[from].data;
  return {
    confirmedFacts: change.confirmedFacts ?? output.confirmedFacts ?? output.facts ?? "",
    inferences: change.inferences ?? output.inferences ?? "",
    unverified: change.unverified ?? output.unverified ?? "",
    sources: change.sources ?? output.sources ?? task.legacyInfo?.sources ?? "",
    deliverables: change.deliverables ?? output.deliverables ?? assetPaths(output).join("、"),
    nextAction: task.nextAction,
    blocking: change.blocking ?? "",
    requiresUserConfirmation: task.stage === "analytics"
  };
}

function move(task, stage) {
  task.stages[task.stage].state = "completed";
  task.stage = task.owner = stage;
  task.stages[stage].state = "active";
  task.status = statusForStage[stage];
  task.nextAction = nextForStage[stage];
}

function activePublications(task) {
  return task.publications.filter((item) => item.version === task.version);
}

function unresolved(task) {
  return activePublications(task).some((item) => pendingPublish.has(item.state));
}

function clearApproval(task) {
  check(!unresolved(task), "有发布结果待核实，核实后再变更发布版本", 409);
  task.batch = null;
  task.approval = null;
}

function amendTask(task, change) {
  const published = task.stage === "analytics" && activePublications(task).some((item) => item.state === "published");
  const notesOnly = change.title === undefined && Object.keys(change.data || {}).every((key) => ["retro", "notes"].includes(key));
  check(!published || notesOnly, "已发布版本有正式记录，请通过新版本修改发布内容", 409);
  mergeStage(task, change.data);
  if (change.title !== undefined) task.title = required(change.title, "标题");
  if (change.nextAction !== undefined) task.nextAction = required(change.nextAction, "下一步");
  if (task.stage === "research" && !task.topicConfirmation &&
      [task.stages.research.data.body, task.stages.research.data.content].some((value) => typeof value === "string" && value.trim())) {
    task.status = "AWAITING_TOPIC_CONFIRMATION";
    task.nextAction = change.nextAction || "确认选题与写作方向";
  }
  if (task.stage === "writing" && task.status === "NEEDS_INPUT") {
    task.status = "CONFIRMED";
    task.nextAction = change.nextAction || nextForStage.writing;
  }
  if (task.stage === "analytics" && task.batch && !published) {
    clearApproval(task);
    task.status = "DRAFTED";
    task.nextAction = nextForStage.analytics;
  }
}

function assetPaths(data) {
  const paths = Array.isArray(data.assets) ? data.assets.map((asset) => typeof asset === "string" ? asset : asset?.path || asset?.file) : [];
  return [data.videoPath, data.file, ...paths].filter((value) => typeof value === "string" && value.trim());
}

async function handoff(task, change, root) {
  mergeStage(task, change.data);
  const data = task.stages[task.stage].data;
  check(Object.keys(data).length > 0 || task.legacy, "请先保存本工作区的交接产物", 409);
  if (task.stage === "research") {
    check(task.topicConfirmation || task.status === "CONFIRMED", "请先确认选题与写作方向", 409);
  }
  if (task.stage === "writing" && (!task.legacy || Object.keys(data).length)) {
    check([data.script, data.draft, data.content, data.text].some((value) => typeof value === "string" && value.trim()), "交接前请保存实际文案正文", 409);
  }
  if (task.stage === "editing") {
    const outputs = assetPaths(data);
    check(data.verified === true && outputs.length, "交接前请核验并登记实际成片", 409);
    const files = await Promise.all(outputs.map((file) => stat(path.resolve(root, file)).catch(() => null)));
    check(files.some((file) => file?.isFile() && file.size > 0), "核验成片不存在或为空", 409);
  }
  const next = {
    research: "writing", writing: task.format === "video" ? "editing" : "analytics", editing: "analytics"
  }[task.stage];
  check(next && (!change.toStage || change.toStage === next), "该工作区无法执行此交接", 409);
  move(task, next);
}

function revise(task, change, at) {
  const next = stageName(change.toStage || task.stage);
  const start = WORKFLOW_STAGES.indexOf(next);
  check(start <= WORKFLOW_STAGES.indexOf(task.stage), "请选择当前或已经经过的工作区", 409);
  const note = required(change.note, "修改原因");
  const archive = {
    version: task.version, at, note, title: task.title, stages: structuredClone(task.stages),
    topicConfirmation: task.topicConfirmation, batch: task.batch, approval: task.approval
  };
  clearApproval(task);
  task.versions.push(archive);
  task.version = `v${Number(task.version.match(/^v(\d+)/)?.[1] || 1) + 1}`;
  for (const key of WORKFLOW_STAGES.slice(start)) {
    task.stages[key] = { state: key === next ? "active" : "pending", data: key === next ? task.stages[key].data : {} };
  }
  if (next === "editing") delete task.stages.editing.data.verified;
  if (next === "research") task.topicConfirmation = null;
  task.stage = task.owner = next;
  task.status = statusForStage[next];
  task.nextAction = nextForStage[next];
}

function normalizeTarget(value, task, options = {}) {
  const target = record(value, "发布目标");
  const platform = required(target.platform, "平台");
  check(Object.hasOwn(platformHosts, platform), "发布平台无效");
  const file = typeof target.file === "string" ? target.file.trim() : "";
  const content = typeof target.content === "string" ? target.content.trim() : "";
  check(options.registration || (task.format === "text" ? content : file), "请选择该目标要发布的正文或素材");
  return {
    id: randomUUID(), platform, account: required(target.account, "账号"), title: required(target.title, "平台标题"),
    assetId: line(target.assetId), file, content, cover: typeof target.cover === "string" ? target.cover.trim() : "", description: String(target.description || "").trim(),
    tags: Array.isArray(target.tags) ? target.tags.map(line).filter(Boolean) : line(target.tags).split(/[,，]/).map(line).filter(Boolean),
    visibility: line(target.visibility) || "public", autoCollect: platform === "x" && target.autoCollect === true, publishAt: target.publishAt ? time(target.publishAt, "计划发布时间") : null
  };
}

async function fileFingerprint(root, file) {
  if (!file) return null;
  const resolvedPath = path.resolve(root, file);
  const info = await stat(resolvedPath).catch(() => null);
  check(info?.isFile() && info.size > 0, `发布素材不存在或为空：${file}`, 409);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(resolvedPath)) hash.update(bytes);
  return hash.digest("hex");
}

async function targetFingerprints(root, target) {
  const [file, cover] = await Promise.all([fileFingerprint(root, target.file), fileFingerprint(root, target.cover)]);
  return { file, cover };
}

function publishDigest(task) {
  return createHash("sha256").update(JSON.stringify([task.id, task.version, task.batch])).digest("hex");
}

function targetOf(task, id) {
  const target = task.batch?.targets.find((item) => item.id === id);
  check(target, "找不到当前发布目标", 404);
  return target;
}

function publicationOf(task, id) {
  const publication = activePublications(task).find((item) => item.targetId === id);
  check(publication, "找不到当前版本的发布记录", 404);
  return publication;
}

async function preparePublish(task, change, _at, root) {
  const prediction = change.prediction;
  const predictionBody = isObject(prediction) ? prediction.body : prediction;
  const previewOnly = change.previewOnly === true;
  if (!previewOnly) required(predictionBody, "发布前预测");
  check(Array.isArray(change.targets) && change.targets.length, "至少需要一个发布目标");
  check(!activePublications(task).some((item) => item.state === "published"), "当前版本已有发布记录，请通过新版本调整发布包", 409);
  clearApproval(task);
  const targets = change.targets.map((target) => normalizeTarget(target, task));
  for (const target of targets) {
    if (target.file) target.file = path.resolve(root, target.file);
    if (target.cover) target.cover = path.resolve(root, target.cover);
  }
  const unique = new Set(targets.map((item) => JSON.stringify([item.platform, item.account, item.assetId || item.file || item.content])));
  check(unique.size === targets.length, "发布目标不能重复");
  await Promise.all(targets.map(async (target) => { target.fingerprints = await targetFingerprints(root, target); }));
  task.batch = { id: randomUUID(), targets, prediction: previewOnly ? null : prediction, previewOnly };
  task.status = "AWAITING_PUBLISH_CONFIRMATION";
  task.nextAction = "核对成片、封面、平台、账号与时间后确认发布";
}

function approvePublish(task, change, at) {
  check(task.batch && change.batchId === task.batch.id, "发布包已变化，请重新检查", 409);
  check(task.batch.previewOnly !== true, "当前批次仅用于预览；建立正式发布预测并重新准备发布包后才能确认", 409);
  check(!task.approval, "此发布包已确认", 409);
  task.approval = { batchId: task.batch.id, version: task.version, digest: publishDigest(task), at, confirmation: required(change.confirmation, "发布确认") };
  task.nextAction = "按平台执行已确认发布，或登记真实结果";
}

async function beginPublish(task, change, at, root) {
  check(task.approval && task.approval.batchId === task.batch?.id && task.approval.digest === publishDigest(task), "请先确认当前版本的发布包", 409);
  const target = targetOf(task, change.targetId);
  check(JSON.stringify(await targetFingerprints(root, target)) === JSON.stringify(target.fingerprints), "发布文件自预览后已变更，请重新准备和确认", 409);
  let publication = activePublications(task).find((item) => item.targetId === target.id);
  if (publication) {
    check(publication.state === "failed" && publication.confirmedUnpublished === true, "此目标已有发布尝试，请先核实结果", 409);
  } else {
    publication = { targetId: target.id, version: task.version, target, attempts: [], snapshots: [] };
    task.publications.push(publication);
  }
  publication.state = "in_progress";
  publication.confirmedUnpublished = false;
  delete publication.reason;
  publication.attempts.push({ id: randomUUID(), at, state: "in_progress" });
  task.nextAction = "等待平台回执，保留当前发布尝试编号";
}

function postUrl(value, platform) {
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch { throw new WorkflowError(400, "作品链接格式无效"); }
  check(url.protocol === "https:" && !url.username && !url.password, "请使用平台的 HTTPS 作品链接");
  check(platformHosts[platform].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)), "作品链接与目标平台不匹配");
  check(url.pathname !== "/", "请输入具体作品链接");
  return url.href;
}

function postIdInUrl(url, platform) {
  if (!url) return "";
  const patterns = {
    x: /\/status\/(\d+)(?:\/|$)/,
    douyin: /\/video\/(\d+)(?:\/|$)/,
    xiaohongshu: /\/(?:explore|discovery\/item)\/([a-f\d]+)(?:\/|$)/i,
    bilibili: /\/video\/(BV[a-z\d]+)(?:\/|$)/i
  };
  const matched = patterns[platform]?.exec(new URL(url).pathname)?.[1];
  if (platform === "x") check(matched, "请提供具体的 X 帖子链接");
  return matched || "";
}

function receipt(task, publication, change, at) {
  const url = postUrl(change.url, publication.target.platform);
  const urlId = postIdInUrl(url, publication.target.platform);
  const platformPostId = line(change.platformPostId) || urlId;
  check(!(urlId && platformPostId !== urlId), "作品链接和作品 ID 不一致");
  check(url || platformPostId, "请提供真实平台作品链接或作品 ID");
  const publishedAt = time(change.publishedAt, "实际发布时间");
  check(publishedAt <= at, "发布时间仍在未来，请等待真实发布回执");
  const duplicate = task.publications.some((item) => item !== publication && item.state === "published"
    && item.target.platform === publication.target.platform
    && ((platformPostId && item.platformPostId === platformPostId) || (url && item.url === url)));
  check(!duplicate, "此平台作品已经登记", 409);
  publication.state = "published";
  delete publication.reason;
  delete publication.confirmedUnpublished;
  Object.assign(publication, { platformPostId, url, publishedAt, retroDueAt: new Date(Date.parse(publishedAt) + 3 * 86_400_000).toISOString() });
  task.status = "AWAITING_DATA";
  task.nextAction = "按发布时间查看 T+3 数据，并补齐其他平台回执";
}

function recordPublish(task, change, at) {
  const publication = publicationOf(task, change.targetId);
  const attempt = publication.attempts.at(-1);
  check(attempt && attempt.id === change.attemptId && pendingPublish.has(publication.state), "发布尝试已结束或编号无效", 409);
  check(["published", "unknown", "failed", "scheduled"].includes(change.state), "平台回执状态无效");
  if (change.state === "published") receipt(task, publication, change, at);
  else {
    const reason = required(change.reason, "平台回执或核实依据");
    const failed = change.state === "failed" && change.confirmedUnpublished === true;
    publication.state = failed ? "failed" : change.state === "scheduled" ? "scheduled" : "unknown";
    publication.confirmedUnpublished = failed;
    publication.reason = reason;
    task.nextAction = failed ? "可单独重试确认失败的平台" : "先核实平台是否已发布，再决定是否重试";
  }
  Object.assign(attempt, { state: publication.state, updatedAt: at, reason: line(change.reason) });
}

function registerPublish(task, change, at) {
  const target = change.target?.id && task.batch
    ? targetOf(task, change.target.id) : normalizeTarget(change.target, task, { registration: true });
  check(!activePublications(task).some((item) => item.targetId === target.id && item.state !== "failed"), "此发布目标已登记或仍待核实", 409);
  check(!activePublications(task).some((item) => pendingPublish.has(item.state) && item.target.platform === target.platform && item.target.account === target.account), "该平台账号已有待核实的尝试，请将回执录入原记录", 409);
  const existing = activePublications(task).find((item) => item.targetId === target.id);
  const publication = existing || { targetId: target.id, version: task.version, target, attempts: [], snapshots: [] };
  receipt(task, publication, change, at);
  publication.origin = "manual";
  if (!existing) task.publications.push(publication);
}

function skipPublish(task, change, at) {
  const target = targetOf(task, change.targetId);
  const existing = activePublications(task).find((item) => item.targetId === target.id);
  check(!existing || existing.state === "failed", "已有发布或待核实的目标不能略过", 409);
  const reason = required(change.reason, "略过原因");
  if (existing) Object.assign(existing, { state: "skipped", reason, skippedAt: at });
  else task.publications.push({ targetId: target.id, version: task.version, target, attempts: [], snapshots: [], state: "skipped", reason, skippedAt: at });
  task.nextAction = "继续核对其余发布目标或平台数据";
}

function recordMetrics(task, change, at) {
  const publication = publicationOf(task, change.targetId);
  check(publication.state === "published", "请先登记真实发布回执", 409);
  const snapshot = record(change.snapshot, "数据快照");
  check(snapshot.platform === publication.target.platform, "数据快照的平台与发布作品不一致");
  check(!(snapshot.content_id && snapshot.content_id !== task.id) && !(snapshot.version && snapshot.version !== publication.version), "数据快照的内容编号或版本不一致");
  const snapshotUrl = postUrl(snapshot.url ?? snapshot.platform_url, snapshot.platform);
  const snapshotUrlId = postIdInUrl(snapshotUrl, snapshot.platform);
  const snapshotId = line(snapshot.platformPostId ?? snapshot.platform_post_id) || snapshotUrlId;
  check(!(snapshotUrlId && snapshotId !== snapshotUrlId), "数据快照的链接和作品 ID 不一致");
  const sameId = publication.platformPostId && snapshotId === publication.platformPostId;
  const sameUrl = publication.url && snapshotUrl === publication.url;
  check(!(publication.platformPostId && snapshotId && !sameId) && (sameId || sameUrl), "数据快照未匹配已登记的平台作品");
  const collectedAt = time(snapshot.collectedAt ?? snapshot.collected_at, "采集时间");
  check(collectedAt >= publication.publishedAt && collectedAt <= at, "采集时间必须位于发布后与当前时间之间");
  const metrics = record(snapshot.metrics, "指标");
  const supported = ["views", "impressions", "likes", "comments", "shares", "favorites", "followers_gained", "completion_rate", "average_watch_seconds", "profile_clicks", "leads", "engagements"];
  check(supported.some((key) => typeof metrics[key] === "number"), "快照至少需要一个实际观测指标");
  check(Object.values(metrics).every((metric) => metric === null || (typeof metric === "number" && Number.isFinite(metric) && metric >= 0)), "指标须为非负数字或空值");
  check(metrics.completion_rate == null || metrics.completion_rate <= 1, "完播率请填写 0 至 1 之间的数值");
  const source = required(snapshot.source ?? snapshot.source_type, "数据来源");
  check(![snapshot, snapshot.raw].some((item) => item?.source_type === "example" || item?.synthetic), "示例快照不能用于正式复盘");
  check(!publication.snapshots.some((item) => item.collectedAt === collectedAt && item.source === source), "此来源的采集时间点已登记", 409);
  publication.snapshots.push({ id: randomUUID(), at, collectedAt, source, metrics, raw: snapshot });
  if (task.status !== "RETRO_DONE") {
    task.status = "AWAITING_DATA";
    task.nextAction = "检视真实指标，完成 01/02 回流";
  }
}

function completeRetro(task, change, at) {
  const publications = activePublications(task);
  const published = publications.filter((item) => item.state === "published");
  check(published.length && published.every((item) => item.snapshots.length), "每项实际发布作品都需要真实指标后才能复盘", 409);
  check(!unresolved(task), "请先核对仍待确认的平台发布结果", 409);
  check(!task.batch?.targets.some((target) => !publications.some((item) => item.targetId === target.id)), "请先处理发布包中尚未执行的目标", 409);
  check(!task.feedback.some((item) => item.version === task.version), "当前版本已经完成复盘", 409);
  task.feedback.push({
    at, version: task.version, publicationIds: published.map((item) => item.targetId),
    summary: required(change.summary, "复盘结论"), research: required(change.research, "选题反馈"),
    writing: required(change.writing, "文案反馈"), nextExperiment: required(change.nextExperiment, "下一轮实验")
  });
  task.status = "RETRO_DONE";
  task.stages.analytics.state = "completed";
  task.nextAction = "查看选题和文案回流，或归档";
}

const analyticsActions = {
  prepare_publish: preparePublish, approve_publish: approvePublish, begin_publish: beginPublish,
  record_publish: recordPublish, register_publish: registerPublish, skip_publish: skipPublish,
  record_metrics: recordMetrics, complete_retro: completeRetro
};

async function applyChange(task, change, at, root) {
  check(!terminal.has(task.status), "此任务已结束，请建立新任务", 409);
  const action = change.action;
  if (Object.hasOwn(analyticsActions, action)) {
    check(task.stage === "analytics", "此操作由发布与数据工作区执行", 409);
    check(task.status !== "RETRO_DONE" || action === "record_metrics", "复盘完成后请先创建新版本", 409);
    await analyticsActions[action](task, change, at, root);
  } else if (action === "save") {
    check(task.status !== "RETRO_DONE", "复盘完成后请先创建新版本", 409);
    amendTask(task, change);
  } else if (action === "request_input") {
    check(task.stage === "writing" || (task.stage === "research" && !task.topicConfirmation), "当前工作区不支持发起补充资料请求", 409);
    task.status = "NEEDS_INPUT";
    task.nextAction = required(change.note, "所需资料");
  } else if (action === "confirm_topic") {
    check(task.stage === "research" && !task.topicConfirmation, "选题已确认或当前不在研究工作区", 409);
    task.topicConfirmation = { at, confirmation: required(change.confirmation, "选题确认") };
    task.status = "CONFIRMED";
    task.nextAction = "交给文案制作";
  } else if (action === "handoff") {
    await handoff(task, change, root);
  } else if (action === "revise") {
    revise(task, change, at);
  } else if (action === "reject") {
    check(task.stage === "research" && !task.topicConfirmation, "只能否决尚未确认的选题", 409);
    task.status = "REJECTED";
    task.nextAction = required(change.note, "否决原因");
  } else if (action === "archive") {
    check(task.status === "RETRO_DONE", "完成真实数据复盘后才能归档", 409);
    task.status = "ARCHIVED";
    task.nextAction = "已归档";
  } else {
    throw new WorkflowError(400, "工作流操作无效");
  }
}

async function readOptional(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withProjectLock(root, operation) {
  const lockDir = path.join(root, "ai-ip-workbench", "data");
  await mkdir(lockDir, { recursive: true });
  const lock = new DatabaseSync(path.join(lockDir, "workflow-lock.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout = 2000");
    try { lock.exec("BEGIN IMMEDIATE"); }
    catch (error) {
      if (error.errcode === 5 || error.errcode === 6) throw new WorkflowError(409, "另一个工作台正在保存，请稍后刷新");
      throw error;
    }
    const result = await operation();
    lock.exec("COMMIT");
    return result;
  } finally {
    lock.close();
  }
}

function serialize(root, operation) {
  const previous = queues.get(root) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => withProjectLock(root, operation));
  queues.set(root, current);
  return current.finally(() => { if (queues.get(root) === current) queues.delete(root); });
}

export class WorkflowStore {
  constructor({ projectRoot, now = () => new Date() }) {
    this.root = path.resolve(projectRoot);
    this.records = path.join(this.root, "运行状态", "任务记录");
    this.now = now;
  }

  file(id) {
    check(typeof id === "string" && contentId.test(id), "任务编号无效");
    return path.join(this.records, `${id}.md`);
  }

  async get(id) {
    const body = await readOptional(this.file(id));
    check(body, "找不到任务", 404);
    return { ...parseTask(id, body), recordPath: this.file(id) };
  }

  async list(options = {}) {
    const filter = typeof options === "string" ? options : options.stage;
    if (filter) stageName(filter);
    const entries = await readdir(this.records).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const ids = entries.filter((entry) => entry.endsWith(".md") && contentId.test(entry.slice(0, -3))).map((entry) => entry.slice(0, -3));
    const tasks = await Promise.all(ids.map((id) => this.get(id)));
    return tasks.filter((task) => !filter || task.stage === filter).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  }

  async feedback(stage) {
    check(stage === "research" || stage === "writing", "只有选题和文案工作区接收复盘回流");
    return (await this.list()).flatMap((task) => task.feedback.map((item) => ({
      taskId: task.id, title: task.title, version: item.version, at: item.at, text: item[stage], nextExperiment: item.nextExperiment
    }))).sort((a, b) => b.at.localeCompare(a.at));
  }

  async create(payload) {
    return serialize(this.root, async () => {
      const { title, goal, entryStage = "research", format = "video", inputs = {} } = record(payload, "新建任务");
      const at = new Date(this.now());
      const prefix = `CONTENT-${shanghaiDate(at)}-`;
      const tasks = await this.list();
      const next = Math.max(0, ...tasks.filter((task) => task.id.startsWith(prefix)).map((task) => Number(task.id.slice(-2)))) + 1;
      check(next <= 99, "当日内容编号已用完", 409);
      const id = prefix + String(next).padStart(2, "0");
      check(formats.has(format), "内容形式无效");
      const task = newTask({ id, title: required(title, "标题"), goal: typeof goal === "string" ? goal.trim() : "", stage: stageName(entryStage), format, inputs: record(inputs, "来源输入"), at: at.toISOString() });
      task.history.push({ at: task.createdAt, action: "create", to: task.stage, status: task.status, version: task.version });
      await atomicWrite(this.file(task.id), taskMarkdown(task, ""));
      return this.afterWrite(task);
    });
  }

  async update(id, payload) {
    return serialize(this.root, async () => {
      const body = await readOptional(this.file(id));
      check(body, "找不到任务", 404);
      const task = parseTask(id, body);
      const change = record(payload, "工作流更新");
      check(Number.isInteger(change.revision) && change.revision === task.revision, "任务已更新，请刷新后重试", 409);
      if (body.includes("<!-- workbench-state-v1 ")) {
        check(markdownField(body, "current_status") === task.status && markdownField(body, "version") === task.version
          && markdownField(body, "owner_employee") === employees[task.owner], "任务状态已在工作台外修改，请核对任务文件", 409);
      }
      const at = new Date(this.now()).toISOString();
      const from = task.stage;
      await applyChange(task, change, at, this.root);
      task.revision += 1;
      task.updatedAt = at;
      const handoff = change.action === "handoff" ? handoffDetails(task, from, change) : undefined;
      task.history.push({ at, action: change.action, from, to: task.stage, status: task.status, version: task.version, revision: task.revision, note: line(change.note ?? change.reason), handoff });
      await atomicWrite(this.file(id), taskMarkdown(task, body));
      return this.afterWrite(task);
    });
  }

  async afterWrite(task) {
    const result = { ...task, recordPath: this.file(task.id) };
    try { await this.syncViews(); }
    catch (error) { result.syncWarning = `任务已保存，共享索引待同步：${error.message}`; }
    return result;
  }

  async syncViews() {
    const tasks = (await this.list()).filter((task) => task.history.length);
    const stateDir = path.join(this.root, "运行状态");
    const indexFile = path.join(stateDir, "当前任务.md");
    const oldIndex = await readOptional(indexFile);
    const active = tasks.filter((task) => !terminal.has(task.status));
    const lines = active.map((task) => `- ${task.id}｜${line(task.title)}｜${task.status}｜${employees[task.owner]}｜${line(task.nextAction)}`);
    const indexHead = oldIndex.replace(indexSection, "\n").trimEnd() || "# 当前任务索引";
    const index = `${indexHead}\n\n<!-- workbench-index:begin -->\n## 工作台管理任务\n\n${lines.join("\n")}\n<!-- workbench-index:end -->\n`;
    if (index !== oldIndex) await atomicWrite(indexFile, index);

    const handoffFile = path.join(stateDir, "交接记录.md");
    const oldHandoffs = await readOptional(handoffFile);
    const handoffs = tasks.flatMap((task) => task.history.filter((event) => event.action === "handoff").map((event) => {
      const key = `<!-- ${task.id}:${event.revision} -->`;
      if (oldHandoffs.includes(key)) return "";
      const detail = event.handoff;
      const summary = [`${key}\n- ${event.at}｜${task.id}/${event.version}｜${employees[event.from]} → ${employees[event.to]}｜${event.status}${event.note ? `｜${line(event.note)}` : ""}`];
      if (detail) {
        summary.push(`  - 已确认事实：${displayDetail(detail.confirmedFacts)}`, `  - 推断：${displayDetail(detail.inferences)}`,
          `  - 待验证：${displayDetail(detail.unverified)}`, `  - 来源：${displayDetail(detail.sources)}`,
          `  - 交付：${displayDetail(detail.deliverables) || this.file(task.id)}`, `  - 下一步：${detail.nextAction}`,
          `  - 阻塞：${displayDetail(detail.blocking)}`, `  - 需要用户确认：${detail.requiresUserConfirmation ? "是" : "否"}`);
      }
      return summary.join("\n");
    })).filter(Boolean);
    if (handoffs.length) await atomicWrite(handoffFile, `${oldHandoffs.trimEnd() || "# 交接记录"}\n\n${handoffs.join("\n\n")}\n`);
    await this.syncMetrics(tasks);
  }

  async syncMetrics(tasks) {
    const dataDir = path.join(this.root, "数据飞轮");
    const ledgerFile = path.join(dataDir, "发布数据台账.md");
    const oldLedger = await readOptional(ledgerFile);
    const rows = [];
    for (const task of tasks) {
      for (const publication of task.publications.filter((item) => item.state === "published")) {
        const key = `<!-- workbench:${task.id}:${publication.targetId} -->`;
        if (!oldLedger.includes(key)) {
          rows.push(`${key}\n- ${task.id}/${publication.version}｜${publication.target.platform}｜${line(publication.target.title)}｜${publication.publishedAt}｜${publication.url || publication.platformPostId}`);
        }
        for (const snapshot of publication.snapshots) {
          const file = path.join(dataDir, "采集记录", task.id, `${publication.target.platform}-${snapshot.id}.json`);
          if (!(await readOptional(file))) {
            const data = { ...snapshot.raw, content_id: task.id, version: publication.version, platform: publication.target.platform };
            await atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
          }
          const snapshotKey = `<!-- workbench:${task.id}:${snapshot.id} -->`;
          if (!oldLedger.includes(snapshotKey)) rows.push(`${snapshotKey}\n- ${task.id}/${publication.version}｜${publication.target.platform}｜数据采集 ${snapshot.collectedAt}｜${line(snapshot.source)}｜${path.relative(this.root, file)}`);
        }
      }
      for (const feedback of task.feedback) {
        const key = `<!-- workbench:${task.id}:${feedback.version}:retro -->`;
        if (!oldLedger.includes(key)) rows.push(`${key}\n- ${task.id}/${feedback.version}｜复盘 ${feedback.at}｜${line(feedback.summary)}｜下一轮：${line(feedback.nextExperiment)}`);
      }
    }
    if (rows.length) await atomicWrite(ledgerFile, `${oldLedger.trimEnd() || "# 发布数据台账"}\n\n${rows.join("\n\n")}\n`);
  }
}

function displayDetail(value) {
  return line(typeof value === "object" ? JSON.stringify(value) : value);
}
