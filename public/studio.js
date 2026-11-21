import { createDraftStore, taskPage } from "/studio-drafts.js";

const root = document.getElementById("studio-workspace");
const roles = {
  research: { title: "热点与竞品分析", subtitle: "监测热点、找原文、挑选题", number: "01", verb: "研究选题" },
  writing: { title: "文案制作", subtitle: "从写作角度推进到可拍稿件", number: "02", verb: "制作稿件" },
  editing: { title: "剪辑", subtitle: "审阅删改、字幕与成片", number: "03", verb: "剪辑素材" },
  analytics: { title: "发布与数据分析", subtitle: "发布管理、实绩回收与复盘", number: "04", verb: "准备发布" }
};
const states = {
  INTAKE: "收件", NEEDS_INPUT: "待补充", RESEARCHED: "已研究",
  AWAITING_TOPIC_CONFIRMATION: "待确认选题", CONFIRMED: "已确认选题",
  DRAFTED: "制作中", AWAITING_PUBLISH_CONFIRMATION: "待核对发布",
  PUBLISHED: "已发布", AWAITING_DATA: "待回收数据", RETRO_DONE: "已复盘",
  ARCHIVED: "已归档", REJECTED: "已否决"
};
const sourceStates = {
  waiting: "待刷新", ok: "在线", stale: "数据过期", failed: "采集失败",
  disabled: "已停用", candidate: "候选来源", partial: "部分更新"
};
const platformNames = { douyin: "抖音", xiaohongshu: "小红书", tencent: "视频号", x: "X", bilibili: "哔哩哔哩" };
const initialRole = new URLSearchParams(location.search).get("workspace");
let role = "home";
let selected;
let tasks = [];
let latestTrends;
const trendFilters = { source: "", scope: "board", term: "" };
let trendOutcomes = [];
let busy = false;
let banner;
let viewEpoch = 0;
let tasksEpoch = 0;
let operation;
let draftContext;
const taskFilters = new Map();
const drafts = createDraftStore({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key)
});
const selection = {};
const initialTask = new URLSearchParams(location.search).get("task");
if (initialRole && /^CONTENT-\d{8}-\d{2}$/.test(initialTask || "")) selection[initialRole] = initialTask;

function el(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function panel(title, ...items) {
  const wrap = el("section", "studio-panel");
  if (title) wrap.append(el("h2", "", title));
  wrap.append(...items);
  return wrap;
}
function line(...items) {
  const wrap = el("div", "studio-actions");
  wrap.append(...items);
  return wrap;
}
function button(text, fn, primary = false) {
  const item = el("button", primary ? "studio-primary" : "studio-button", text);
  item.type = "button";
  item.onclick = () => run(fn, item);
  return item;
}
function localDate(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "暂无";
}
function link(url, label) {
  const item = el("a", "", label);
  try {
    const parsed = new URL(url, location.href);
    if (["https:", "http:"].includes(parsed.protocol)) item.href = parsed.href;
  } catch {}
  item.target = "_blank";
  item.rel = "noopener noreferrer";
  return item;
}
function field(label, value = "", { type = "text", placeholder = "", choices, draftKey } = {}) {
  const wrap = el("label", "studio-field");
  let input;
  if (choices) {
    input = el("select");
    for (const [key, text] of Object.entries(choices)) {
      const option = el("option", "", text);
      option.value = key;
      input.append(option);
    }
  } else if (type === "textarea") {
    input = el("textarea");
    input.rows = 5;
  } else {
    input = el("input");
    input.type = type;
  }
  input.placeholder = placeholder;
  input.value = value ?? "";
  if (type === "checkbox") input.checked = Boolean(value);
  wrap.append(el("span", "", label), input);
  if (draftKey && draftContext) bindDraft(draftContext, draftKey, input);
  return { wrap, get: () => type === "checkbox" ? input.checked : input.value.trim(), input };
}
function textBlock(value) {
  return el("div", "studio-text", value || "");
}
function json(value) {
  return JSON.stringify(value, null, 2);
}
function arrayInput(value, label) {
  let parsed;
  try { parsed = JSON.parse(value || "[]"); } catch { throw new Error(label + "需要有效的 JSON。"); }
  if (!Array.isArray(parsed)) throw new Error(label + "需要是一个数组。");
  return parsed;
}
async function api(route, body) {
  const response = await fetch(route, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "请求失败 (" + response.status + ")");
    error.status = response.status;
    throw error;
  }
  return data;
}
function draftEntry(context) {
  return drafts.read(context.task.id, context.stage);
}
function updateDraftStatus(context) {
  if (!context.status) return;
  const entry = draftEntry(context);
  const stale = entry && (entry.revision !== context.task.revision || entry.version !== context.task.version);
  context.status.replaceChildren();
  if (!entry) {
    context.status.append(el("span", "studio-muted", context.isIntake ? "输入会暂存于此浏览器，创建后进入任务列表。" : "已保存到工作台 · " + context.task.version + " · 修订 " + context.task.revision + " · " + localDate(context.task.updatedAt)));
    return;
  }
  const label = stale ? "发现未保存草稿，当前任务已有更新" : "有未保存修改 · " + (drafts.persistent ? "已暂存于此浏览器" : "浏览器无法持久保存，请及时保存到工作台");
  context.status.append(el("span", "studio-draft-message", label));
  if (stale) {
    const preview = el("details", "studio-draft-preview");
    preview.append(el("summary", "", "查看未保存内容"));
    for (const [name, value] of Object.entries(entry.values)) {
      const title = context.fields.get(name)?.input.closest("label")?.querySelector("span")?.textContent || (name === "targets" ? "发布目标" : name);
      preview.append(el("strong", "", title), textBlock(typeof value === "string" ? value : json(value)));
    }
    context.status.append(preview, button("恢复草稿到当前表单", () => {
      if (!window.confirm("把暂存的修改恢复到当前表单？请核对新的任务内容后再保存。")) return;
      drafts.write(context.task.id, context.stage, { ...entry, revision: context.task.revision, version: context.task.version });
      render();
    }));
  }
  context.status.append(button("放弃未保存修改", () => {
    if (!window.confirm("仅放弃此工作台的未保存修改，保留已保存版本？")) return;
    drafts.remove(context.task.id, context.stage);
    render();
  }));
}
function bindDraft(context, key, input) {
  const saved = String(input.value ?? "");
  const entry = draftEntry(context);
  if (entry && (entry.revision !== context.task.revision || entry.version !== context.task.version)) input.disabled = true;
  if (entry?.revision === context.task.revision && entry.version === context.task.version && Object.hasOwn(entry.values, key)) {
    input.value = entry.values[key];
  }
  input.dataset.draftKey = key;
  context.fields.set(key, { input, saved });
  const changed = () => {
    const previous = draftEntry(context);
    if (previous && (previous.revision !== context.task.revision || previous.version !== context.task.version)) {
      // Preserve the earlier draft until the user explicitly restores or discards it.
      showBanner("当前任务有一份旧草稿。请先恢复或放弃旧草稿，再继续编辑。", true);
      input.value = saved;
      return;
    }
    const values = { ...(previous?.values || {}) };
    if (input.value === saved) delete values[key];
    else values[key] = input.value;
    drafts.write(context.task.id, context.stage, { revision: context.task.revision, version: context.task.version, values });
    updateDraftStatus(context);
  };
  input.addEventListener("input", changed);
  input.addEventListener("change", changed);
}
function lockInputs(locked) {
  for (const input of root.querySelectorAll(".studio-task-board input, .studio-task-board textarea, .studio-task-board select, [data-intake] input, [data-intake] textarea, [data-intake] select")) {
    if (locked && !input.disabled) { input.disabled = true; input.dataset.operationLocked = "true"; }
    else if (!locked && input.dataset.operationLocked) { input.disabled = false; delete input.dataset.operationLocked; }
  }
}
async function run(fn, trigger) {
  if (busy) { showBanner("上一项操作仍在处理，完成后即可继续。"); return; }
  busy = true;
  const context = { task: selected, epoch: viewEpoch, displayEpoch: viewEpoch };
  operation = context;
  if (trigger) trigger.disabled = true;
  lockInputs(true);
  showBanner("正在处理…");
  try {
    const result = await fn();
    if (context.displayEpoch === viewEpoch) showBanner(result?.researchNotice || context.notice || "");
    else if (result?.id && context.notice) showBanner((result.title || result.id) + " · " + context.notice);
  } catch (error) {
    if (context.displayEpoch === viewEpoch) {
      showBanner(error.message, true);
      if (error.status === 409 && context.task) {
        const taskId = context.task.id;
        banner.append(button("重新读取，保留草稿", async () => {
          await openTask(taskId);
          if (operation) operation.notice = "已读取最新任务。未保存内容保留在草稿区，请核对后恢复。";
        }));
      }
    }
  } finally {
    busy = false;
    if (operation === context) operation = undefined;
    lockInputs(false);
    if (trigger) trigger.disabled = false;
  }
}
function showBanner(text, error) {
  if (!banner) return;
  banner.textContent = text;
  banner.hidden = !text;
  banner.classList.toggle("studio-error", Boolean(error));
}
function navigate(next) {
  window.dispatchEvent(new CustomEvent("studio-navigate", { detail: next }));
  if (operation) operation.displayEpoch = viewEpoch;
}
async function loadTasks() {
  const epoch = ++tasksEpoch;
  const data = await api("/api/workbench/tasks");
  if (epoch === tasksEpoch) tasks = data.tasks;
}
async function create(entryStage, title, goal, format, inputs = {}, { clearIntake = false } = {}) {
  const epoch = viewEpoch;
  const response = await api("/api/workbench/tasks", { entryStage, title, goal, format, inputs });
  const task = response.task;
  if (clearIntake) drafts.remove("intake", entryStage);
  await loadTasks();
  if (epoch !== viewEpoch) return task;
  selected = task;
  selection[entryStage] = task.id;
  if (role !== entryStage) {
    navigate(entryStage);
    if (operation) operation.displayEpoch = viewEpoch;
  } else render();
  if (operation) operation.notice = "任务已创建 · " + task.id;
  return task;
}
async function openTask(id, options = {}) {
  const epoch = options.epoch ?? ++viewEpoch;
  if (operation && options.epoch === undefined && operation.displayEpoch === epoch - 1) operation.displayEpoch = epoch;
  const currentRole = role;
  const { task } = await api("/api/workbench/tasks/" + id);
  if (viewEpoch !== epoch || role !== currentRole) return task;
  if (task.stage !== role) {
    selection[task.stage] = task.id;
    navigate(task.stage);
    return task;
  }
  selected = task;
  selection[role] = id;
  const url = new URL(location.href);
  url.searchParams.set("task", id);
  history.replaceState(null, "", url);
  render();
  return task;
}
function consumedDraftFields(name, payload, stage) {
  if (["handoff", "revise", "archive"].includes(name)) return ["*"];
  if (name === "save") return Object.keys(payload.data || {});
  if (name === "generate") return stage === "research" ? ["sourceText", "body"]
    : stage === "writing" ? ["script", "body", "hook", "cover", "shots", "teleprompter", "corrections"] : ["prediction"];
  return ({ check_sources: ["sourceText", "body"], inspect_media: ["sourcePath"],
    transcribe: ["sourcePath", "cuts", "segments"], suggest_cuts: ["cuts"],
    prepare_media: ["sourcePath", "cuts", "aspectRatio", "segments"], export_media: ["segments", "captionPosition"],
    import_final: ["sourcePath", "cuts", "segments", "aspectRatio"], render_cover: ["coverTitle"],
    prepare_publish: ["prediction", "targets"], complete_retro: ["retro"], draft_retro: ["retro"],
    collect_metrics: ["metrics." + payload.targetId], record_publish: ["receipt." + payload.targetId] })[name] || [];
}
async function action(name, payload = {}, show = true) {
  const source = operation?.task || selected;
  if (!source) throw new Error("请先打开一个任务。");
  const epoch = viewEpoch;
  const taskId = source.id;
  const response = await api("/api/workbench/tasks/" + taskId + "/action", { ...payload, action: name, revision: source.revision });
  const updated = response.task;
  if (operation) operation.task = updated;
  drafts.reconcile(taskId, source.stage, updated.revision, updated.version, consumedDraftFields(name, payload, source.stage));
  const canUpdate = viewEpoch === epoch && selected?.id === taskId && role === source.stage;
  await loadTasks();
  if (canUpdate && viewEpoch === epoch && selected?.id === taskId) {
    selected = updated;
    if (show) {
      if (role !== updated.stage) {
        selection[updated.stage] = updated.id;
        navigate(updated.stage);
        if (operation) operation.displayEpoch = viewEpoch;
      } else render();
    }
  }
  const failures = updated.actionFailures || [];
  if (failures.length) throw new Error("部分目标待处理：" + failures.map((item) => item.error).join("。"));
  if (updated.coverNotice) throw new Error(updated.coverNotice);
  const notices = { save: "已保存", prepare_publish: "发布预览已保存，尚未发布", check_sources: "来源核对已保存", generate: "生成结果已保存", handoff: "阶段产物已交接" };
  if (operation) operation.notice = (notices[name] || "操作已完成") + " · " + updated.version + " · 修订 " + updated.revision + " · " + localDate(updated.updatedAt);
  return updated;
}

