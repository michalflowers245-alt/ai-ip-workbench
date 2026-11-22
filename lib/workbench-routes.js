import path from "node:path";
import { createReadStream } from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { WorkflowStore } from "./workflow-store.js";
import { createTrendMonitor } from "./trend-monitor.js";
import { verifyResearchSources } from "./research-evidence.js";
import { createWorkflowTools } from "./workflow-tools.js";

const configs = {
  research: "01-热点与竞品研究员.md",
  writing: "02-文案制作.md",
  editing: "03-剪辑.md",
  analytics: "04-数据分析.md"
};

const skillInputs = {
  research: ["trend-and-competitor-research", "dbs-good-question", "dbs-benchmark", "cheat-recommend"],
  writing: ["short-video-script-director", "dbs-content", "dbs-hook", "dbs-ai-check", "dbs-script-flow", "cheat-score"],
  editing: ["space-video-edit", "video-editor"],
  analytics: ["publishing-and-performance-review", "cheat-predict"]
};

const instructions = {
  research: "提出可拍选题和角度，标明未知事实。来源证据按编号提供。正文原句才可引用。社区评论只支持讨论观察，转载和报道保留归因，诉讼指控不得写成裁定。热榜标题、报道摘要和采集时间各有自己的口径。把支撑事实候选的原句原样写进 claims 的 {claim,sourceId,quote}，没有正文则留空。把核心前提缺口集中放在 needsInput 数组。输出 {title,body,claims,needsInput}。",
  writing: "写可独立成立、可读出口的中文文案。主体给出一个可验证的具体案例。上游选题草稿是建议，引用事实以给出的原文为准。保留报道归因、官方声明范围和个人材料边界。未知时间、评论和热榜不得当作事件事实，诉讼指控不得写成裁定。用 JSON 输出 {title,body,hook,cover,shots,teleprompter,needsInput}，shots 是可读的拍摄清单文字。",
  editing: "根据真实转写给删改候选。句意不明确时保留。仅输出 JSON {cuts:[{start,end,reason}],body}，时间使用输入中秒单位，疑似口误或重复才推荐。用户决定是否使用。",
  analytics: "写发布前核验和平台预览。只引用 01 已复核为 supported 或 qualified 的事实，并保留限定。没有真实发布指标时不得写成表现分析，也不得给无基线的播放、互动、转粉数字。用户只要求预览时，不建立正式预测。用 JSON 输出 {title,body,research,writing,nextExperiment,description}。"
};

function stageSchema(role) {
  const names = {
    research: ["title", "body"],
    writing: ["title", "body", "hook", "cover", "shots", "teleprompter"],
    editing: ["body"],
    analytics: ["title", "body", "research", "writing", "nextExperiment", "description"]
  }[role];
  const properties = Object.fromEntries(names.map((name) => [name, { type: "string" }]));
  if (role === "research" || role === "writing") properties.needsInput = { type: "array", items: { type: "string" } };
  if (role === "research") properties.claims = { type: "array", items: {
    type: "object", properties: { claim: { type: "string" }, sourceId: { type: "string" }, quote: { type: "string" } },
    required: ["claim", "sourceId", "quote"], additionalProperties: false
  } };
  if (role === "editing") properties.cuts = { type: "array", items: {
    type: "object", properties: { start: { type: "number" }, end: { type: "number" }, reason: { type: "string" } },
    required: ["start", "end", "reason"], additionalProperties: false
  } };
  return { type: "object", properties, required: role === "editing" ? ["cuts"] : ["body"], additionalProperties: false };
}

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseModel(text) {
  const raw = text.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw error(422, "本机模型没有返回需要的结构，请重试或手工填写。");
}

function slim(value, limit = 7200) {
  return JSON.stringify(value ?? "").slice(0, limit);
}

