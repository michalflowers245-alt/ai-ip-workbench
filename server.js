import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeepSeek } from "./lib/deepseek.js";
import { createWorkbench } from "./lib/workbench-routes.js";
import { XhsStore } from "./lib/xhs-store.js";
import { XhsBrowserController, XhsResearchService } from "./lib/xhs-research.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = process.env.WORKBENCH_DATA_DIR
  ? path.resolve(process.env.WORKBENCH_DATA_DIR)
  : path.join(__dirname, "data");
const dbPath = path.join(dataDir, "db.json");
const deepSeek = createDeepSeek({ dataDir });
const connectionPath = path.join(dataDir, "model-connection.json");
const xhsDbPath = path.join(dataDir, "xhs-research.sqlite");
const xhsProfileDir = path.join(dataDir, "xhs-browser-profile");
const xhsArtifactsDir = path.join(dataDir, "xhs-artifacts");
const defaultPort = 5177;
const hasExplicitPort = Object.hasOwn(process.env, "PORT") && process.env.PORT !== "";
const requestedPort = hasExplicitPort ? Number(process.env.PORT) : defaultPort;
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  throw new Error("PORT 必须是 0 到 65535 之间的整数");
}
let port = requestedPort;
const host = process.env.WORKBENCH_HOST || "127.0.0.1";
const requestTimeoutMs = Number(process.env.WORKBENCH_REQUEST_TIMEOUT_MS || 30_000);

const employees = {
  research: {
    name: "热点与竞品研究员",
    role: "负责热点、竞品、来源核验与可做选题，先判断现实变化再提出个人选择。",
    skills: ["trend-and-competitor-research", "trends-bulletin", "firecrawl-search", "dbs-benchmark", "cheat-recommend"]
  },
  writing: {
    name: "文案制作",
    role: "负责把已确认的主题写成独立成立、可拍可改的口播文案，并检查逻辑和模板感。",
    skills: ["short-video-script-director", "dbs-content", "dbs-hook", "dbs-script-flow", "dbs-ai-check", "cheat-score"]
  },
  editing: {
    name: "剪辑",
    role: "负责原片保护、粗剪、字幕、声音、封面和成片核验；不覆盖原素材。",
    skills: ["chatcut:chatcut-plugin-basics", "kbcut", "voice-audio-engineer", "video-editor", "thumbnail-and-repurpose"]
  },
  analytics: {
    name: "数据分析",
    role: "负责发布前预测、确认后的发布编排、真实数据回收和复盘回流。",
    skills: ["publishing-and-performance-review", "cheat-predict", "cheat-publish", "cheat-retro", "cn-social-publish"]
  }
};