function selectTask(task) {
  selection[task.stage] = task.id;
  if (role !== task.stage) navigate(task.stage);
  else return openTask(task.id);
}

function taskList(currentRole, { excludeId, start = 0, end, compact = end !== undefined } = {}) {
  const wrap = el("div", "studio-task-browser");
  const rowsArea = el("div", currentRole === "home" ? "studio-tasks index-tasks" : "studio-tasks");
  const key = currentRole + ":" + start;
  const filters = taskFilters.get(key) || { query: "", status: "", page: 1 };
  taskFilters.set(key, filters);
  const query = field("查找任务", filters.query, { placeholder: "标题或 CONTENT-ID" });
  const statusFilter = field("任务状态", filters.status, { choices: { "": "所有状态", ...states } });
  const pagination = el("div", "studio-pagination");
  pagination.setAttribute("aria-live", "polite");
  function draw() {
    rowsArea.replaceChildren();
    const result = taskPage(tasks, { role: currentRole, excludeId, start,
      query: compact ? "" : filters.query, status: compact ? "" : filters.status,
      page: compact ? 1 : filters.page, size: compact ? end - start : 12 });
    filters.page = result.page;
    if (!result.rows.length) rowsArea.append(el("p", "studio-muted", filters.query || filters.status ? "没有匹配的任务，试试其他关键词或状态。" : "暂无工作任务。"));
    for (const task of result.rows) {
      const pick = button("", () => selectTask(task));
      pick.classList.add("studio-task");
      if (selected?.id === task.id) {
        pick.classList.add("is-selected");
        pick.setAttribute("aria-current", "true");
      }
      const details = el("span", "studio-task-detail");
      details.append(el("strong", "", task.title || task.id), el("small", "studio-ID", task.id));
      const stageLabel = currentRole === "home" && roles[task.stage] ? roles[task.stage].title + " · " : "";
      const status = el("span", "studio-task-status", stageLabel + (states[task.status] || task.status));
      status.dataset.status = task.status;
      pick.append(details, status);
      if (currentRole === "home") {
        const arrow = el("span", "studio-task-arrow", "↗");
        arrow.setAttribute("aria-hidden", "true");
        pick.append(arrow);
      }
      rowsArea.append(pick);
    }
    pagination.replaceChildren(el("span", "studio-muted", `共 ${result.total} 项 · ${result.page} / ${result.pages} 页`));
    if (result.pages > 1) {
      const prev = button("上一页", () => { filters.page--; draw(); });
      const next = button("下一页", () => { filters.page++; draw(); });
      prev.disabled = result.page === 1;
      next.disabled = result.page === result.pages;
      pagination.append(prev, next);
    }
  }
  for (const [name, input] of [["query", query], ["status", statusFilter]]) input.input.addEventListener("input", () => {
    filters[name] = input.get(); filters.page = 1; draw();
  });
  if (!compact) wrap.append(line(query.wrap, statusFilter.wrap));
  wrap.append(rowsArea);
  if (!compact) wrap.append(pagination);
  draw();
  return wrap;
}