function researchLinks(task, sourceText) {
  const pasted = (sourceText.match(/https:\/\/[^\s<>"“”。，；、】）]+/g) || [])
    .map((url) => url.replace(/[)\]!?.,;]+$/, ""));
  const discovered = Array.isArray(task.inputs?.sources) ? task.inputs.sources : [];
  const original = discovered.map((item) => typeof item === "string" ? item : item?.originalUrl || item?.url);
  const discussions = discovered.filter((item) => item?.sourceId === "hn").map((item) => item.sourceUrl);
  return [...pasted, ...original, ...discussions].filter(Boolean);
}

function browsedSources(sources) {
  return (Array.isArray(sources) ? sources : []).filter((source) => source.status === "read" &&
    typeof source.excerpt === "string" && source.excerpt && !sourceEvidenceIssue(source));
}

function sourceEvidenceIssue(source) {
  if (source.cache?.stale === true) return "来源明确返回过期缓存";
  if (Object.values(source.dateConflicts || {}).some((values) => Array.isArray(values) && values.length)) return "来源时间声明冲突";
  for (const field of ["publishedAt", "updatedAt", "checkedAt"]) {
    const value = source[field];
    if (value === undefined || value === null || value === "") continue;
    const timestamp = Date.parse(value);
    const day = typeof value === "string" && value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (!day || !Number.isFinite(timestamp) || new Date(day).toISOString().slice(0, 10) !== day) return "来源时间格式无效";
    // A date-only release can already be today in the publisher's local timezone.
    const future = value.length === 10 ? value > new Date(Date.now() + 14 * 60 * 60_000).toISOString().slice(0, 10)
      : timestamp > Date.now() + 5 * 60_000;
    if (future) return "来源声明了尚未到达的时间";
  }
  return "";
}

function modelMaterial(value, limit, sources) {
  const eligible = new Set(browsedSources(sources).map((source) => source.evidenceId));
  return JSON.stringify(value ?? "", (key, item) => {
    if (key === "claims" && Array.isArray(item)) return item.filter((claim) => eligible.has(claim?.sourceId));
    if (key !== "sourceChecks" || !Array.isArray(item)) return item;
    return item.map((source) => {
      const issue = sourceEvidenceIssue(source);
      if (source.sourceKind === "catalog") return { evidenceId: source.evidenceId, url: source.url, title: source.title,
        sourceKind: source.sourceKind, status: source.status, catalogOnly: true,
        evidenceExcluded: "热点索引/聚合页只用于发现和讨论度，不能用于事实主张" };
      if (!issue && source.status === "read") return source;
      return { evidenceId: source.evidenceId, url: source.url, status: source.status,
        evidenceExcluded: issue || "当前没有可核对正文" };
    });
  }).slice(0, limit);
}

function sourcePassages(source) {
  return source.passages?.length ? source.passages.map((passage) => passage.text) : [source.excerpt];
}

function exactSourceQuote(source, quote) {
  const normalize = (value) => String(value || "").trim().replace(/\s+/gu, " ");
  const normalized = normalize(quote);
  if (normalized.length >= 12 && sourcePassages(source).some((text) => normalize(text).includes(normalized))) return true;
  return source.sourceKind === "official" && source.passages?.some((passage) =>
    passage.source === "publisher:status" && normalize(passage.text) === normalized && normalized.length > 0);
}

function markResearchOrigins(checks) {
  const urls = new Map();
  const matchingText = new Map();
  return checks.map((check, index) => {
    const evidenceId = `E${index + 1}`;
    const url = check.canonicalUrl || check.url;
    const passages = check.status === "read" && check.sourceKind !== "community" ? sourcePassages(check).filter(Boolean) : [];
    const text = passages.slice(0, 2).join(" ").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const textKey = text.length >= 240 ? text : null;
    const sameUrl = urls.get(url);
    const sameText = textKey && matchingText.get(textKey);
    if (url && !sameUrl) urls.set(url, evidenceId);
    if (textKey && !sameText) matchingText.set(textKey, evidenceId);
    return { ...check, evidenceId, ...(sameUrl || sameText ? {
      duplicateOf: sameUrl || sameText, originMatch: sameUrl ? "same_url" : "matching_text"
    } : {}) };
  });
}

function evidencePrompt(data, { requireReviewed = false } = {}) {
  if (data.checkedSourceText !== undefined && data.sourceText !== data.checkedSourceText) return "";
  if (requireReviewed) {
    const reviewed = (data.claims || []).filter((claim) => ["supported", "qualified"].includes(claim.reviewStatus));
    const sources = new Map((data.sourceChecks || []).map((source) => [source.evidenceId, source]));
    return reviewed.map((claim) => {
      const source = sources.get(claim.sourceId);
      return `${claim.sourceId} · 已复核为${claim.reviewStatus === "supported" ? "直接支持" : "需保留限定"} · ${claim.reviewReason}\n主张：${claim.claim}\n原文：${claim.quote}\n来源：${source?.title || source?.url || ""}`;
    }).join("\n\n");
  }
  const eligible = browsedSources(data.sourceChecks).filter((source) => ["official", "publisher", "preprint", "community", "personal_statement"].includes(source.sourceKind));
  const ids = new Set(eligible.map((source) => source.evidenceId));
  const verified = eligible.filter((source) => !ids.has(source.duplicateOf));
  const ordered = [...verified.filter((item) => item.sourceKind === "official"), ...verified.filter((item) => ["publisher", "preprint", "community", "personal_statement"].includes(item.sourceKind))];
  return ordered.map((source) => {
    const { evidenceId, sourceKind, publisher, publishedAt } = source;
    const label = sourceKind === "community" ? "只用于讨论观察"
      : sourceKind === "personal_statement" ? "当事人原始声明，只证明其本人提出该主张"
      : sourceKind === "preprint" ? "学术预印本，只证明作者提出了该论证，尚待同行审查"
      : source.declaredAttribution ? "有明确上游归因的报道"
      : sourceKind === "publisher" ? "媒体报道，表述时保留归因" : "发布方原文";
    return [evidenceId, label, publisher, publishedAt || "发布时间未知，不据此判断为今日新事件", sourcePassages(source).join("\n").slice(0, 620)].filter(Boolean).join(" | ");
  }).join("\n");
}

function matchResearchQuotes(proposals, sources) {
  const cards = new Map(browsedSources(sources)
    .filter((item) => ["official", "publisher", "preprint", "personal_statement"].includes(item.sourceKind))
    .map((item) => [item.evidenceId, item]));
  const normalize = (value) => String(value || "").trim().replace(/\s+/gu, " ");
  const accepted = [];
  for (const proposal of (Array.isArray(proposals) ? proposals : []).slice(0, 12)) {
    const source = cards.get(proposal?.sourceId);
    const claim = normalize(proposal?.claim).slice(0, 250);
    const quote = normalize(proposal?.quote);
    if (!source || !claim || quote.length > 450 || !exactSourceQuote(source, quote)) continue;
    accepted.push({ claimId: `C${accepted.length + 1}`, claim, sourceId: source.evidenceId, quote,
      reviewStatus: "pending", reviewReason: "" });
  }
  return accepted;
}

function keepRanges(cuts, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw error(400, "请先检查素材时长。");
  const removed = [...cuts].map(({ start, end }) => {
    const from = Number(start);
    const to = Number(end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > duration || from >= to) {
      throw error(400, "删改区间需要在原片时长内，起点早于终点。");
    }
    return [from, to];
  }).sort((a, b) => a[0] - b[0]);
  const ranges = [];
  let cursor = 0;
  for (const [start, end] of removed) {
    if (start > cursor) ranges.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration) ranges.push({ start: cursor, end: duration });
  if (!ranges.length) throw error(400, "至少保留一段原片。");
  return ranges;
}

function coverSource(task) {
  return task.stages.editing?.data?.prepared?.sourcePath || mediaEntry(task, "final");
}

function mediaEntry(task, name) {
  const edit = task.stages.editing?.data || {};
  const files = {
    final: edit.asset?.filePath || edit.asset?.path || edit.asset?.outputPath || edit.asset?.videoPath || edit.asset?.sourcePath,
    working: edit.prepared?.sourcePath,
    cover: task.stages.analytics?.data?.cover?.coverPath || edit.cover?.path || edit.cover?.coverPath || edit.cover
  };
  if (typeof files[name] !== "string") throw error(404, "这个产物还未生成。");
  return files[name];
}

async function streamMedia(req, res, file) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw error(404, "产物文件无法读取。");
  const kinds = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
  const type = kinds[path.extname(file).toLowerCase()];
  if (!type) throw error(415, "此文件不能在工作台预览。");
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${info.size}` });
    return createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  return createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

const allowedUpdates = new Set([
  "save", "handoff", "request_input", "confirm_topic", "revise", "prepare_publish",
  "approve_publish", "register_publish", "record_publish", "record_metrics", "complete_retro", "archive", "skip_publish", "reject"
]);

export function createWorkbench({ projectRoot, dataDir, workerRoot, bodyJson, send, model, knowledge, monitorEnabled = true }) {
  const store = new WorkflowStore({ projectRoot: workerRoot || projectRoot });
  const tools = createWorkflowTools({ projectRoot, dataDir });
  const trends = createTrendMonitor({ dataDir });
  const pendingMedia = new Set();
  let collectionTimer;
  let collecting = false;

  async function collectDue() {
    if (collecting) return;
    collecting = true;
    try {
      const now = Date.now();
      for (const item of await store.list("analytics")) {
        if (["ARCHIVED", "RETRO_DONE"].includes(item.status)) continue;
        for (const target of item.publications) {
          if (target.target.platform !== "x" || !target.target.autoCollect || target.version !== item.version) continue;
          if (target.state !== "published" || Date.parse(target.retroDueAt) > now ||
              target.snapshots?.some((snapshot) => Date.parse(snapshot.collectedAt) >= Date.parse(target.retroDueAt))) continue;
          try {
            const task = await store.get(item.id);
            await execute(task, { action: "collect_metrics", targetId: target.targetId });
          } catch (cause) {
            console.warn("T+3 指标采集保留待办", item.id, target.targetId, cause.message);
          }
        }
      }
    } finally { collecting = false; }
  }

  function runCollection() {
    collectDue().catch((cause) => console.warn("T+3 指标回收暂不可用", cause.message));
  }

  function localSchedule(value) {
    if (!value) return undefined;
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(value));
    const { year, month, day, hour, minute } = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return year + "-" + month + "-" + day + " " + hour + ":" + minute;
  }

  async function readProject(file, cap = 9200) {
    return (await readFile(path.join(projectRoot, file), "utf8").catch(() => "")).slice(0, cap);
  }

  async function roleSkills(role, { previewOnly = false } = {}) {
    const config = await readProject(path.join("自媒体员工配置", configs[role]), 16_000);
    const allowed = new Set([...config.matchAll(/`([a-z0-9][a-z0-9-]+)`/g)].map((match) => match[1]));
    const selected = role === "analytics" && previewOnly
      ? ["publishing-and-performance-review"] : skillInputs[role];
    const unauthorized = selected.filter((name) => !allowed.has(name));
    if (unauthorized.length) throw new Error(`${role} 选择了白名单外的 Skill：${unauthorized.join(", ")}`);
    const documents = await Promise.all(selected.map(async (name) => {
      const file = path.join(os.homedir(), ".codex", "skills", name, "SKILL.md");
      const spec = await readFile(file, "utf8").catch(() => "");
      if (!spec) return { name, status: "missing", file };
      const source = spec.replace(/^  compatibility:.*\n/gm, "").trim();
      const digest = createHash("sha256").update(source).digest("hex");
      return { name, status: "loaded", file, digest, source };
    }));
    const missing = documents.filter((item) => item.status !== "loaded").map((item) => item.name);
    if (missing.length) throw new Error(`${role} 白名单 Skill 文件缺失，未执行模型任务：${missing.join(", ")}`);
    const text = documents.filter((item) => item.status === "loaded")
      .map(({ name, source }) => `\n### 已加载 Skill：${name}\n${source}`).join("\n");
    return { text, manifest: documents.map(({ name, status, file, digest }) => ({ name, status, file, digest })) };
  }

  async function skillTraceFor(role) {
    const bundle = await roleSkills(role);
    return { loadedAt: new Date().toISOString(), source: "员工白名单 SKILL.md", skills: bundle.manifest };
  }

  async function modelAction(task, action, provided = {}) {
    const role = task.stage;
    const recent = task.stages[role]?.data || {};
    const researchData = ["writing", "analytics"].includes(role) ? task.stages.research?.data || {} : provided;
    const sourceText = ["research", "writing", "analytics"].includes(role)
      ? evidencePrompt(researchData, { requireReviewed: role !== "research" }) : "";
    const prior = role === "writing" ? task.stages.research?.data?.body
      : role === "analytics" ? task.stages.writing?.data?.script : recent.body;
    const promptInputs = { ...task.inputs };
    delete promptInputs.stageData;
    const promptStages = structuredClone(task.stages);
    if (role === "analytics") {
      const research = promptStages.research?.data;
      if (research) {
        const reviewed = (research.claims || []).filter((claim) => ["supported", "qualified"].includes(claim.reviewStatus));
        const sourceIds = new Set(reviewed.map((claim) => claim.sourceId));
        research.claims = reviewed;
        research.sourceChecks = (research.sourceChecks || []).filter((source) => sourceIds.has(source.evidenceId));
      }
    }
    if (role === "writing") {
      for (const key of ["script", "body", "draft", "content", "text"]) delete promptStages.writing.data[key];
    }
    const compactInput = role === "editing" ? { transcript: provided.transcript }
      : role === "analytics"
        ? { previewOnly: provided.previewOnly === true, notes: provided.sourceText || provided.corrections || provided.requirements, metrics: provided.realMetrics }
        : { notes: provided.sourceText || provided.corrections || provided.requirements, metrics: provided.realMetrics };
    const currentDraft = role === "writing" ? provided.previousDraft ?? recent.script ?? recent.body : undefined;
    // Never shorten the draft itself: the response replaces it as a complete artifact.
    const revisionInput = role === "writing" ? `\n当前稿件（以此稿修改，保留未要求调整的内容）：\n${String(currentDraft ?? "")}\n本次修改要求：${String(provided.corrections || provided.requirements || "").slice(0, 800)}` : "";
    const evidence = ["research", "writing"].includes(role) ? `\n可引用的来源正文：${sourceText || "当前没有已读原文。用已知的用户素材提出角度，公开事实标待核。"}` : "";
    const bundle = await roleSkills(role, { previewOnly: role === "analytics" && provided.previewOnly === true });
    const config = await readProject(path.join("自媒体员工配置", configs[role]), 16_000);
    const sharedPosition = await readProject("账号定位同步卡.md", 6000);
    const skillTrace = { loadedAt: new Date().toISOString(), source: "员工白名单 SKILL.md", skills: bundle.manifest };
    const claimRules = role === "research"
      ? "每项事实候选都需要 sourceId 和逐字原句；新产生的候选初始为 pending。不得因原句被找到就判定其支持结论。\n"
      : ["writing", "analytics"].includes(role)
        ? "只使用 01 已复核为 supported 或 qualified 的事实主张；媒体归因不能改成独立事实。\n" : "";
    const contextSystem = `${instructions[role]}\n${claimRules}\n角色配置（唯一职责和白名单）：\n${config}\n共享定位：\n${sharedPosition}\n已加载 Skill 的完整指引：\n${bundle.text}\n只使用已提供材料，不编造事实、来源、实绩或授权。按阶段格式输出合法 JSON。`;
    const contextUser = `CONTENT-ID/version：${task.id}/${task.version}\n当前任务：${task.title}\n目标：${task.goal || ""}${evidence}\n输入：${modelMaterial(promptInputs, 16_000, researchData.sourceChecks)}\n之前产物：${modelMaterial(promptStages, 22_000, researchData.sourceChecks)}\n本次输入：${modelMaterial(role === "writing" ? { ...provided, previousDraft: undefined } : provided, 16_000, researchData.sourceChecks)}${revisionInput}\n相关资料：${slim(await knowledge(task.title, task.goal), 5000)}\n操作：${action}`;
    const text = await model({
      compact: {
        system: `${contextSystem}\n使用简体中文；按字段只输出一个 JSON 对象。关键材料不全时在 needsInput 中说明；请勿虚构事实或实绩。`,
        user: contextUser
      },
      json: true, schema: stageSchema(role), role,
      system: contextSystem,
      user: contextUser,
      skillTrace,
      maxTokens: role === "writing" ? 1600 : role === "analytics" ? 1500 : 1700
    });
    const answer = parseModel(text);
    if (typeof answer.body !== "string") {
      const alternate = [answer.content, answer.script, answer.summary].find((value) => typeof value === "string" && value.trim());
      if (alternate) answer.body = alternate;
    }
    if (["research", "writing", "analytics"].includes(role) && !answer.body?.trim() &&
        !(Array.isArray(answer.needsInput) && answer.needsInput.length)) {
      throw error(422, "模型未返回这一阶段的正文，可重试或手工填写。");
    }
    answer.skillTrace = skillTrace;
    return answer;
  }

  async function apply(task, action, payload = {}) {
    return store.update(task.id, { ...payload, action, revision: task.revision });
  }

  async function save(task, data) {
    return apply(task, "save", { data });
  }

  async function inspectResearch(task, input, { reuseRecent = false } = {}) {
    const current = task.stages.research?.data || {};
    const sourceText = String(input.sourceText ?? current.sourceText ?? task.inputs?.text ?? "").slice(0, 24_000);
    const previous = Array.isArray(current.sourceChecks) ? current.sourceChecks : [];
    const recent = reuseRecent && current.checkedSourceText === sourceText && previous.length > 0 &&
      previous.every((item) => item.evidenceId && Date.parse(item.checkedAt) >= Date.now() - 5 * 60_000);
    let sourceChecks = previous;
    if (!recent) {
      const snapshotRoot = path.join(dataDir, "research-source-snapshots", task.id, task.version);
      const checks = await verifyResearchSources(researchLinks(task, sourceText), { snapshotRoot });
      const byRequest = new Map(previous.map((item) => [item.requestedUrl || item.url, item]));
      sourceChecks = markResearchOrigins(checks).map((item) => {
        if (item.status !== "unavailable") return item;
        const older = byRequest.get(item.requestedUrl || item.url);
        const previousRead = older?.status === "read" && older.excerpt
          ? { excerpt: older.excerpt, url: older.excerptUrl || older.url, checkedAt: older.checkedAt }
          : older?.previousRead;
        return previousRead ? { ...item, previousRead } : item;
      });
    }
    const research = {
      sourceText, sourceChecks, checkedSourceText: sourceText,
      sources: sourceChecks.map(({ url, title, status }) => ({ url, title, status })),
      claims: matchResearchQuotes(current.claims, sourceChecks),
      claimReview: { complete: false, reviewedAt: null, reviewer: null }
    };
    return typeof input.body === "string" ? { ...research, body: input.body } : research;
  }

  async function execute(task, body) {
    const stage = task.stage;
    const edit = task.stages.editing?.data || {};
    if (body.action === "check_sources") {
      if (stage !== "research") throw error(409, "请在热点与竞品分析核对来源。");
      const research = await inspectResearch(task, body.input || {});
      if (!research.sourceChecks.length) throw error(400, "请粘贴一个 HTTPS 原文链接，或从榜单带入研究。");
      return save(task, research);
    }
    if (body.action === "review_claims") {
      if (stage !== "research") throw error(409, "主张复核只在热点与竞品分析工作台进行。");
      const current = task.stages.research?.data || {};
      if (!current.sourceChecks?.length || current.checkedSourceText !== current.sourceText) {
        throw error(409, "请先核对当前版本的原文来源，再复核主张。");
      }
      const decisions = new Map((Array.isArray(body.reviews) ? body.reviews : []).map((item) => [item.claimId, item]));
      const allowed = new Set(["supported", "qualified", "excluded"]);
      const matched = matchResearchQuotes(current.claims || [], current.sourceChecks);
      if (matched.length !== (current.claims || []).length) {
        throw error(409, "至少一条主张的来源或引文与已读原文不匹配，不能登记复核；先回到主张卡修正。 ");
      }
      const claims = (current.claims || []).map((claim) => {
        const decision = decisions.get(claim.claimId);
        if (!decision || !allowed.has(decision.status) || typeof decision.reason !== "string" || decision.reason.trim().length < 8) {
          throw error(400, `${claim.claimId} 需要选择复核结论，并写明至少 8 个字的证据理由。`);
        }
        return { ...claim, reviewStatus: decision.status, reviewReason: decision.reason.trim().slice(0, 600),
          reviewedAt: new Date().toISOString(), reviewer: "Codex · AI 辅助来源比对" };
      });
      return save(task, { claims, claimReview: { complete: true, reviewedAt: new Date().toISOString(), reviewer: "Codex · AI 辅助来源比对" } });
    }
    if (body.action === "generate") {
      if (!["research", "writing", "analytics"].includes(stage)) throw error(409, "请在剪辑台使用转写或导出。");
      if (stage === "analytics" && task.publications.some((item) => item.version === task.version && item.state === "published")) {
        throw error(409, "该作品已发布，可以回收指标并生成实绩复盘。");
      }
      const input = body.input || {};
      if (stage === "writing") {
        const researchData = task.stages.research?.data || {};
        if (researchData.claims?.some((claim) => claim.reviewStatus === "pending") ||
            (researchData.claims?.length && researchData.claimReview?.complete !== true)) {
          throw error(409, "研究主张还未完成逐条来源复核，不能进入文案生成。请先回到 01 完成复核。 ");
        }
      }
      const research = stage === "research" ? await inspectResearch(task, input, { reuseRecent: true }) : null;
      const readable = browsedSources(research?.sourceChecks).filter((source) => source.sourceKind !== "catalog");
      if (research?.sourceChecks.length && !readable.length) {
        const updated = await save(task, research);
        const hasExcluded = research.sourceChecks.some((source) => sourceEvidenceIssue(source));
        updated.researchNotice = hasExcluded
          ? "来源存在过期缓存或时间异常，暂不用于自动分析和出稿。已保留原链接及读取结果，请刷新或人工核对原文。"
          : "来源暂未取得可核对正文。已保留原链接、时间和读取结果。补充原文后可继续分析。";
        return updated;
      }
      let answer;
      let usedSkillTrace;
      try {
        answer = await modelAction(task, body.action, { ...input, ...research });
        usedSkillTrace = answer.skillTrace;
      } catch (cause) {
        if (!research) throw cause;
        const updated = await save(task, research);
        updated.researchNotice = "已保存来源核对结果。模型草稿未生成：" + cause.message;
        return updated;
      }
      if (stage === "writing" && typeof answer.body === "string") answer.script = answer.body;
      if (research) {
        research.claims = matchResearchQuotes(answer.claims, research.sourceChecks);
        research.claimReview = { complete: false, reviewedAt: null, reviewer: null };
        answer = Object.fromEntries(["title", "body", "needsInput", "modelOutputMode"].filter((key) => Object.hasOwn(answer, key)).map((key) => [key, answer[key]]));
        delete research.body;
      }
      const needsInput = Array.isArray(answer.needsInput) && answer.needsInput.length;
      let updated = await save(task, { ...answer, ...research, ...(usedSkillTrace ? { skillTrace: usedSkillTrace } : {}), generatedAt: new Date().toISOString() });
      if (needsInput) return apply(updated, "request_input", { note: answer.needsInput.join("\n") });
      if (stage === "research" && body.autoDraft === true && typeof answer.body === "string" && answer.body.trim()) {
        if (research.claimReview?.complete !== true) {
          updated.researchNotice = research.claims?.length
            ? "研究和主张已保存；逐条完成原文范围复核后再交给文案台。"
            : "尚无逐条复核记录；请确认本次无需事实主张，或补充可核对主张后再交给文案台。";
          return updated;
        }
        if (research.sourceChecks.length && !readable.some((source) => source.sourceKind === "official")) {
          updated.researchNotice = "已保存研究草稿。当前链接缺少可读的发布方正文，补充原文或人工核对后再交给文案。";
          return updated;
        }
        if (!updated.topicConfirmation) updated = await apply(updated, "confirm_topic", { confirmation: "用户启动了研究并直接出稿" });
        updated = await apply(updated, "handoff", { toStage: "writing", note: "研究结果接力生成稿件" });
        let draft;
        try {
          draft = await modelAction(updated, "generate");
        } catch (cause) {
          updated.researchNotice = "选题和来源已交到文案台。自动稿件还未生成：" + cause.message;
          return updated;
        }
        if (typeof draft.body === "string") draft.script = draft.body;
        updated = await save(updated, { ...draft, ...(draft.skillTrace ? { skillTrace: draft.skillTrace } : {}), generatedAt: new Date().toISOString() });
        if (Array.isArray(draft.needsInput) && draft.needsInput.length) {
          updated = await apply(updated, "request_input", { note: draft.needsInput.join("\n") });
        }
      }
      return updated;
    }
    if (body.action === "draft_retro") {
      const measured = task.publications.filter((target) => target.version === task.version && target.snapshots?.length);
      if (stage !== "analytics" || !measured.length) throw error(409, "回收对应作品的真实指标后才能分析。");
      return save(task, { retro: await modelAction(task, "数据复盘", { realMetrics: measured }) });
    }
    if (body.action === "collect_metrics") {
      const target = task.publications.find((entry) => entry.targetId === body.targetId);
      if (target?.state !== "published") throw error(409, "需要先登记真实发布结果。");
      if (body.snapshot && target.target.platform === "bilibili") {
        return apply(task, "record_metrics", { targetId: body.targetId, snapshot: body.snapshot });
      }
      const snapshot = await tools.collectMetrics({ taskId: task.id, version: target.version, platform: target.target.platform,
        postId: target.platformPostId, url: target.url, snapshot: body.snapshot });
      return apply(task, "record_metrics", { targetId: body.targetId, snapshot });
    }
    if (body.action === "publish_selected") {
      if (!Array.isArray(body.targetIds) || !body.targetIds.length || new Set(body.targetIds).size !== body.targetIds.length) {
        throw error(400, "请指定待提交的发布目标。");
      }
      let current = task;
      const failures = [];
      for (const targetId of body.targetIds) {
        try { current = await execute(current, { action: "publish_target", targetId }); }
        catch (cause) {
          failures.push({ targetId, error: cause.message });
          current = await store.get(task.id);
        }
      }
      return { ...current, actionFailures: failures };
    }
    if (body.action === "publish_target") {
      if (task.format !== "video") throw error(409, "文字和图文请使用实际作品链接登记。");
      const targetPreview = task.batch?.targets.find((target) => target.id === body.targetId);
      const caps = await tools.capabilities();
      if (!targetPreview || !caps.platforms?.[targetPreview.platform]?.video) throw error(409, "该平台工具尚未接通，请手动发布后登记。");
      if (targetPreview.publishAt && !caps.platforms[targetPreview.platform].schedule) throw error(409, "该平台无法执行此定时发布。");
      if (targetPreview.cover && caps.platforms[targetPreview.platform].cover === false) throw error(409, "此工具无法为该平台提交自定义封面。");
      const target = targetPreview;
      const args = {
        platform: target.platform, account: target.account, title: target.title,
        sourcePath: target.file, description: target.description, tags: target.tags,
        coverPath: target.cover, schedule: localSchedule(target.publishAt),
        xText: target.content, visibility: target.visibility,
        xUsername: target.platform === "x" ? target.account.replace(/^@/, "") : undefined
      };
      await tools.previewPublish(args);
      const started = await apply(task, "begin_publish", { targetId: body.targetId });
      const publication = started.publications.find((entry) => entry.targetId === body.targetId);
      const attemptId = publication.attempts.at(-1).id;
      let result;
      try {
        const receipt = await tools.publishPlatform({ ...args, confirmed: true });
        result = {
          state: { PUBLISHED: "published", SUBMITTED: "unknown", UNKNOWN: "unknown", FAILED: "failed" }[receipt.status] || "unknown",
          platformPostId: receipt.postId, url: receipt.url, publishedAt: receipt.observedAt,
          reason: receipt.message, confirmedUnpublished: receipt.status === "FAILED"
        };
      } catch (cause) {
        result = { state: "unknown", reason: cause.message };
      }
      return apply(await store.get(task.id), "record_publish", { ...result, targetId: body.targetId, attemptId });
    }
    if (body.action === "render_cover" && ["editing", "analytics"].includes(stage)) {
      const cover = await tools.renderCover({ taskId: task.id, sourcePath: coverSource(task), title: body.title || task.title });
      return save(task, { cover });
    }
    if (stage !== "editing") throw error(409, "当前任务不归剪辑工作台处理。");
    if (pendingMedia.has(task.id)) throw error(409, "已有剪辑操作运行中。");
    pendingMedia.add(task.id);
    try {
      const skillTrace = await skillTraceFor("editing");
      const sourcePath = body.sourcePath || edit.sourcePath || task.inputs?.sourcePath;
      if (body.action === "inspect_media") {
        const inspection = await tools.inspectMedia({ sourcePath });
        const changed = edit.inspection?.sourcePath !== inspection.sourcePath;
        const pending = changed ? { transcript: null, cuts: [], prepared: null, asset: null, videoPath: null, cover: null, verified: false } : {};
        return save(task, { ...pending, sourcePath: inspection.sourcePath, inspection, skillTrace });
      }
      if (body.action === "transcribe") {
        const inspection = await tools.inspectMedia({ sourcePath });
        const transcript = await tools.transcribeMedia({ taskId: task.id, sourcePath });
        return save(task, { sourcePath: inspection.sourcePath, inspection, transcript, cuts: transcript.suggestedCuts || [], prepared: null, asset: null, videoPath: null, cover: null, verified: false, skillTrace });
      }
      if (body.action === "suggest_cuts") {
        if (!edit.transcript) throw error(409, "请先转写原片。");
        const answer = await modelAction(task, body.action, { transcript: edit.transcript.segments });
        return save(task, { cuts: Array.isArray(answer.cuts) ? answer.cuts : [], cutNotes: answer.body, skillTrace: answer.skillTrace });
      }
      if (body.action === "prepare_media") {
        if (body.confirmed !== true) throw error(400, "请先确认本次删改区间和画幅。");
        const inspection = await tools.inspectMedia({ sourcePath });
        const cuts = Array.isArray(body.cuts) ? body.cuts : [];
        const ranges = keepRanges(cuts, Number(inspection.duration ?? inspection.durationSeconds));
        const prepared = await tools.prepareEdit({ taskId: task.id, sourcePath, ranges, speed: 1.1, aspectRatio: body.aspectRatio || undefined });
        return save(task, { sourcePath: inspection.sourcePath, inspection, cuts, prepared, asset: null, videoPath: null, cover: null, verified: false, skillTrace });
      }
      if (body.action === "export_media") {
        if (!edit.prepared?.sourcePath || body.confirmed !== true) throw error(409, "请先审阅剪后字幕和人脸安全位置。");
        const asset = await tools.renderMedia({
          taskId: task.id, sourcePath: edit.prepared.sourcePath, speed: 1,
          segments: body.segments, captionPosition: body.captionPosition, renderSubtitles: true
        });
        return save(task, { asset, cover: null, videoPath: asset.filePath || asset.path || asset.outputPath || asset.videoPath || asset.sourcePath, verified: false, skillTrace });
      }
      if (body.action === "import_final") {
        const asset = await tools.verifyMedia({ taskId: task.id, sourcePath });
        return save(task, { sourcePath: asset.filePath, inspection: asset.media, asset, videoPath: asset.filePath, verified: false, transcript: null, prepared: null, cover: null, cuts: [], skillTrace });
      }
      throw error(400, "未知工作台操作。");
    } finally {
      pendingMedia.delete(task.id);
    }
  }

  const actionNames = new Set(["generate", "check_sources", "draft_retro", "collect_metrics", "publish_target", "publish_selected",
    "review_claims", "inspect_media", "transcribe", "suggest_cuts", "prepare_media", "export_media", "import_final", "render_cover"]);

  return {
    start() {
      if (!monitorEnabled) return;
      trends.start();
      runCollection();
      collectionTimer = setInterval(runCollection, 30 * 60_000);
      collectionTimer.unref();
    },
    stop() { trends.stop(); clearInterval(collectionTimer); },
    async route(req, res, url) {
      const name = url.pathname;
      const get = req.method === "GET";
      const post = req.method === "POST";
      if (name === "/api/trends" && get) return send(res, 200, await trends.read()), true;
      if (name === "/api/trends/refresh" && post) {
        const body = await bodyJson(req);
        return send(res, 200, await trends.refresh(body.source)), true;
      }
      const source = /^\/api\/trends\/sources\/([a-z]+)$/.exec(name);
      if (source && post) {
        const body = await bodyJson(req);
        if (typeof body.enabled !== "boolean") throw error(400, "需要明确开启状态。");
        return send(res, 200, await trends.setEnabled(source[1], body.enabled)), true;
      }
      if (!name.startsWith("/api/workbench/")) return false;
      if (name === "/api/workbench/capabilities" && get) return send(res, 200, await tools.capabilities()), true;
      if (name === "/api/workbench/tasks") {
        if (get) {
          const tasks = (await store.list()).map(({ id, title, stage, status, updatedAt, nextAction }) => ({
            id, title, stage, status, updatedAt, nextAction
          }));
          return send(res, 200, { tasks }), true;
        }
        if (post) return send(res, 201, { task: await store.create(await bodyJson(req)) }), true;
      }
      const feed = /^\/api\/workbench\/feedback\/(research|writing)$/.exec(name);
      if (feed && get) return send(res, 200, { feedback: await store.feedback(feed[1]) }), true;
      const match = /^\/api\/workbench\/tasks\/(CONTENT-\d{8}-\d{2})(?:\/(action|media\/(?:working|final|cover)))?$/.exec(name);
      if (!match) throw error(404, "工作台接口不存在。");
      const task = await store.get(match[1]);
      if (get && match[2]?.startsWith("media/")) {
        const requested = await realpath(mediaEntry(task, match[2].split("/")[1])).catch(() => null);
        if (!requested) throw error(404, "无法定位产物文件。");
        await streamMedia(req, res, requested);
        return true;
      }
      if (get && !match[2]) return send(res, 200, { task }), true;
      if (post && match[2] === "action") {
        const body = await bodyJson(req);
        if (task.revision !== body.revision) throw error(409, "任务另有更新，请刷新后再操作。");
        if (allowedUpdates.has(body.action)) {
          if (body.action === "handoff" && task.stage === "research" && body.toStage === "writing") {
            const research = task.stages.research?.data || {};
            if (research.checkedSourceText !== research.sourceText || research.claimReview?.complete !== true ||
                research.claims?.some((claim) => claim.reviewStatus === "pending")) {
              throw error(409, "请先核对当前来源版本并完成逐条主张复核，再交给文案台。");
            }
          }
          if (body.action === "handoff" && task.stage === "writing") {
            const review = body.data?.manualReview ?? task.stages.writing?.data?.manualReview;
            if (review?.status !== "accepted_for_editing" || !Array.isArray(review.checks) || review.checks.length < 4 || !Number.isFinite(Date.parse(review.reviewedAt))) {
              throw error(409, "交给剪辑前，请核对来源事实、归因限定、示例真实性和文稿逻辑，并记录四项复核。");
            }
          }
          if (task.stage === "editing") {
            if (body.action === "save") throw error(400, "请通过转写、导出或成片质检登记剪辑产物。");
            if (body.action === "handoff") {
              const asset = task.stages.editing?.data?.asset;
              if (body.data?.verified !== true || !asset?.filePath || !asset?.reportPath) {
                throw error(409, "请先核验本工作台登记的成片和质检报告。");
              }
              body.data = { verified: true, videoPath: asset.filePath };
            }
          }
          if (body.action === "record_publish") {
            const publication = task.publications.find((entry) => entry.targetId === body.targetId);
            const attempt = publication?.attempts?.at(-1);
            if (publication?.state === "in_progress" && attempt && Date.now() - Date.parse(attempt.at) < 12 * 60_000) {
              throw error(409, "提交工具仍可能运行。请等待回执，或在任务超时后核实。");
            }
          }
          if (body.action === "prepare_publish") {
            const prediction = typeof body.prediction === "string" ? body.prediction : body.prediction?.body;
            if (body.previewOnly !== true && (typeof prediction !== "string" || !prediction.trim())) {
              throw error(400, "保存正式发布预览前，请先生成或填写预测；只做预览时请选择预览模式。");
            }
          }
          let result = await store.update(task.id, body);
          if (body.action === "handoff" && task.stage === "editing" && !result.stages.editing.data.cover) {
            try {
              const cover = await tools.renderCover({ taskId: task.id, sourcePath: coverSource(result),
                title: result.stages.writing?.data?.cover || result.title });
              result = await save(result, { cover });
            } catch (cause) {
              result.coverNotice = "成片已交接。封面可在数据台重试：" + cause.message;
            }
          }
          return send(res, 200, { task: result }), true;
        }
        if (actionNames.has(body.action)) return send(res, 200, { task: await execute(task, body) }), true;
      }
      throw error(405, "工作台操作不受支持。");
    }
  };
}