const connectionDefaults = {
  version: 3,
  mode: "local_openai_proxy",
  proxyBaseUrl: "",
  protocol: "chat_completions",
  model: "",
  lastTest: null,
  updatedAt: null
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function localHostName(value) {
  return String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackHost(value) {
  const hostname = localHostName(value);
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1";
}

if (!isLoopbackHost(host)) {
  throw new Error("WORKBENCH_HOST 只能是本机回环地址");
}

function localOrigin() {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function parseLocalUrl(value, label, { required = false, base = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) {
    if (required) throw new HttpError(400, `请填写${label}`);
    return "";
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `${label}不是有效的 URL`);
  }

  if (!isLoopbackHost(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, `${label}只能是无凭据的本机 http(s) 地址`);
  }
  if (url.search || url.hash) throw new HttpError(400, `${label}不能包含查询参数或片段`);

  const normalized = url.toString().replace(/\/$/, "");
  if (base && /\/chat\/completions$/i.test(new URL(normalized).pathname)) {
    throw new HttpError(400, `${label}应填写 API 根地址，不要包含 /chat/completions`);
  }
  return normalized;
}

function appendEndpoint(baseUrl, endpoint) {
  return new URL(endpoint.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`).toString();
}

function compactText(value, max = 160) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function safeStoredLocalUrl(value, label, options = {}) {
  try {
    return parseLocalUrl(value, label, options);
  } catch {
    return "";
  }
}

function safeError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(500, compactText(error?.message, 300) || "服务器内部错误");
}

function assertTrustedMutation(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const url = new URL(origin);
    const originPort = url.port || (url.protocol === "https:" ? "443" : "80");
    if (!isLoopbackHost(url.hostname) || Number(originPort) !== port) {
      throw new Error("untrusted origin");
    }
  } catch {
    throw new HttpError(403, "仅允许本机工作台页面修改设置");
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(file, value) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function saveDb(db) {
  await saveJson(dbPath, db);
}

async function loadDb() {
  const db = await readJson(dbPath, null);
  if (db) {
    db.knowledge ||= [];
    db.feedback ||= [];
    db.conversations ||= {};
    let changed = false;
    for (const key of Object.keys(employees)) {
      if (!db.conversations[key]) {
        db.conversations[key] = [];
        changed = true;
      }
    }
    if (changed) await saveDb(db);
    return db;
  }
  const seed = {
    knowledge: [],
    feedback: [],
    conversations: Object.fromEntries(Object.keys(employees).map((key) => [key, []])),
    createdAt: new Date().toISOString()
  };
  await saveDb(seed);
  return seed;
}

function normalizeConnection(raw = {}) {
  const lastTest = raw.lastTest && typeof raw.lastTest === "object"
    ? {
        status: raw.lastTest.status === "success" ? "success" : "failed",
        latencyMs: Number.isFinite(raw.lastTest.latencyMs) ? raw.lastTest.latencyMs : null,
        at: typeof raw.lastTest.at === "string" ? raw.lastTest.at : null
      }
    : null;
  return {
    ...connectionDefaults,
    mode: "local_openai_proxy",
    proxyBaseUrl: safeStoredLocalUrl(raw.proxyBaseUrl, "本机代理 API 根地址", { base: true }),
    protocol: "chat_completions",
    model: compactText(raw.model, 120),
    lastTest,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null
  };
}

async function loadConnection() {
  return normalizeConnection(await readJson(connectionPath, connectionDefaults));
}

async function saveConnection(connection) {
  const normalized = normalizeConnection(connection);
  normalized.updatedAt = new Date().toISOString();
  await saveJson(connectionPath, normalized);
  return normalized;
}

function validateConnectionInput(body) {
  const model = compactText(body.model, 120);
  const proxyBaseUrl = parseLocalUrl(body.proxyBaseUrl, "本机代理 API 根地址", { base: true });

  if (!proxyBaseUrl || !model) {
    throw new HttpError(400, "本机 OpenAI 代理需要 API 根地址和模型标识");
  }
  return { mode: "local_openai_proxy", protocol: "chat_completions", model, proxyBaseUrl };
}

function connectionView(connection) {
  const configured = Boolean(connection.proxyBaseUrl && connection.model);
  const testSucceeded = connection.lastTest?.status === "success";
  const connected = configured && testSucceeded;
  return {
    mode: connection.mode,
    protocol: connection.protocol,
    proxyBaseUrl: connection.proxyBaseUrl,
    configuredModel: connection.model,
    model: connection.model,
    configured,
    connected,
    lastTest: connection.lastTest,
    note: "此连接调用已运行的本机 OpenAI-compatible 代理。代理内部的登录或 OAuth 状态不进入工作台。"
  };
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new HttpError(413, "请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, "请求不是有效 JSON"));
      }
    });
    req.on("error", () => reject(new HttpError(400, "读取请求失败")));
  });
}

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}

function textSummary(items) {
  return items.slice(-8).map((item) => `- ${item.title || item.type}: ${String(item.content || "").slice(0, 220)}`).join("\n");
}

function modelMessages(employeeKey, message, db) {
  const employee = employees[employeeKey] || employees.research;
  const system = `你是${employee.name}。${employee.role} 你只能按这些 Skill 的工作思路完成任务：${employee.skills.join(", ")}。用中文输出。先区分事实、推断和待验证项；资料不足时只提出会改变结果的关键问题。不要编造热点、数据、案例或来源。`;
  const user = `共享知识库：\n${textSummary(db.knowledge)}\n\n发布数据：\n${JSON.stringify(db.feedback.slice(-10))}\n\n用户任务：${message}`;
  return { system, user };
}

async function fetchLocal(url, options = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "error" });
  } catch (error) {
    if (error?.name === "AbortError") throw new HttpError(504, "本机代理响应超时，请检查它是否仍在运行");
    throw new HttpError(502, "无法连接本机代理，请检查地址、进程和授权状态");
  } finally {
    clearTimeout(timeout);
  }
}

function readChatText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || "").join("").trim();
  return "";
}

async function requestOpenAiCompatible(connection, messages) {
  const endpoint = appendEndpoint(connection.proxyBaseUrl, "chat/completions");
  const compact = messages.compact && new URL(connection.proxyBaseUrl).port === "11434";
  const prompt = compact ? messages.compact : messages;
  const payload = {
    model: connection.model,
    temperature: 0.4,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ],
    max_tokens: compact ? Math.min(messages.maxTokens || 1200, 1400) : messages.maxTokens || 1200,
    ...(compact && messages.json ? { response_format: messages.schema
      ? { type: "json_schema", json_schema: { name: "content_workbench", schema: messages.schema } }
      : { type: "json_object" } } : {}),
    ...(compact ? { reasoning_effort: "none" } : {})
  };

  const startedAt = Date.now();
  const response = await fetchLocal(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }, compact ? Math.max(requestTimeoutMs, 120_000) : requestTimeoutMs);
  if (!response.ok) throw new HttpError(502, `本机 OpenAI 代理返回 HTTP ${response.status}，请检查授权、模型和协议`);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new HttpError(502, "本机 OpenAI 代理未返回 JSON，请检查兼容 API 配置");
  }
  const text = readChatText(data);
  if (!text) throw new HttpError(502, "本机 OpenAI 代理返回内容无法识别，请检查协议和模型");
  return { text, latencyMs: Date.now() - startedAt };
}

async function aiGenerate(employeeKey, message, db, connection) {
  const messages = modelMessages(employeeKey, message, db);
  if ((await deepSeek.view()).active) return (await deepSeek.complete(messages)).text;
  if (!connection.proxyBaseUrl || !connection.model) {
    throw new HttpError(400, "本机 OpenAI 代理尚未完成配置，请先保存 API 根地址和模型标识");
  }
  if (connection.lastTest?.status !== "success") {
    throw new HttpError(409, "本机 OpenAI 代理尚未接通，请先发送最小测试");
  }
  try {
    return (await requestOpenAiCompatible(connection, messages)).text;
  } catch (error) {
    connection.lastTest = { status: "failed", latencyMs: null, at: new Date().toISOString() };
    await saveConnection(connection);
    throw error;
  }
}

async function cleanXhsPost(post) {
  const connection = await loadConnection();
  if (!connectionView(connection).connected) {
    return {
      status: "not_configured",
      text: "",
      message: "尚未进行 AI（人工智能）清洗：本机 OpenAI-compatible 代理未通过连接测试。"
    };
  }
  const result = await requestOpenAiCompatible(connection, {
    system: "你是小红书原文整理助手。只能整理输入中已有的原文，不补充事实、不改写观点、不生成营销文案。删除重复导航、界面噪声和重复段落；恢复中文断句；只修正有充分把握的 OCR 错字和 ASR 断句；分清正文、图片文字、视频字幕或口播，排除评论；无法确定的文字标记为【不确定】。保留标题、标签和原意，直接输出统一清洗文本。",
    user: JSON.stringify({
      title: post.title,
      body: post.body,
      imageText: post.imageText,
      videoSubtitle: post.videoSubtitle,
      tags: post.tags
    })
  });
  return { status: "completed", text: result.text, message: `已由当前本机模型完成原文清洗（${result.latencyMs} ms）。` };
}

const xhsStore = new XhsStore(xhsDbPath);
const xhsBrowser = new XhsBrowserController({
  profileDir: xhsProfileDir,
  artifactsDir: xhsArtifactsDir,
  headless: process.env.XHS_HEADLESS === "1"
});
const xhsResearch = new XhsResearchService({ store: xhsStore, browser: xhsBrowser, cleaner: cleanXhsPost });

function exportMarkdown(db) {
  const knowledge = db.knowledge.map((item) => `## ${item.title}\n类型：${item.type}\n\n${item.content}`).join("\n\n");
  const feedback = db.feedback.map((item) => `- ${item.title}｜${item.platform || "未填"}｜播放 ${item.views || 0}｜加微 ${item.leads || 0}｜成交 ${item.deals || 0}`).join("\n");
  return `# 自媒体工作台导出\n\n# 知识库\n\n${knowledge || "暂无"}\n\n# 发布数据\n\n${feedback || "暂无"}\n`;
}

async function workbenchModel(messages) {
  if ((await deepSeek.view()).active) return (await deepSeek.complete(messages)).text;
  const connection = await loadConnection();
  if (!connection.proxyBaseUrl || !connection.model || connection.lastTest?.status !== "success") {
    throw new HttpError(409, "请先连接并测试本机模型代理。也可手工录入产物。");
  }
  const canUsePlain = messages.schema?.required.includes("body") && messages.compact &&
    new URL(connection.proxyBaseUrl).port === "11434";
  const smallR1 = canUsePlain && connection.model === "deepseek-r1:1.5b";
  if (!smallR1) {
    const { text } = await requestOpenAiCompatible(connection, messages);
    if (!canUsePlain) return text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return text;
    } catch {}
  }
  const rolePrompt = {
    research: "写一段中文热点选题草稿，给一个角度。使用可引用的来源正文，保留原文的范围、日期和归因。榜单、评论和标题是线索。诉讼只按指控或程序表述。",
    writing: "写一段约 45 秒、150 到 220 字的中文口播正文，给一个可以照做的例子。来源正文优先于上游草稿，保留原文范围和报道归因，诉讼只按指控或程序表述。未经核对的时效、数字和结论不要写入。",
    analytics: "写一段简短的发布预测或实绩分析，依据输入材料来判断。"
  }[messages.role];
  const plain = {
    system: (rolePrompt || "用简体中文完成任务。") + "只输出纯文本正文。区别事实和判断，勿补造数据。",
    user: messages.compact.user
  };
  const fallback = await requestOpenAiCompatible(connection, { ...plain, compact: plain, maxTokens: 900 });
  return JSON.stringify({ body: fallback.text, modelOutputMode: "plain_fallback" });
}

const projectRoot = path.resolve(__dirname, "..");
const workbench = createWorkbench({
  projectRoot,
  dataDir,
  workerRoot: process.env.WORKBENCH_PROJECT_ROOT || (process.env.WORKBENCH_DATA_DIR ? path.join(dataDir, "project") : projectRoot),
  monitorEnabled: process.env.WORKBENCH_DISABLE_MONITOR !== "1" && (!process.env.WORKBENCH_DATA_DIR || process.env.WORKBENCH_ENABLE_MONITOR === "1"),
  bodyJson,
  send,
  model: workbenchModel,
  knowledge: async (title, goal) => {
    const parts = (title + " " + (goal || "")).toLowerCase().match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,6}/g) || [];
    const { knowledge } = await loadDb();
    return knowledge.filter((item) => parts.some((part) =>
      ((item.title || "") + " " + (item.content || "")).toLowerCase().includes(part)))
      .slice(-5).map((item) => ({ title: item.title, content: String(item.content || "").slice(0, 800) }));
  }
});