function newTask({ inline = false } = {}) {
  const previousContext = draftContext;
  const context = { task: { id: "intake", version: "intake", revision: 0 }, stage: role, isIntake: true, fields: new Map() };
  draftContext = context;
  const title = field("任务标题", "", { draftKey: "title" });
  const goal = field(role === "research" ? "想法、关键词或竞品账号" : "处理目标", "", { draftKey: "goal" });
  const format = field("内容形式", "video", { draftKey: "format", choices: { video: "视频", text: "文字", image: "图文" } });
  const input = field("已有稿件或研究材料", "", { draftKey: "text", type: "textarea", placeholder: "可留空" });
  const sourcePath = field("本地原片或成片路径", "", { draftKey: "sourcePath", placeholder: "/Users/…/video.mp4" });
  draftContext = previousContext;
  const add = button("新建任务", async () => {
    if (!title.get()) { title.input.focus(); throw new Error("请先填写任务标题。"); }
    await create(role, title.get(), goal.get(), format.get(), { text: input.get(), sourcePath: sourcePath.get() }, { clearIntake: true });
  }, true);
  const form = el(inline ? "div" : "details", inline ? "studio-intake" : "studio-new");
  if (!inline) {
    form.open = !selected && role !== "research";
    form.append(el("summary", "", "新建任务"));
  }
  form.dataset.intake = "true";
  context.status = el("div", "studio-draft-status studio-intake-status");
  context.status.setAttribute("role", "status");
  form.append(title.wrap, goal.wrap, format.wrap, role === "editing" ? sourcePath.wrap : input.wrap, add, context.status);
  updateDraftStatus(context);
  return form;
}
function dashboardLead(current) {
  const lead = el("header", "studio-lead");
  const intro = el("div", "studio-lead-title");
  intro.append(el("h1", "", "自媒体工作台"));
  const actions = el("div", "studio-lead-actions");
  actions.append(button("开始选题  ↗", () => navigate("research"), true));
  if (current) {
    const openPreview = current.status === "AWAITING_PUBLISH_CONFIRMATION";
    const recent = button(openPreview ? "打开发布预览" : "继续最近任务", () => selectTask(current));
    recent.classList.add("studio-quiet-action");
    actions.append(recent);
  }
  intro.append(actions);

  const scene = el("figure", "studio-space");
  const image = el("img");
  image.alt = "窗边的木质书桌、浅色石墙和庭院树影";
  image.width = 1672;
  image.height = 941;
  image.fetchPriority = "high";
  image.src = "/assets/architecture-study.jpg";
  scene.append(image);
  lead.append(intro, scene);
  return lead;
}

function currentTaskPreview(task) {
  const feature = el("div", "studio-featured");
  const details = el("div", "studio-featured-text");
  const isPreview = task.status === "AWAITING_PUBLISH_CONFIRMATION";
  details.append(el("p", "studio-featured-status", states[task.status] || task.status));
  const opening = button(task.title || task.id, () => selectTask(task));
  opening.classList.add("studio-current-task");
  details.append(opening, el("p", "studio-ID", task.id));
  feature.append(details);
  if (isPreview) {
    const figure = el("figure", "studio-featured-art");
    const image = el("img");
    image.alt = task.title + "的发布封面";
    image.height = 128;
    image.width = 72;
    image.addEventListener("error", () => { figure.remove(); feature.classList.remove("has-art"); });
    image.src = uri(task, "cover");
    figure.append(image);
    feature.classList.add("has-art");
    feature.append(figure);
  }
  return feature;
}

function dashboard() {
  const current = tasks.find((task) => roles[task.stage] && !["ARCHIVED", "REJECTED"].includes(task.status));
  const modules = el("section", "studio-modules");
  modules.append(el("h2", "studio-section-title", "内容工作流"));
  const grid = el("div", "studio-entries");
  for (const [key, item] of Object.entries(roles)) {
    const entry = button("", () => navigate(key));
    entry.classList.add("studio-entry");
    const top = el("span", "studio-entry-top");
    top.append(el("span", "studio-entry-index", item.number), el("span", "studio-entry-arrow", "↗"));
    top.setAttribute("aria-hidden", "true");
    entry.append(top, el("strong", "", item.title), el("span", "studio-entry-desc", item.subtitle));
    grid.appendChild(entry);
  }
  modules.append(grid);
  const queue = panel("继续待办");
  queue.classList.add("studio-queue");
  if (current) queue.append(currentTaskPreview(current));
  const previousCount = tasks.filter((task) => task.id !== current?.id).length;
  if (!current || previousCount) queue.append(taskList("home", { excludeId: current?.id, end: 2 }));
  if (previousCount > 2) {
    const history = el("details", "studio-task-history");
    history.append(el("summary", "", "更多任务"), taskList("home", { excludeId: current?.id, start: 2 }));
    queue.append(history);
  }
  const lower = el("div", "studio-home-work");
  lower.append(modules, queue);
  return [dashboardLead(current), lower];
}

function trendsPanel() {
  const area = el("div", "studio-trends");
  area.append(el("div", "studio-muted", "正在读取热点监控…"));
  function draw() {
    const snapshot = latestTrends;
    if (!snapshot) return;
    const sourceFilter = field("来源", trendFilters.source, { choices: { "": "所有来源", ...Object.fromEntries(snapshot.sources.map((s) => [s.id, s.label])) } });
    const scope = field("时间", trendFilters.scope, { choices: {
      board: "当前榜单快照", published24: "来源标注发布 · 最近 24 小时", published72: "来源标注发布 · 最近 3 天", submitted24: "社区帖子提交 · 最近 24 小时"
    } });
    const term = field("关键词 / 主题", trendFilters.term, { placeholder: "AI Agent、编程、教育…" });
    const results = el("div", "studio-trend-list");
    const sourceList = el("details", "studio-new");
    sourceList.append(el("summary", "", "监控来源和健康状态"));
    for (const source of snapshot.sources) {
      const label = link(source.url, source.label);
      const sourceStatus = el("small", "studio-source-status", (sourceStates[source.status] || source.status) + " · 上次成功 " + localDate(source.lastSuccessAt));
      sourceStatus.dataset.status = source.status;
      const controls = [label, sourceStatus];
      if (source.available) controls.push(button(source.enabled ? "停用" : "启用", async () => {
        latestTrends = await api("/api/trends/sources/" + source.id, { enabled: !source.enabled }); draw();
      }));
      if (source.lastError) controls.push(el("small", "studio-muted", source.lastError));
      if (source.lastWarning) controls.push(el("small", "studio-muted", source.lastWarning));
      if (source.lastPartialAt) controls.push(el("small", "studio-muted", "最近部分更新 " + localDate(source.lastPartialAt)));
      if (source.itemErrors?.length) controls.push(el("small", "studio-muted", "本轮未取得 " + source.itemErrors.length + " 条详情"));
      if (source.responseCache?.stale) controls.push(el("small", "studio-muted", "上游明确标记为旧缓存"));
      if (Number.isFinite(source.responseCache?.ageSeconds)) controls.push(el("small", "studio-muted", `上游缓存响应年龄 ${source.responseCache.ageSeconds} 秒`));
      if (source.nextRefreshAt && source.enabled) controls.push(el("small", "studio-muted", "下次检测 " + localDate(source.nextRefreshAt)));
      sourceList.append(line(...controls));
    }
    function filtered() {
      const timeScope = scope.get();
      const cutoff = Date.now() - (timeScope === "published72" ? 72 : 24) * 3_600_000;
      const groups = snapshot.groups?.length ? snapshot.groups : (snapshot.items || []).map((item) => ({ title: item.title, url: item.url, items: [item], evidence: item.evidence || [] }));
      results.replaceChildren();
      for (const trend of groups) {
        const matches = trend.items.filter((item) => {
          if (sourceFilter.get() && sourceFilter.get() !== item.sourceId) return false;
          if (timeScope === "board") return true;
          const timestamp = Date.parse(timeScope === "submitted24" ? item.submittedAt : item.sourceId === "hn" ? null : item.publishedAt);
          return timestamp >= cutoff && timestamp <= Date.now();
        });
        if (!matches.length || ![trend.title, ...matches.map((item) => item.title + " " + (item.summary || ""))].join(" ").toLowerCase().includes(term.get().toLowerCase())) continue;
        const detail = el("div", "studio-trend-card");
        detail.append(el("strong", "", trend.title));
        for (const item of matches) {
          const source = snapshot.sources.find((entry) => entry.id === item.sourceId);
          const signal = [
            source?.label,
            item.rank ? (item.rankKind === "reported_rank" ? "来源排名 " : "榜单顺位 ") + item.rank : "",
            item.rankDelta ? (item.rankDelta > 0 ? "上升 " : "下降 ") + Math.abs(item.rankDelta) : "",
            Number.isFinite(item.score) ? "社区 " + item.score + " 分" : "",
            Number.isFinite(item.comments) ? item.comments + " 条讨论" : "",
            item.stale ? "快照已过期" : item.cached ? "上次成功的快照" : ""
          ].filter(Boolean).join(" · ");
          detail.append(el("small", "", signal));
          const published = item.sourceId === "hn" ? null : item.publishedAt;
          const stamps = [
            published ? "来源标注发布 " + localDate(published) : "发布时刻未知",
            item.submittedAt ? "社区提交 " + localDate(item.submittedAt) : "",
            item.updatedAt ? "来源标注更新 " + localDate(item.updatedAt) : "",
            "榜单采集 " + localDate(item.collectedAt || item.observedAt || source?.lastSuccessAt)
          ];
          detail.append(el("small", "", stamps.filter(Boolean).join(" · ")));
        }
        const related = matches.flatMap((item) => item.evidence || []);
        const references = [...new Map(related.filter((item) => item.url && item.kind !== "original").map((item) => [item.url, item])).values()];
        if (references.length) detail.append(line(...references.map((item) => link(item.url, item.label))));
        const entry = matches[0];
        detail.append(line(link(entry.originalUrl || entry.url || trend.url, entry.originalUrl ? "查看来源链接 ↗" : "打开榜单条目 ↗"),
          button("带入研究", () => create("research", trend.title, "核对热点和适合的选题角度", "video", {
            sources: matches, signals: trend.evidence
          }))));
        results.append(detail);
      }
      if (!results.children.length) results.append(el("p", "studio-muted", "这个筛选下暂无可展示的快照。"));
    }
    for (const [name, input] of Object.entries({ source: sourceFilter, scope, term })) input.input.oninput = () => {
      trendFilters[name] = input.get();
      filtered();
    };
    const filters = line(sourceFilter.wrap, scope.wrap, term.wrap);
    filters.classList.add("studio-filters");
    const commands = line(
      button("刷新热点", async () => {
        latestTrends = await api("/api/trends/refresh", { source: sourceFilter.get() || undefined });
        trendOutcomes = latestTrends.outcomes || [];
        draw();
      }, true),
      button("小红书竞品研究", () => document.getElementById("open-xhs-research").click())
    );
    commands.classList.add("studio-trend-commands");
    const refresh = el("div", "studio-refresh-result");
    refresh.setAttribute("role", "status");
    const statusText = {
      ok: "采集成功", partial: "部分更新，部分条目未取得", unchanged: "来源确认榜单无变化", cooldown: "暂未发起请求，仍在退避期",
      failed: "请求失败", candidate: "候选来源", disabled: "来源已停用", waiting: "尚未到计划刷新时间"
    };
    for (const event of trendOutcomes) {
      const source = snapshot.sources.find((item) => item.id === event.sourceId);
      const parts = [source?.label || event.sourceId, statusText[event.status] || event.status];
      if (["failed", "cooldown"].includes(event.status)) {
        const prior = event.lastSuccessAt || source?.lastSuccessAt;
        const retry = event.retryAt || source?.cooldownUntil;
        parts.push(prior ? "继续显示 " + localDate(prior) + " 的快照" : "暂无成功快照");
        if (retry) parts.push("可重试 " + localDate(retry));
      }
      if (event.error) parts.push(event.error);
      if (event.lastWarning) parts.push(event.lastWarning);
      if (event.itemErrors?.length) parts.push("缺少 " + event.itemErrors.length + " 条详情");
      if (event.responseCache?.stale) parts.push("上游明确标记为旧缓存");
      refresh.append(el("small", "studio-muted", parts.join(" · ")));
    }
    area.replaceChildren(commands, refresh, filters, sourceList, results);
    filtered();
  }
  if (latestTrends) draw();
  api("/api/trends").then((data) => { latestTrends = data; if (area.isConnected) draw(); })
    .catch((error) => area.replaceChildren(el("p", "studio-error", error.message)));
  return panel("热点监控", area);
}
function feedbackPanel(currentRole) {
  const content = el("div", "studio-muted", "读取复盘反馈…");
  api("/api/workbench/feedback/" + currentRole).then(({ feedback }) => {
    content.replaceChildren();
    if (!feedback.length) content.textContent = "暂无已完成的实绩复盘。";
    for (const item of feedback.slice(0, 8)) {
      content.append(textBlock([item.title || item.taskId || item.id, item.text || item.note || item.feedback || item[currentRole], item.nextExperiment].filter(Boolean).join("\n") || json(item)));
    }
  }).catch((error) => { content.textContent = error.message; });
  return panel("复盘回流", content);
}

function sourceDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localDate(value);
}

function passageLabel(passage) {
  const ordinal = /:paragraph:(\d+)$/.exec(passage?.source)?.[1];
  return ordinal ? `原文第 ${ordinal} 段` : "原文段落";
}