async function route(req, res) {
  const url = new URL(req.url, localOrigin());
  if (url.pathname.startsWith("/api/workbench/") || url.pathname.startsWith("/api/trends") || url.pathname.startsWith("/api/deepseek")) {
    let localHost;
    try { localHost = new URL("http://" + req.headers.host).hostname; } catch {}
    if (!localHost || !isLoopbackHost(localHost)) throw new HttpError(403, "工作台只能通过本机地址访问");
    if (req.method === "POST" && !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) {
      throw new HttpError(415, "工作台操作需要 JSON 请求");
    }
  }

  if (url.pathname.startsWith("/api/") && req.method !== "GET") assertTrustedMutation(req);

  if (await workbench.route(req, res, url)) return;

  if (url.pathname === "/api/deepseek" && req.method === "GET") {
    return send(res, 200, await deepSeek.view({ refreshIfStale: true }));
  }
  if (url.pathname === "/api/deepseek" && req.method === "POST") {
    return send(res, 200, await deepSeek.save(await bodyJson(req)));
  }
  if (url.pathname === "/api/deepseek/refresh" && req.method === "POST") {
    return send(res, 200, await deepSeek.refresh());
  }
  if (url.pathname === "/api/deepseek/clear" && req.method === "POST") {
    return send(res, 200, await deepSeek.clear());
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    const [db, connection, official] = await Promise.all([loadDb(), loadConnection(), deepSeek.view()]);
    const modelConnection = connectionView(connection);
    return send(res, 200, { employees, db, modelConnection, deepSeek: { active: official.active, effectiveModel: official.effectiveModel },
      aiEnabled: official.active || modelConnection.connected });
  }
  if (url.pathname === "/api/model-connection" && req.method === "GET") {
    return send(res, 200, connectionView(await loadConnection()));
  }
  if (url.pathname === "/api/model-connection" && req.method === "POST") {
    const body = await bodyJson(req);
    const current = await loadConnection();
    const input = validateConnectionInput(body);
    const proxyConfigurationChanged = current.proxyBaseUrl !== input.proxyBaseUrl
      || current.protocol !== input.protocol
      || current.model !== input.model;
    const next = await saveConnection({
      ...current,
      ...input,
      lastTest: !proxyConfigurationChanged ? current.lastTest : null
    });
    return send(res, 200, connectionView(next));
  }
  if (url.pathname === "/api/model-connection/proxy/test" && req.method === "POST") {
    const connection = await loadConnection();
    if (!connection.proxyBaseUrl || !connection.model) {
      throw new HttpError(400, "请先保存本机代理的 API 根地址和模型标识");
    }
    try {
      const result = await requestOpenAiCompatible(connection, {
        system: "你正在执行一个本机连接测试。",
        user: "请只回复：OK"
      });
      connection.lastTest = { status: "success", latencyMs: result.latencyMs, at: new Date().toISOString() };
    } catch (error) {
      connection.lastTest = { status: "failed", latencyMs: null, at: new Date().toISOString() };
      await saveConnection(connection);
      throw error;
    }
    return send(res, 200, connectionView(await saveConnection(connection)));
  }
  if (url.pathname === "/api/model-connection/proxy/disconnect" && req.method === "POST") {
    const connection = await loadConnection();
    connection.lastTest = null;
    return send(res, 200, connectionView(await saveConnection(connection)));
  }

  if (url.pathname === "/api/xhs/connection" && req.method === "GET") {
    return send(res, 200, xhsBrowser.connectionStatus());
  }
  if (url.pathname === "/api/xhs/connection/open" && req.method === "POST") {
    try {
      return send(res, 200, await xhsBrowser.openLogin());
    } catch (error) {
      throw new HttpError(502, error.message || "无法打开小红书专用浏览器");
    }
  }
  if (url.pathname === "/api/xhs/connection/check" && req.method === "POST") {
    try {
      return send(res, 200, await xhsBrowser.checkLogin());
    } catch (error) {
      throw new HttpError(502, error.message || "无法检查小红书登录状态");
    }
  }
  if (url.pathname === "/api/xhs/connection/clear" && req.method === "POST") {
    return send(res, 200, await xhsBrowser.clearProfile());
  }
  if (url.pathname === "/api/xhs/tasks" && req.method === "GET") {
    return send(res, 200, { tasks: xhsStore.listTasks({
      limit: url.searchParams.get("limit"), keyword: url.searchParams.get("keyword"),
      from: url.searchParams.get("from"), to: url.searchParams.get("to")
    }), postCount: xhsStore.countPosts() });
  }
  if (url.pathname === "/api/xhs/posts" && req.method === "GET") {
    return send(res, 200, { posts: xhsStore.queryPosts({
      limit: url.searchParams.get("limit"), keyword: url.searchParams.get("keyword"),
      from: url.searchParams.get("from"), to: url.searchParams.get("to")
    }) });
  }
  if (url.pathname === "/api/xhs/tasks" && req.method === "POST") {
    const body = await bodyJson(req);
    try {
      return send(res, 202, { task: xhsResearch.start(body.keyword, body.targetCount) });
    } catch (error) {
      throw new HttpError(400, error.message || "无法创建搜索任务");
    }
  }
  const xhsTaskMatch = url.pathname.match(/^\/api\/xhs\/tasks\/([a-zA-Z0-9_-]+)$/);
  if (xhsTaskMatch && req.method === "GET") {
    const detail = xhsResearch.detail(xhsTaskMatch[1]);
    if (!detail) throw new HttpError(404, "搜索任务不存在");
    return send(res, 200, detail);
  }
  const xhsStopMatch = url.pathname.match(/^\/api\/xhs\/tasks\/([a-zA-Z0-9_-]+)\/stop$/);
  if (xhsStopMatch && req.method === "POST") {
    const task = xhsResearch.stop(xhsStopMatch[1]);
    if (!task) throw new HttpError(404, "搜索任务不存在");
    return send(res, 200, { task });
  }
  const xhsRetryMatch = url.pathname.match(/^\/api\/xhs\/posts\/([a-zA-Z0-9_-]+)\/retry$/);
  if (xhsRetryMatch && req.method === "POST") {
    try {
      return send(res, 200, { post: await xhsResearch.retry(xhsRetryMatch[1]) });
    } catch (error) {
      throw new HttpError(502, error.message || "重新提取失败");
    }
  }
  const xhsKnowledgeMatch = url.pathname.match(/^\/api\/xhs\/posts\/([a-zA-Z0-9_-]+)\/knowledge$/);
  if (xhsKnowledgeMatch && req.method === "POST") {
    const post = xhsStore.getPost(xhsKnowledgeMatch[1]);
    if (!post) throw new HttpError(404, "帖子记录不存在");
    const db = await loadDb();
    const content = post.merged_copy || post.body || post.image_text || post.video_subtitle;
    if (!content) throw new HttpError(409, "这条帖子没有可存入知识库的文字");
    db.knowledge.push({
      id: Date.now(), type: "小红书研究", title: compactText(post.title, 120) || "小红书帖子",
      content: `${content}\n\n原帖：${post.post_url}`,
      sourceUrl: post.post_url, sourcePostId: post.id, createdAt: new Date().toISOString()
    });
    await saveDb(db);
    return send(res, 200, { ok: true, db });
  }
  const xhsArtifactMatch = url.pathname.match(/^\/api\/xhs\/artifacts\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (xhsArtifactMatch && req.method === "GET") {
    const full = path.join(xhsArtifactsDir, xhsArtifactMatch[1], xhsArtifactMatch[2]);
    if (!full.startsWith(`${xhsArtifactsDir}${path.sep}`) || !existsSync(full)) throw new HttpError(404, "采集截图不存在");
    const ext = path.extname(full).toLowerCase();
    const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
    return send(res, 200, await readFile(full), types[ext] || "application/octet-stream");
  }

  const db = await loadDb();
  if (url.pathname === "/api/knowledge" && req.method === "POST") {
    const body = await bodyJson(req);
    db.knowledge.push({ id: Date.now(), type: body.type || "素材", title: compactText(body.title, 120) || "未命名资料", content: String(body.content || ""), createdAt: new Date().toISOString() });
    await saveDb(db);
    return send(res, 200, { ok: true, db });
  }
  if (url.pathname === "/api/feedback" && req.method === "POST") {
    const body = await bodyJson(req);
    db.feedback.push({ id: Date.now(), ...body, createdAt: new Date().toISOString() });
    await saveDb(db);
    return send(res, 200, { ok: true, db });
  }
  if (url.pathname === "/api/generate" && req.method === "POST") {
    const body = await bodyJson(req);
    const employee = employees[body.employee] ? body.employee : "research";
    const message = String(body.message || "").trim();
    if (!message) throw new HttpError(400, "请先输入任务");
    const answer = await aiGenerate(employee, message, db, await loadConnection());
    db.conversations[employee] ||= [];
    db.conversations[employee].push({ role: "user", content: message, at: new Date().toISOString() });
    db.conversations[employee].push({ role: "assistant", content: answer, at: new Date().toISOString() });
    await saveDb(db);
    return send(res, 200, { answer, db });
  }
  if (url.pathname === "/api/export" && req.method === "GET") return send(res, 200, exportMarkdown(db), "text/markdown; charset=utf-8");

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "不支持的请求方法" });
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(publicDir, safe);
  if (!full.startsWith(publicDir) || !existsSync(full)) return send(res, 404, "Not found", "text/plain; charset=utf-8");
  const ext = path.extname(full);
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
  if (req.method === "HEAD") return send(res, 200, "", types[ext] || "application/octet-stream");
  send(res, 200, await readFile(full), types[ext] || "application/octet-stream");
}

const server = http.createServer((req, res) => route(req, res).catch((error) => {
  if (res.headersSent) return res.destroy();
  const safe = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error : safeError(error);
  send(res, safe.status || 500, { error: safe.status ? safe.message : "服务器内部错误" });
}));

let usedFallbackPort = false;
server.on("error", (error) => {
  if (error?.code === "EADDRINUSE" && !hasExplicitPort && !usedFallbackPort) {
    usedFallbackPort = true;
    console.warn(`默认端口 ${defaultPort} 已被占用，正在改用空闲本机端口。`);
    server.listen(0, host);
    return;
  }
  console.error(`工作台无法启动：${error.message}`);
  process.exitCode = 1;
});

server.on("listening", () => {
  const address = server.address();
  if (address && typeof address === "object") port = address.port;
  console.log(`自媒体工作台运行于 ${localOrigin()}`);
  workbench.start();
});

server.listen(port, host);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  workbench.stop();
  console.log(`收到 ${signal}，正在关闭浏览器和数据库。`);
  await xhsBrowser.close().catch(() => {});
  try { xhsStore.close(); } catch { /* already closed */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