function researchSources(data) {
  const sources = Array.isArray(data.sourceChecks) ? data.sourceChecks : [];
  if (!sources.length) return null;
  const proof = panel("来源核对");
  proof.classList.add("studio-source-proof");
  if (data.checkedSourceText !== undefined && data.sourceText !== data.checkedSourceText) {
    proof.append(el("p", "studio-muted", "来源备注已修改，下面保留上一次核对记录。"));
  }
  const kinds = { official: "发布方", community: "社区讨论", catalog: "索引页", publisher: "媒体或出版方" };
  for (const source of sources) {
    const excerpt = source.status === "read" && source.excerpt;
    const row = el("article", "studio-source-row");
    const headline = [source.evidenceId, source.title || "打开来源 ↗"].filter(Boolean).join(" · ");
    row.append(link(source.excerptUrl || source.url, headline));
    const state = excerpt ? "已取得可定位文本" : { read: "旧记录仅核对了标题和简介", metadata: "仅取得标题或简介", unavailable: "暂未取得正文", manual: "待人工打开" }[source.status];
    row.append(el("small", "studio-muted", [state, kinds[source.sourceKind], source.publisher, source.message].filter(Boolean).join(" · ")));
    const cache = source.cache || {};
    const response = [
      Number.isInteger(source.httpStatus) && !source.message?.includes(`HTTP ${source.httpStatus}`) && `HTTP ${source.httpStatus}`,
      cache.stale ? "上游标记为旧缓存" : cache.xCacheStatus || cache.xCache || cache.cfCacheStatus,
      Number.isFinite(cache.ageSeconds) && `缓存响应年龄 ${cache.ageSeconds} 秒`
    ].filter(Boolean);
    if (response.length) row.append(el("small", "studio-muted", response.join(" · ")));
    const dates = [
      source.publishedAt && (source.sourceKind === "community" ? "讨论页日期 " : "页面标注发布 ") + sourceDate(source.publishedAt),
      source.updatedAt && "页面标注更新 " + sourceDate(source.updatedAt),
      source.checkedAt && "核对于 " + localDate(source.checkedAt)
    ].filter(Boolean);
    if (dates.length) row.append(el("small", "studio-muted", dates.join(" · ")));
    if (source.dateConflicts && Object.keys(source.dateConflicts).length) {
      const conflict = el("details", "studio-new");
      conflict.append(el("summary", "", "页面标注的时间有冲突，待人工核对"));
      for (const [field, values] of Object.entries(source.dateConflicts)) {
        for (const value of values) conflict.append(el("small", "studio-muted", `${field === "updatedAt" ? "更新" : "发布"} · ${value.raw} · ${value.from}`));
      }
      row.append(conflict);
    }
    if (source.duplicateOf) row.append(el("small", "studio-muted", source.originMatch === "same_url"
      ? `与 ${source.duplicateOf} 指向同一原文` : `与 ${source.duplicateOf} 的正文片段相同，可能同源`));
    const attribution = [...new Set((source.declaredAttribution || []).map((item) => item.publisher))].filter(Boolean);
    if (attribution.length) row.append(el("small", "studio-muted", "报道中明确引用 " + attribution.join("、") + "。独立采写情况待核。"));
    if (source.requestedUrl && source.requestedUrl !== source.url) row.append(line(link(source.requestedUrl, "请求链接"), link(source.url, "最终页面")));
    if (source.canonicalUrl && source.canonicalUrl !== source.url) row.append(link(source.canonicalUrl, "页面声明的标准链接"));
    if (excerpt) {
      row.append(el("blockquote", "", excerpt));
      if (source.excerptFrom === "hn-comment") row.append(el("small", "studio-muted", "来源是讨论中的一条公开留言"));
      else if (source.passages?.length) row.append(el("small", "studio-muted", passageLabel(source.passages[0])));
      if (source.passages?.length > 1) {
        const rest = el("details", "studio-new");
        rest.append(el("summary", "", "更多原文段落"));
        source.passages.slice(1).forEach((passage) => {
          rest.append(el("blockquote", "", passage.text), link(passage.url || source.url, "打开" + passageLabel(passage)));
        });
        row.append(rest);
      }
    }
    if (source.previousRead) {
      const old = el("details", "studio-new");
      old.append(el("summary", "", "上次可读原文 · " + localDate(source.previousRead.checkedAt)),
        el("blockquote", "", source.previousRead.excerpt), link(source.previousRead.url, "打开上次核对的链接 ↗"));
      row.append(old);
    }
    proof.append(row);
  }
  if (data.claims?.length) {
    const citations = el("details", "studio-new");
    citations.append(el("summary", "", "模型引用对照"), el("p", "studio-muted", "原句已定位，结论与原句的对应关系仍待核对。"));
    for (const item of data.claims) citations.append(textBlock(`${item.sourceId} · ${item.claim}\n${item.quote}`));
    proof.append(citations);
  }
  return proof;
}

function research(task, data) {
  const sourceText = field("原始来源与竞品证据", data.sourceText || task.inputs?.text || "", { draftKey: "sourceText", type: "textarea", placeholder: "原文链接、原帖数据、竞品开头或评论摘要" });
  const notes = field("选题、写作角度与证据", data.body || "", { draftKey: "body", type: "textarea" });
  const out = [];
  if (task.inputs?.sources?.length) {
    out.push(line(...task.inputs.sources.map((source) => link(source.originalUrl || source.url || source, source.title || "发现线索 ↗"))));
  }
  const sources = researchSources(data);
  const input = () => ({ sourceText: sourceText.get(), body: notes.get() });
  return panel("选题研究", ...out, sourceText.wrap,
    line(button("核对来源", () => action("check_sources", { input: input() }), true)),
    ...(sources ? [sources] : []), notes.wrap,
    line(button("保存研究", () => action("save", { data: { body: notes.get(), sourceText: sourceText.get() } })),
      button("分析热点与竞品", () => action("generate", { input: input() }), true),
      button("研究并直接出稿", () => action("generate", { input: input(), autoDraft: true })),
      button("采用选题并交给文案", async () => {
        if (!notes.get()) throw new Error("先保存选题和写作角度。");
        await action("save", { data: { body: notes.get(), sourceText: sourceText.get() } }, false);
        await action("confirm_topic", { confirmation: "确认采用本页选题及写作角度" }, false);
        await action("handoff", { toStage: "writing", note: "用户采用选题" });
      })));
}
function writing(task, data) {
  const previous = task.stages?.research?.data;
  const format = task.format === "video" ? "口播正文" : "正文";
  const script = field(format, data.script || data.body || task.inputs?.text || "", { draftKey: "script", type: "textarea" });
  script.input.rows = 14;
  const hook = field("开头 / 钩子", data.hook, { draftKey: "hook" });
  const cover = field("封面文案", data.cover, { draftKey: "cover" });
  const shots = field("拍摄清单与分镜", data.shots, { draftKey: "shots", type: "textarea" });
  const teleprompter = field("提词器", data.teleprompter, { draftKey: "teleprompter", type: "textarea" });
  const corrections = field("本轮写作要求", "", { draftKey: "corrections", placeholder: "补充案例、修正角度或调整时长" });
  function draft() { return { script: script.get(), body: script.get(), hook: hook.get(), cover: cover.get(), shots: shots.get(), teleprompter: teleprompter.get() }; }
  const incoming = previous?.body ? panel("已交接选题", textBlock(previous.body)) : el("span");
  return panel("文案编辑", incoming, corrections.wrap,
    line(button("生成稿件", () => action("generate", { input: { corrections: corrections.get(), previousDraft: script.get() } }), true)),
    hook.wrap, cover.wrap, script.wrap, shots.wrap, teleprompter.wrap,
    line(button("保存稿件", () => action("save", { data: draft() })),
      button(task.format === "video" ? "交给剪辑" : "交给发布与数据", async () => {
        if (!script.get()) throw new Error("请填写或生成正文。");
        await action("handoff", { data: draft(), toStage: task.format === "video" ? "editing" : "analytics", note: "交接当前稿件版本" });
      }, true)));
}
function uri(task, name) { return "/api/workbench/tasks/" + task.id + "/media/" + name; }
function playback(task, name) {
  const video = el("video", "studio-video");
  video.controls = true;
  video.preload = "metadata";
  video.src = uri(task, name);
  if (name === "final" && (task.stages.analytics?.data?.cover || task.stages.editing?.data?.cover)) {
    video.poster = uri(task, "cover");
  }
  return video;
}
function editing(task, data) {
  const source = field("本地原片或成片的完整路径", data.sourcePath || task.inputs?.sourcePath, { draftKey: "sourcePath", placeholder: "/Users/…/video.mp4" });
  const aspectRatio = field("画幅", data.prepared?.media?.aspectRatio || "original", { draftKey: "aspectRatio", choices: { original: "原画幅", "9:16": "9:16 竖屏", "16:9": "16:9 横屏", "1:1": "1:1 方形" } });
  const cuts = field("删除区间（秒）", json(data.cuts || []), { draftKey: "cuts", type: "textarea", placeholder: '[{"start":4.2,"end":5.5,"reason":"口误"}]' });
  const segments = field("剪后字幕时间码及文字", json(data.prepared?.segments || []), { draftKey: "segments", type: "textarea" });
  const position = field("字幕位置", "auto", { draftKey: "captionPosition", choices: { auto: "根据人脸安全区建议", bottom: "下方", top: "上方" } });
  const output = panel("原片与转写", source.wrap, line(
    button("检查原片", () => action("inspect_media", { sourcePath: source.get() })),
    button("转写并找删改候选", () => action("transcribe", { sourcePath: source.get() }), true),
    button("导入已有成片", () => action("import_final", { sourcePath: source.get() }))
  ));
  if (data.inspection) output.append(el("p", "studio-muted", (data.inspection.duration ?? "?") + " 秒 · " + data.inspection.width + " × " + data.inspection.height));
  if (task.stages.writing?.data?.script) {
    const script = el("details", "studio-new");
    script.append(el("summary", "", "查看拍摄稿"), textBlock(task.stages.writing.data.script));
    output.append(script);
  }
  if (data.transcript) {
    const transcript = el("details", "studio-new");
    transcript.append(el("summary", "", "查看转写"), textBlock(data.transcript.text));
    output.append(transcript);
    output.append(button("让模型复查删改候选", () => action("suggest_cuts")));
  }
  const cutConfirm = field("我已审阅删改和画幅", false, { type: "checkbox" });
  output.append(panel("剪辑与人声", cuts.wrap, aspectRatio.wrap, cutConfirm.wrap, line(button("剪辑并准备字幕", () => action("prepare_media", {
    sourcePath: source.get(), cuts: arrayInput(cuts.get(), "删除区间"), aspectRatio: aspectRatio.get(), confirmed: cutConfirm.get()
  }), true))));
  if (data.prepared) {
    const captionConfirm = field("我已确认字幕文字、时间和人脸安全位置", false, { type: "checkbox" });
    output.append(panel("剪后预览与字幕", playback(task, "working"), segments.wrap, position.wrap, captionConfirm.wrap,
      button("渲染成片", () => action("export_media", { segments: arrayInput(segments.get(), "字幕"), captionPosition: position.get(), confirmed: captionConfirm.get() }), true)));
  }
  if (data.asset) {
    const confirm = field("已播放开头、中段和结尾，核对口型、音轨和画面", data.verified, { type: "checkbox" });
    const coverTitle = field("封面标题", task.stages.writing?.data?.cover || task.title, { draftKey: "coverTitle" });
    const report = data.asset.reportPath ? el("p", "studio-muted", "质检报告 " + data.asset.reportPath) : el("span");
    output.append(panel("成片质检", playback(task, "final"), report, coverTitle.wrap,
      ...(data.cover ? [Object.assign(el("img", "studio-cover"), { src: uri(task, "cover"), alt: "本地成片封面" })] : []),
      confirm.wrap, line(button("从原片帧准备封面", () => action("render_cover", { title: coverTitle.get() })),
        button("确认成片并交给数据台", async () => {
          if (!confirm.get()) throw new Error("请先播放并核对成片。");
          await action("handoff", { data: { verified: true, videoPath: data.videoPath }, toStage: "analytics", note: "已核对字幕、口型、音轨和画面" });
        }, true))));
  }
  return output;
}
function metricInputs(task, publication) {
  const receipt = "receipt." + publication.targetId + ".";
  const metric = "metrics." + publication.targetId + ".";
  const url = field("作品链接", publication.url || "", { draftKey: receipt + "url", type: "url" });
  const post = field("作品 ID", publication.platformPostId || "", { draftKey: receipt + "id" });
  const date = field("发布时间", "", { draftKey: receipt + "time", type: "datetime-local" });
  const last = publication.attempts?.at(-1);
  const group = el("div", "studio-pub");
  group.append(el("h3", "", (platformNames[publication.target.platform] || publication.target.platform) + " · " + publication.target.account),
    el("p", "studio-muted", ({
      pending: "等待执行", in_progress: "提交结果待核实", unknown: "结果未知，先核对平台作品列表",
      failed: "平台执行失败", published: "已登记发布", skipped: "已退出此批次"
    })[publication.state] || publication.state));
  if (publication.reason) group.append(el("p", "studio-muted", publication.reason));
  if (publication.url) group.append(link(publication.url, "查看已登记作品 ↗"));
  if (publication.state !== "published" && publication.state !== "skipped" && last) {
    group.append(line(url.wrap, post.wrap, date.wrap), line(
      button("核实并登记结果", () => action("record_publish", {
        targetId: publication.targetId, attemptId: last.id, state: "published",
        url: url.get(), platformPostId: post.get(), publishedAt: toIso(date.get())
      })),
      button("核实未发出", () => action("record_publish", {
        targetId: publication.targetId, attemptId: last.id, state: "failed",
        reason: "用户已检查该账号作品列表，确认未创建作品", confirmedUnpublished: true
      }))
    ));
  }
  if (publication.state === "published" && publication.version === task.version) {
    const views = field("播放 / 曝光", "", { draftKey: metric + "views", type: "number" });
    const likes = field("点赞", "", { draftKey: metric + "likes", type: "number" });
    const comments = field("评论", "", { draftKey: metric + "comments", type: "number" });
    const completion = field("完播率（0–1）", "", { draftKey: metric + "completion", type: "number" }); completion.input.step = "0.0001";
    const followers = field("转粉", "", { draftKey: metric + "followers", type: "number" });
    const shares = field("分享", "", { draftKey: metric + "shares", type: "number" });
    const collected = field("数据取样时间", "", { draftKey: metric + "collected", type: "datetime-local" });
    const source = field("后台来源链接或截图引用", "", { draftKey: metric + "source" });
    const manual = el("details", "studio-new");
    manual.append(el("summary", "", "录入创作者后台实绩"), line(views.wrap, likes.wrap, comments.wrap),
      line(completion.wrap, followers.wrap, shares.wrap), line(collected.wrap, source.wrap),
      button("校验并回填数据", () => {
        const metrics = Object.fromEntries(Object.entries({ views, likes, comments, completion_rate: completion,
          followers_gained: followers, shares }).filter(([, input]) => input.get() !== "").map(([key, input]) => [key, Number(input.get())]));
        return action("collect_metrics", { targetId: publication.targetId, snapshot: {
          platform: publication.target.platform, platform_post_id: publication.platformPostId || undefined,
          platform_url: publication.url || undefined, collected_at: toIso(collected.get()) || new Date().toISOString(),
          source_url: source.get() || publication.url, source_type: "creator_center_snapshot", metrics
        } });
      }));
    const lastData = publication.snapshots?.at(-1);
    if (lastData) group.append(textBlock("最近快照 " + localDate(lastData.collectedAt || lastData.collected_at) + "\n" + json(lastData.metrics)));
    group.append(el("small", "studio-muted", "实绩回收日期 " + localDate(publication.retroDueAt)), manual);
    if (publication.target.platform === "x") group.append(button("用已授权的 xurl 读取公开指标", () =>
      action("collect_metrics", { targetId: publication.targetId })));
  }
  return group;
}

function localInputTime(value) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value));
  const { year, month, day, hour, minute } = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return year + "-" + month + "-" + day + "T" + hour + ":" + minute;
}
function toIso(value) {
  if (!value) return "";
  const date = new Date(value + "+08:00");
  if (!Number.isFinite(date.valueOf())) throw new Error("时间格式无效。");
  return date.toISOString();
}
function analytics(task, data) {
  const context = draftContext;
  const storedDraft = draftEntry(context);
  const currentDraft = storedDraft?.revision === task.revision && storedDraft.version === task.version ? storedDraft : null;
  const staleDraft = storedDraft && !currentDraft;
  const editingData = task.stages.editing?.data || {};
  const writingData = task.stages.writing?.data || {};
  const coverPath = data.cover?.coverPath || editingData.cover?.coverPath || "";
  const filePath = editingData.videoPath || editingData.asset?.filePath || task.inputs?.sourcePath || "";
  const input = writingData.script || task.inputs?.text || "";
  const prediction = field("发布前预测与依据", data.body || task.batch?.prediction?.body || task.batch?.prediction || "", { draftKey: "prediction", type: "textarea",
    placeholder: "给出播放、互动、转粉、风险假设和验证窗口" });
  const header = panel("发布材料与预测");
  if (coverPath || (filePath && editingData.asset)) {
    const assets = el("div", "studio-assets");
    if (filePath && editingData.asset) {
      const sample = el("figure", "studio-asset");
      sample.append(playback(task, "final"), el("figcaption", "", "待发布成片"));
      assets.append(sample);
    }
    if (coverPath) {
      const sheet = el("figure", "studio-asset");
      sheet.classList.add("studio-asset-cover");
      sheet.append(Object.assign(el("img", "studio-cover"), { src: uri(task, "cover"), alt: "本地封面预览" }),
        el("figcaption", "", "发布封面"));
      assets.append(sheet);
    }
    header.append(assets);
  }
  header.append(prediction.wrap, line(
    button("生成预测与发布文案", () => action("generate", { input: { artifact: filePath, published: task.publications.some((item) => item.version === task.version && item.state === "published") } }), true)
  ));
  if (editingData.asset) header.append(button("准备真实画面封面", () => action("render_cover", { title: writingData.cover || task.title })));

  const targetRows = [];
  const targetArea = el("div", "studio-pub-targets");
  const activePublications = task.publications.filter((item) => item.version === task.version);
  const occupied = activePublications.some((item) => ["published", "in_progress", "unknown"].includes(item.state));
  function persistTargets() {
    if (staleDraft) return;
    const previous = draftEntry(context);
    drafts.write(task.id, context.stage, { revision: task.revision, version: task.version,
      values: { ...(previous?.values || {}), targets: targetRows.map((item) => item.draft()) } });
    updateDraftStatus(context);
  }
  function addTarget(target = {}) {
    const row = el("div", "studio-pub");
    const platform = field("平台", target.platform || "tencent", { choices: platformNames });
    const account = field("账号别名", target.account ?? "");
    const title = field("标题", target.title ?? (data.title || task.title));
    const file = field("成品文件", target.file ?? filePath);
    const cover = field("封面路径", target.cover ?? coverPath);
    const description = field("简介", target.description ?? (data.description || ""), { type: "textarea" });
    const content = field(task.format === "video" ? "X 正文（可选）" : "发布正文", target.content ?? (task.format === "video" ? "" : input), { type: "textarea" });
    const publishAt = field("发布时间（空白即立即，北京时间）", target.publishAtLocal ?? (target.publishAt ? localInputTime(target.publishAt) : ""), { type: "datetime-local" });
    const autoCollect = field("使用已经授权的 xurl 在 T+3 回收 X 公开指标", target.autoCollect || false, { type: "checkbox" });
    const updatePlatform = () => {
      autoCollect.wrap.hidden = platform.get() !== "x";
      cover.wrap.hidden = platform.get() === "x";
    };
    updatePlatform();
    platform.input.onchange = updatePlatform;
    const item = { row, draft: () => ({
      platform: platform.get(), account: account.input.value, title: title.input.value, description: description.input.value,
      file: file.input.value, cover: cover.input.value, content: content.input.value, publishAtLocal: publishAt.input.value
    }), read: () => ({
      platform: platform.get(), account: account.get(), title: title.get(), description: description.get(),
      file: file.get(), cover: platform.get() === "x" ? "" : cover.get(), content: content.get(), publishAt: toIso(publishAt.get()), autoCollect: autoCollect.get(), visibility: "public"
    }) };
    targetRows.push(item);
    row.append(line(platform.wrap, account.wrap, title.wrap), line(publishAt.wrap, file.wrap, cover.wrap), content.wrap, description.wrap, autoCollect.wrap,
      button("移除此目标", () => { targetRows.splice(targetRows.indexOf(item), 1); row.remove(); persistTargets(); }));
    row.addEventListener("input", persistTargets);
    row.addEventListener("change", persistTargets);
    if (staleDraft) for (const element of row.querySelectorAll("input, textarea, select, button")) element.disabled = true;
    targetArea.append(row);
  }
  if (!occupied) {
    const initialTargets = Array.isArray(currentDraft?.values.targets) ? currentDraft.values.targets : task.batch?.targets?.length ? task.batch.targets : [{}];
    for (const target of initialTargets) addTarget(target);
    const addPlatform = button("添加平台", () => { addTarget(); persistTargets(); });
    addPlatform.disabled = Boolean(staleDraft);
    header.append(panel("发布目标", targetArea,
      line(addPlatform,
        button("保存发布预览", () => action("prepare_publish", { targets: targetRows.map((item) => item.read()),
          prediction: { body: prediction.get() } }), true))));
  }
  const current = task.batch;
  if (current) {
    const preview = panel("当前发布批次", el("p", "studio-muted",
      task.approval ? "授权已登记 · " + localDate(task.approval.at) : "等待核对并授权"),
      textBlock(current.prediction?.body || ""));
    const readyTargets = [];
    for (const target of current.targets) {
      const publication = task.publications.find((item) => item.targetId === target.id);
      const supported = task.format === "video" && ["douyin", "xiaohongshu", "tencent", "x"].includes(target.platform) &&
        !(target.platform === "x" && (target.publishAt || target.cover));
      const card = el("div", "studio-pub");
      card.append(el("strong", "", (platformNames[target.platform] || target.platform) + " · " + target.account + " · " + target.title),
        el("p", "studio-muted", (target.publishAt ? localDate(target.publishAt) : "立即") + " · 公开 · " + (supported ? "支持工具提交" : "手动发布登记")),
        textBlock([target.file, target.cover, target.description, target.content].filter(Boolean).join("\n")));
      if ((!publication || (publication.state === "failed" && publication.confirmedUnpublished)) && supported && task.approval) {
        readyTargets.push(target);
        card.append(button("提交此作品", async () => {
          if (!window.confirm("确认现在把该版本提交到 " + (platformNames[target.platform] || target.platform) + " 的账号 " + target.account + "？")) return;
          await action("publish_target", { targetId: target.id });
        }, true));
      }
      if (!publication || ["failed", "pending"].includes(publication.state)) {
        const manual = el("details", "studio-new");
        const url = field("作品链接", "", { type: "url" });
        const id = field("平台作品 ID", "");
        const time = field("实际发布时间", "", { type: "datetime-local" });
        manual.append(el("summary", "", "登记已手动发布的作品"), line(url.wrap, id.wrap, time.wrap),
          button("登记作品", () => action("register_publish", {
            target, url: url.get(), platformPostId: id.get(), publishedAt: toIso(time.get())
          })));
        card.append(manual);
      }
      if (!publication || publication.state === "failed") card.append(button("本批跳过该目标", () => {
        if (!window.confirm("确认结束本目标在此批次的发布计划？")) return;
        return action("skip_publish", { targetId: target.id, reason: "用户结束此批次的该平台目标" });
      }));
      preview.append(card);
    }
    if (!task.approval && !occupied) preview.append(button("确认预测与发布范围", () => {
      if (!window.confirm("确认此预览内的作品版本、账号、平台和时间？")) return;
      return action("approve_publish", { batchId: current.id, confirmation: "用户确认页面显示的预测与完整发布范围" });
    }, true));
    if (readyTargets.length > 1) preview.append(button("提交全部已确认的平台", () => {
      const destinations = readyTargets.map((item) => (platformNames[item.platform] || item.platform) + " " + item.account).join("、");
      if (!window.confirm("提交当前预览到 " + destinations + "？")) return;
      return action("publish_selected", { targetIds: readyTargets.map((item) => item.id) });
    }, true));
    header.append(preview);
  }
  if (!current && !task.publications.length) {
    const existing = el("details", "studio-new");
    const platform = field("平台", "tencent", { choices: platformNames });
    const account = field("账号");
    const website = field("作品链接", "", { type: "url" });
    const post = field("作品 ID");
    const time = field("实际发布时间", "", { type: "datetime-local" });
    existing.append(el("summary", "", "直接登记已经发布的作品"), line(platform.wrap, account.wrap, website.wrap, post.wrap, time.wrap),
      button("登记既有作品", () => action("register_publish", {
        target: { platform: platform.get(), account: account.get(), title: task.title },
        platformPostId: post.get(), url: website.get(), publishedAt: toIso(time.get())
      })));
    header.append(existing);
  }

  if (task.publications.length) {
    const receipts = panel("作品回执与实绩", ...task.publications.map((item) => metricInputs(task, item)));
    header.append(receipts);
  }
  if (activePublications.some((item) => item.snapshots?.length)) {
    const retro = data.retro || task.feedback?.at(-1) || {};
    const summary = field("实绩结论", retro.body || retro.summary, { draftKey: "retro.summary", type: "textarea" });
    const selectionNote = field("给 01 的选题反馈", retro.research, { draftKey: "retro.research", type: "textarea" });
    const writingNote = field("给 02 的文案反馈", retro.writing, { draftKey: "retro.writing", type: "textarea" });
    const experiment = field("下轮唯一实验变量", retro.nextExperiment, { draftKey: "retro.nextExperiment" });
    header.append(panel("复盘和回流", summary.wrap, selectionNote.wrap, writingNote.wrap, experiment.wrap,
      line(button("生成复盘草稿", () => action("draft_retro")),
        button("确认复盘并回流", () => action("complete_retro", { summary: summary.get(), research: selectionNote.get(),
          writing: writingNote.get(), nextExperiment: experiment.get() }), true),
        ...(task.status === "RETRO_DONE" ? [button("归档内容", () => action("archive"))] : []))));
  }
  return header;
}
function previousOutputs(task, currentRole) {
  const completed = Object.entries(roles).filter(([key]) => key !== currentRole && task.stages?.[key]?.state === "completed");
  if (!completed.length) return null;
  const rollup = panel("已交接的阶段产物");
  for (const [key, info] of completed) {
    const data = task.stages[key].data || {};
    const section = el("details", "studio-new");
    section.append(el("summary", "", info.number + " " + info.title));
    if (key === "research") {
      section.append(textBlock(data.body || data.content));
      const proof = researchSources(data);
      if (proof) section.append(proof);
      else {
        const sources = Array.isArray(data.sources) ? data.sources : [];
        for (const source of sources) {
          const url = typeof source === "string" ? source : source.url || source.originalUrl;
          if (url) section.append(line(link(url, typeof source === "string" ? "打开来源 ↗" : source.title || "打开来源 ↗")));
        }
      }
    } else if (key === "writing") {
      section.append(textBlock(data.script || data.body));
      if (data.shots) section.append(el("h3", "", "分镜"), textBlock(data.shots));
    } else if (key === "editing" && data.asset) {
      section.append(playback(task, "final"));
      if (data.asset.reportPath) section.append(textBlock("质检报告 " + data.asset.reportPath));
    }
    rollup.append(section);
  }
  return rollup;
}

function taskStages(task) {
  const list = el("ol", "studio-task-stages");
  list.setAttribute("aria-label", "当前任务的工作进度");
  const names = { research: "选题", writing: "文案", editing: "剪辑", analytics: "发布与数据" };
  for (const [key, label] of Object.entries(names)) {
    const stage = el("li", "", label);
    stage.dataset.state = task.stages?.[key]?.state || "pending";
    if (task.stage === key) stage.setAttribute("aria-current", "step");
    if (stage.dataset.state === "completed") stage.setAttribute("aria-label", label + "已交接");
    list.append(stage);
  }
  return list;
}

function taskDetail(task) {
  const context = { task, stage: role, fields: new Map() };
  draftContext = context;
  const data = task.stages?.[role]?.data || {};
  const meta = el("div", "studio-task-meta");
  const status = el("span", "studio-task-status", states[task.status] || task.status);
  status.dataset.status = task.status;
  meta.append(el("span", "studio-ID", task.id + " · " + task.version), status);
  const header = panel(task.title, meta, taskStages(task));
  header.classList.add("studio-task-board");
  context.status = el("div", "studio-draft-status");
  context.status.setAttribute("role", "status");
  context.status.setAttribute("aria-live", "polite");
  header.append(context.status);
  if (task.goal) header.append(textBlock(task.goal));
  if (task.status === "NEEDS_INPUT") header.append(textBlock(task.nextAction || task.blockingQuestion || task.waitingNote || (data.needsInput || []).join("\n") || "补充关键信息后可重跑。"));
  if (data.modelOutputMode === "plain_fallback") header.append(el("p", "studio-muted", "模型返回了纯文本草稿。请核对事实并补充标题、分镜等结构化字段。"));
  if (task.legacy) header.append(el("p", "studio-muted", "历史任务。打开并保存可接入当前工作流。"));
  const content = { research, writing, editing, analytics }[role](task, data);
  draftContext = undefined;
  updateDraftStatus(context);
  const media = role === "analytics" ? content.querySelector(".studio-assets") : null;
  if (media) header.append(media);
  const prior = previousOutputs(task, role);
  if (prior) header.append(prior);
  header.append(content);
  if (role !== "research" && !["PUBLISHED", "AWAITING_DATA", "RETRO_DONE", "ARCHIVED"].includes(task.status)) {
    const previous = { writing: "research", editing: "writing", analytics: task.format === "video" ? "editing" : "writing" }[role];
    header.append(button("新建修订并回到" + roles[previous].title, () => {
      if (!window.confirm("保留原有版本，开启新修订？")) return;
      return action("revise", { toStage: previous, note: "用户回到上游修订" });
    }));
  }
  const entry = draftEntry(context);
  if (entry && (entry.revision !== task.revision || entry.version !== task.version)) {
    for (const control of header.querySelectorAll("button, input, textarea, select")) {
      if (!control.closest(".studio-draft-status")) control.disabled = true;
    }
  }
  return header;
}
function render() {
  const oldBanner = { text: banner?.textContent, error: banner?.classList.contains("studio-error") };
  banner = el("div", "studio-banner");
  banner.setAttribute("role", "status");
  root.replaceChildren(banner);
  if (role !== "home") {
    const heading = el("header", "studio-heading");
    heading.dataset.workspace = role;
    heading.append(el("h1", "", roles[role].title), el("p", "studio-muted", roles[role].subtitle));
    root.append(heading);
  }
  showBanner(oldBanner.text || "", oldBanner.error);
  if (role === "home") root.append(...dashboard());
  else {
    const grid = el("div", "studio-grid");
    const column = el("div", "studio-column");
    const side = el("aside", "studio-column");
    if (selected?.stage === role) column.append(taskDetail(selected));
    if (role === "research") column.append(trendsPanel());
    const intake = !column.childNodes.length;
    if (intake) column.append(panel("新建任务", newTask({ inline: true })));
    const indexPanel = panel("任务列表", ...(intake ? [] : [newTask()]), taskList(role));
    indexPanel.classList.add("studio-task-index");
    side.append(indexPanel);
    if (role === "research" || role === "writing") side.append(feedbackPanel(role));
    grid.append(column, side);
    root.append(grid);
  }
  if (busy) lockInputs(true);
}
async function view(next) {
  const epoch = ++viewEpoch;
  role = next === "home" || roles[next] ? next : "home";
  const currentRole = role;
  const url = new URL(location.href);
  if (role === "home") url.searchParams.delete("workspace");
  else url.searchParams.set("workspace", role);
  if (selection[role]) url.searchParams.set("task", selection[role]);
  else url.searchParams.delete("task");
  history.replaceState(null, "", url);
  selected = undefined;
  render();
  try {
    await loadTasks();
    if (role !== currentRole || epoch !== viewEpoch) return;
    const id = selection[role];
    if (id) await openTask(id, { epoch });
    else render();
  } catch (error) { if (epoch === viewEpoch) showBanner(error.message, true); }
}
window.addEventListener("studio-role", (event) => view(event.detail));
window.addEventListener("studio-xhs-post", (event) => run(() => create(
  "research", event.detail.title || "小红书竞品分析", "核对竞品原文、开头、内容结构和用户痛点",
  "video", { text: event.detail.body, sources: [{ ...event.detail, url: event.detail.url }] }
)));
if (initialRole && roles[initialRole]) navigate(initialRole);
else view("home");
