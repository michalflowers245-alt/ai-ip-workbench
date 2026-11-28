const state = {
  employee: "", view: "studio", employees: {},
  db: { knowledge: [], feedback: [], conversations: {} }, modelConnection: null,
  xhsConnection: null, xhsAutomation: null, xhsTasks: [], xhsDetail: null, activeTaskId: null, pollTimer: null, autoStatusTimer: null
};

const $ = (id) => document.getElementById(id);
const terminalStatuses = new Set(["stopped", "completed", "partial", "failed", "needs_login", "needs_verification", "platform_limited", "interrupted"]);
const taskStatus = {
  queued: "等待中", opening_browser: "打开浏览器", searching: "搜索中", extracting: "提取中",
  stopping: "正在停止", stopped: "已停止", completed: "已完成", partial: "部分完成",
  failed: "失败", needs_login: "需要登录", needs_verification: "需要验证", platform_limited: "平台限制", interrupted: "被重启中断"
};

async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function setText(id, value) {
  const item = $(id);
  if (item) item.textContent = value;
}

function formatDate(value) {
  if (!value) return "时间未提取";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

const navLabels = {
  research: "热点与竞品分析", writing: "文案制作", editing: "剪辑", analytics: "发布与数据分析"
};

function setRailOpen(open) {
  const toggle = $("rail-toggle");
  toggle.closest(".rail").classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", String(open));
}

function renderNav() {
  const nav = $("employee-nav");
  const focusedKey = nav.contains(document.activeElement) ? document.activeElement.dataset.key : "";
  nav.replaceChildren();
  const entries = [["home", "工作台首页"], ...Object.entries(state.employees).map(([key, employee]) => [key, navLabels[key] || employee.name])];
  entries.forEach(([key, label], index) => {
    const active = state.view === "studio" && (state.employee || "home") === key;
    const control = node("button", `nav-btn${active ? " active" : ""}`);
    control.type = "button";
    control.dataset.key = key;
    if (active) control.setAttribute("aria-current", "page");
    const marker = node("span", "nav-index", index ? String(index).padStart(2, "0") : "⌂");
    marker.setAttribute("aria-hidden", "true");
    control.append(marker, node("b", "nav-label", label));
    control.onclick = () => { state.employee = key === "home" ? "" : key; showView("studio"); };
    nav.appendChild(control);
  });
  if (focusedKey) {
    [...nav.children].find((item) => item.dataset.key === focusedKey)?.focus({ preventScroll: true });
  }
}

function renderChat() {
  const log = $("chat-log");
  const rows = state.db.conversations[state.employee] || [];
  log.replaceChildren();
  if (!rows.length) log.appendChild(node("div", "msg assistant", "我会先读取共享知识库和历史反馈。发来一个想法、素材或问题即可；资料不够时，我只会问会改变结果的关键问题。"));
  rows.forEach((message) => log.appendChild(node("div", `msg ${message.role === "user" ? "user" : "assistant"}`, message.content)));
  log.scrollTop = log.scrollHeight;
}

function connectionLabel(connection) {
  if (!connection) return "检测中";
  if (connection.connected) return "本机代理已接通";
  if (!connection.configured) return "本机代理待配置";
  return connection.lastTest?.status === "failed" ? "本机代理测试失败" : "等待最小测试";
}

function renderConnection(syncForm = false) {
  const connection = state.modelConnection;
  $("ai-state").dataset.ready = String(Boolean(state.deepSeek?.active || connection?.connected));
  setText("ai-state", state.deepSeek?.active
    ? "DeepSeek 官方 · " + (state.deepSeek.effectiveModel || "等待模型")
    : connectionLabel(connection));
  if (!connection) return;
  if (syncForm) {
    $("proxy-base-url").value = connection.proxyBaseUrl || "";
    $("proxy-model").value = connection.configuredModel || "";
  }
  setText("connection-status", connectionLabel(connection));
  setText("connection-model", connection.model || "未设置");
  setText("connection-test", !connection.lastTest ? "尚未测试" : connection.lastTest.status !== "success" ? "最近一次失败" : connection.lastTest.latencyMs ? `通过 · ${connection.lastTest.latencyMs} ms` : "通过");
  setText("connection-note", connection.note || "");
}

function setConnectionResult(message, isError = false) {
  $("connection-result").textContent = message;
  $("connection-result").classList.toggle("error", isError);
}

function showView(view) {
  const toggle = $("rail-toggle");
  const restoreMobileFocus = toggle.getAttribute("aria-expanded") === "true"
    && $("rail-content").contains(document.activeElement);
  setRailOpen(false);
  state.view = view;
  clearInterval(state.autoStatusTimer);
  state.autoStatusTimer = null;
  $("employee-workspace").hidden = view !== "employees";
  $("studio-workspace").hidden = view !== "studio";
  $("xhs-workspace").hidden = view !== "xhs";
  $("open-xhs-research").classList.toggle("active", view === "xhs");
  $("open-legacy").classList.toggle("active", view === "employees");
  renderNav();
  if (view === "xhs") {
    refreshXhs().catch(showXhsError);
    state.autoStatusTimer = setInterval(async () => {
      try {
        state.xhsAutomation = await api("/api/xhs/automation");
        const editingSettings = $("xhs-automation-form").contains(document.activeElement);
        renderXhsAutomation(!editingSettings);
      } catch (error) { showXhsError(error); }
    }, 15_000);
  }
  if (view === "studio") window.dispatchEvent(new CustomEvent("studio-role", { detail: state.employee || "home" }));
  if (restoreMobileFocus) toggle.focus({ preventScroll: true });
}

function render() {
  const employee = state.employees[state.employee] || Object.values(state.employees)[0];
  if (!employee) return;
  setText("employee-name", employee.name);
  setText("employee-skills", `Skill 白名单：${employee.skills.join(" / ")}`);
  setText("k-count", state.db.knowledge.length);
  setText("f-count", state.db.feedback.length);
  renderNav(); renderChat(); renderConnection();
}

function renderXhsConnection() {
  const connection = state.xhsConnection;
  if (!connection) return;
  const labels = {
    not_logged_in: ["未登录", "warn"], not_checked: ["待检查", "warn"], logged_in: ["已连接", "good"],
    needs_login: ["需要登录", "warn"], needs_verification: ["需要人工验证", "warn"], platform_limited: ["平台限制", "bad"], connection_failed: ["连接失败", "bad"]
  };
  const [label, tone] = labels[connection.status] || [connection.status || "未知", "warn"];
  $("xhs-connection-badge").textContent = label;
  $("xhs-connection-badge").className = `connection-badge ${tone}`;
  setText("xhs-connection-message", connection.message || "尚未检查连接。");
  setText("xhs-ocr-capability", `OCR：${connection.ocr?.available ? "可用" : "不可用"} · ${connection.ocr?.message || "未检测"}`);
  setText("xhs-asr-capability", `ASR：${connection.asr?.available ? "可用" : "不可用"} · ${connection.asr?.message || "未检测"}`);
}

function renderXhsAutomation(syncForm = false) {
  const automation = state.xhsAutomation;
  if (!automation) return;
  const labels = {
    disabled: ["未开启", "warn"], scheduled: ["监控中", "good"], running: ["采集中", "good"],
    waiting_for_login: ["等待登录", "warn"], paused_for_verification: ["等待人工验证", "bad"],
    paused_for_platform_limit: ["平台限制，已暂停", "bad"], paused_for_connection: ["连接异常，已暂停", "bad"],
    paused_for_error: ["异常，已暂停", "bad"]
  };
  const [label, tone] = labels[automation.state] || [automation.state || "未开启", "warn"];
  $("xhs-auto-badge").textContent = label;
  $("xhs-auto-badge").className = `connection-badge ${tone}`;
  setText("xhs-auto-message", [automation.last_message, automation.last_run_at ? `最近运行：${formatDate(automation.last_run_at)}` : "尚未运行", automation.next_run_at ? `下次运行：${formatDate(automation.next_run_at)}` : ""].filter(Boolean).join(" · "));
  if (syncForm) {
    $("xhs-auto-keywords").value = (automation.keywords || []).join("\n");
    $("xhs-auto-interval").value = String(automation.interval_hours || 12);
    $("xhs-auto-target").value = automation.target_count || 5;
  }
  $("xhs-auto-pause").disabled = !automation.enabled;
}

function renderTaskList() {
  const list = $("xhs-task-list");
  list.replaceChildren();
  if (!state.xhsTasks.length) return list.appendChild(node("p", "muted-copy", "暂无任务"));
  state.xhsTasks.forEach((task) => {
    const button = node("button", `task-item${task.id === state.activeTaskId ? " active" : ""}`);
    button.type = "button";
    button.append(node("b", "", task.keyword), node("span", "", `${task.source === "automation" ? "自动监控" : "手动搜索"} · ${taskStatus[task.status] || task.status} · ${task.processed_count}/${task.total_links || task.target_count}`), node("small", "", formatDate(task.created_at)));
    button.onclick = () => selectXhsTask(task.id);
    list.appendChild(button);
  });
}

function addTextSection(card, title, value, emptyMessage = "未提取到") {
  const section = node("section", "copy-block");
  section.append(node("h4", "", title), node("p", value ? "" : "empty-copy", value || emptyMessage));
  card.appendChild(section);
}

function renderPost(post) {
  const card = node("article", "post-card");
  const head = node("div", "post-head");
  const titleWrap = node("div");
  const statusText = post.extraction_status === "success" ? "完整" : post.extraction_status === "partial" ? "部分提取" : post.extraction_status === "needs_login" ? "需要登录" : post.extraction_status === "needs_verification" ? "需要验证" : post.extraction_status === "platform_limited" ? "平台限制" : post.extraction_status === "unavailable" ? "帖子不可用" : "提取失败";
  titleWrap.append(node("span", `post-state ${post.extraction_status}`, statusText), node("h3", "", post.title || "未提取到标题"), node("p", "post-meta", `${post.author || "作者未提取"} · ${formatDate(post.published_at)}`));
  const source = node("a", "source-link", "查看原帖 ↗");
  source.href = post.post_url; source.target = "_blank"; source.rel = "noopener noreferrer";
  head.append(titleWrap, source); card.appendChild(head);

  if (post.cover_path) {
    const image = node("img", "post-cover");
    image.src = post.cover_path; image.alt = post.title ? `${post.title} 的采集截图` : "帖子采集截图"; image.loading = "lazy";
    card.appendChild(image);
  }
  const metrics = node("div", "post-metrics");
  const metric = (label, value) => `${label} ${value === null || value === undefined ? "未提取" : Number(value).toLocaleString("zh-CN")}`;
  [metric("点赞", post.likes), metric("收藏", post.favorites), metric("评论", post.comments), `完整度 ${post.completeness}%`].forEach((value) => metrics.appendChild(node("span", "", value)));
  card.appendChild(metrics);

  addTextSection(card, "网页正文", post.body, "网页正文未提取到，已继续检查图片和字幕。");
  if (post.image_text || post.ocr_status !== "not_needed") addTextSection(card, "图片文字", post.image_text, post.ocr_message || "OCR 未提取到文字。");
  if (post.video_subtitle || post.video_speech || post.asr_status !== "not_needed") addTextSection(card, "视频字幕 / 口播", post.video_subtitle || post.video_speech, post.asr_message || "视频文字未提取到。");
  if (post.merged_copy) addTextSection(card, "合并与清洗结果", post.merged_copy);

  const tags = node("div", "tag-row");
  (post.tags || []).forEach((tag) => tags.appendChild(node("span", "tag", tag.startsWith("#") ? tag : `#${tag}`)));
  if (tags.childNodes.length) card.appendChild(tags);

  const details = node("details", "method-details");
  details.appendChild(node("summary", "", "查看提取方法与诊断"));
  const body = node("div", "method-body");
  const sources = Object.entries(post.fieldSources || {}).map(([key, value]) => `${key}：${value}`).join("；") || "没有可用字段来源";
  body.append(node("p", "", `字段来源：${sources}`), node("p", "", post.ocr_message || "OCR 未运行。"), node("p", "", post.asr_message || "ASR 未运行。"), node("p", "", post.cleaning_message || "AI 清洗未运行。"));
  if (post.error_message) body.appendChild(node("p", "error-copy", `失败阶段：${post.failure_stage || "未知"}；${post.error_message}`));
  details.appendChild(body); card.appendChild(details);

  const actions = node("div", "button-row card-actions");
  const save = node("button", "", "存入知识库");
  save.type = "button"; save.disabled = !post.merged_copy && !post.body && !post.image_text && !post.video_subtitle;
  save.onclick = async () => {
    save.disabled = true;
    try {
      const data = await api(`/api/xhs/posts/${post.id}/knowledge`, {});
      state.db = data.db; render(); save.textContent = "已存入知识库";
    } catch (error) { save.textContent = error.message; save.disabled = false; }
  };
  const retry = node("button", "secondary-btn", "重新提取"); retry.type = "button";
  retry.onclick = async () => {
    retry.disabled = true; retry.textContent = "正在重新提取…";
    try { await api(`/api/xhs/posts/${post.id}/retry`, {}); await selectXhsTask(state.activeTaskId); }
    catch (error) { retry.textContent = error.message; retry.disabled = false; }
  };
  const handoff = node("button", "secondary-btn", "用这条做竞品分析");
  handoff.type = "button";
  handoff.onclick = () => window.dispatchEvent(new CustomEvent("studio-xhs-post", { detail: {
    title: post.title, url: post.post_url, sourceId: "小红书", author: post.author,
    publishedAt: post.published_at, likes: post.likes, comments: post.comments, favorites: post.favorites,
    body: (post.merged_copy || post.body || post.image_text || post.video_subtitle || "").slice(0, 6000)
  } }));
  actions.append(save, handoff, retry); card.appendChild(actions);
  return card;
}

function renderXhsDetail() {
  const detail = state.xhsDetail;
  const progressCard = $("xhs-progress-card");
  const results = $("xhs-results"); results.replaceChildren();
  if (!detail) {
    progressCard.hidden = true; setText("xhs-result-count", "0 条");
    return results.appendChild(node("div", "empty-state", "登录后输入主题开始搜索。已完成的任务会长期保存在本机。"));
  }
  const task = detail.task; progressCard.hidden = false;
  setText("xhs-progress-title", `${task.keyword} · ${taskStatus[task.status] || task.status}`);
  setText("xhs-progress-message", task.progress_message || "");
  setText("xhs-total-links", task.total_links); setText("xhs-processed", task.processed_count);
  setText("xhs-success", task.success_count); setText("xhs-failed", task.failed_count);
  setText("xhs-current-url", task.current_url ? `当前页面：${task.current_url}` : "");
  $("xhs-progress").max = Math.max(task.total_links || task.target_count || 1, 1);
  $("xhs-progress").value = Math.min(task.processed_count || 0, $("xhs-progress").max);
  $("xhs-stop-task").disabled = terminalStatuses.has(task.status);
  setText("xhs-result-count", `${detail.results.length} 条`);
  if (!detail.results.length) {
    const message = task.error_message || detail.errors?.[0]?.error_message || "任务刚开始，结果会在逐条提取后出现。";
    results.appendChild(node("div", `empty-state${task.error_message ? " error-state" : ""}`, message));
  } else detail.results.forEach((post) => results.appendChild(renderPost(post)));
  (detail.errors || []).forEach((error) => {
    const diagnostic = node("details", "diagnostic-card");
    diagnostic.appendChild(node("summary", "", `失败诊断 · ${error.failure_stage || "未知阶段"}`));
    const content = node("div", "method-body");
    content.append(
      node("p", "error-copy", error.error_message || "未知错误"),
      node("p", "", `页面标题：${error.page_title || "未取得"}`),
      node("p", "", `最终 URL：${error.final_url || error.post_url || "未取得"}`),
      node("p", "", `可见文字长度：${error.visible_text_length || 0}；定位器数量：${error.dom_locator_count || 0}`),
      node("p", "", `登录失效：${error.login_detected ? "是" : "否"}；需要验证：${error.verification_detected ? "是" : "否"}；平台限制：${error.platform_limited ? "是" : "否"}`)
    );
    if (error.screenshot_path) {
      const shot = node("img", "diagnostic-shot"); shot.src = error.screenshot_path; shot.alt = "失败现场截图"; content.appendChild(shot);
    }
    diagnostic.appendChild(content); results.appendChild(diagnostic);
  });
}

async function selectXhsTask(taskId, restartPolling = true) {
  if (!taskId) return;
  state.activeTaskId = taskId;
  state.xhsDetail = await api(`/api/xhs/tasks/${taskId}`);
  const current = state.xhsDetail.task;
  const index = state.xhsTasks.findIndex((item) => item.id === taskId);
  if (index >= 0) state.xhsTasks[index] = current; else state.xhsTasks.unshift(current);
  renderTaskList(); renderXhsDetail();
  if (restartPolling) schedulePoll(current.status);
}

function schedulePoll(status) {
  clearTimeout(state.pollTimer);
  if (terminalStatuses.has(status)) return;
  state.pollTimer = setTimeout(() => selectXhsTask(state.activeTaskId).catch(showXhsError), 1200);
}

function showXhsError(error) {
  const results = $("xhs-results");
  if (results) results.prepend(node("div", "empty-state error-state", error.message || "小红书研究请求失败"));
}

async function refreshXhs() {
  const [connection, tasksData, automation] = await Promise.all([api("/api/xhs/connection"), api("/api/xhs/tasks?limit=30"), api("/api/xhs/automation")]);
  state.xhsConnection = connection; state.xhsTasks = tasksData.tasks || []; state.xhsAutomation = automation;
  if (!state.activeTaskId && state.xhsTasks.length) state.activeTaskId = state.xhsTasks[0].id;
  renderXhsConnection(); renderXhsAutomation(true); renderTaskList();
  if (state.activeTaskId) await selectXhsTask(state.activeTaskId, false); else renderXhsDetail();
}

async function load() {
  const data = await api("/api/state");
  state.employees = data.employees; state.db = data.db; state.modelConnection = data.modelConnection; state.deepSeek = data.deepSeek;
  if (state.employee && !state.employees[state.employee]) state.employee = Object.keys(state.employees)[0];
  render(); renderConnection(true);
}

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("message").value.trim(); if (!message) return;
  $("message").value = ""; state.db.conversations[state.employee] ||= [];
  state.db.conversations[state.employee].push({ role: "user", content: message }); renderChat();
  const button = event.submitter || $("composer").querySelector("button[type=submit]"); button.disabled = true;
  try { const data = await api("/api/generate", { employee: state.employee, message }); state.db = data.db; render(); }
  catch (error) { state.db.conversations[state.employee].push({ role: "assistant", content: `出错了：${error.message}` }); renderChat(); }
  finally { button.disabled = false; }
});

$("save-knowledge").addEventListener("click", async () => {
  const title = $("k-title").value.trim(), content = $("k-content").value.trim(); if (!content) return;
  const data = await api("/api/knowledge", { type: $("k-type").value, title: title || $("k-type").value, content });
  state.db = data.db; $("k-title").value = ""; $("k-content").value = ""; render();
});

$("save-feedback").addEventListener("click", async () => {
  const title = $("fb-title").value.trim(); if (!title) return;
  const data = await api("/api/feedback", { title, platform: $("fb-platform").value.trim(), views: Number($("fb-views").value || 0), leads: Number($("fb-leads").value || 0), deals: Number($("fb-deals").value || 0) });
  state.db = data.db; ["fb-title", "fb-platform", "fb-views", "fb-leads", "fb-deals"].forEach((id) => ($(id).value = "")); render();
});

$("open-model-settings").addEventListener("click", async () => {
  if (!$("model-dialog").open) $("model-dialog").showModal(); setConnectionResult("");
  try { state.modelConnection = await api("/api/model-connection"); renderConnection(true); }
  catch (error) { setConnectionResult(error.message, true); }
});
$("close-model-settings").addEventListener("click", () => $("model-dialog").close());
$("model-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; setConnectionResult("");
  try {
    state.modelConnection = await api("/api/model-connection", { proxyBaseUrl: $("proxy-base-url").value.trim(), model: $("proxy-model").value.trim() });
    renderConnection(true); setConnectionResult("连接设置已保存。保存本身不会发起授权或模型请求。");
  } catch (error) { setConnectionResult(error.message, true); } finally { button.disabled = false; }
});

async function runConnectionAction(buttonId, endpoint, successMessage) {
  const button = $(buttonId); button.disabled = true; setConnectionResult("");
  try { state.modelConnection = await api(endpoint, {}); renderConnection(); setConnectionResult(successMessage(state.modelConnection)); }
  catch (error) { try { state.modelConnection = await api("/api/model-connection"); renderConnection(); } catch {} setConnectionResult(error.message, true); }
  finally { button.disabled = false; }
}
$("test-proxy").addEventListener("click", () => runConnectionAction("test-proxy", "/api/model-connection/proxy/test", (connection) => connection.lastTest?.status === "success" ? `本机代理测试通过（${connection.lastTest.latencyMs || "--"} ms）。` : "最小测试未通过。"));
$("disconnect-proxy").addEventListener("click", () => runConnectionAction("disconnect-proxy", "/api/model-connection/proxy/disconnect", () => "已断开工作台对该代理的调用；代理自身的登录或 OAuth 状态不会被读取或修改。"));

$("rail-toggle").addEventListener("click", () => setRailOpen($("rail-toggle").getAttribute("aria-expanded") !== "true"));
$("rail-toggle").closest(".rail").addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || $("rail-toggle").getAttribute("aria-expanded") !== "true") return;
  setRailOpen(false);
  $("rail-toggle").focus();
});
$("open-xhs-research").addEventListener("click", () => showView("xhs"));
$("back-to-employees").addEventListener("click", () => { state.employee = "research"; showView("studio"); });
$("open-legacy").addEventListener("click", () => { if (!state.employee) state.employee = "research"; showView("employees"); render(); });
window.addEventListener("studio-navigate", (event) => {
  state.employee = event.detail === "home" ? "" : event.detail;
  showView("studio");
});
async function xhsConnectionAction(buttonId, endpoint) {
  const button = $(buttonId); button.disabled = true;
  try { state.xhsConnection = await api(endpoint, {}); renderXhsConnection(); state.xhsAutomation = await api("/api/xhs/automation"); renderXhsAutomation(true); }
  catch (error) { showXhsError(error); } finally { button.disabled = false; }
}
$("xhs-open-login").addEventListener("click", () => xhsConnectionAction("xhs-open-login", "/api/xhs/connection/open"));
$("xhs-check-login").addEventListener("click", () => xhsConnectionAction("xhs-check-login", "/api/xhs/connection/check"));
$("xhs-clear-login").addEventListener("click", async () => {
  if (window.confirm("只清除这个工作台的小红书专用登录目录，确定继续吗？")) await xhsConnectionAction("xhs-clear-login", "/api/xhs/connection/clear");
});
$("xhs-automation-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    state.xhsAutomation = await api("/api/xhs/automation", {
      enabled: true, keywords: $("xhs-auto-keywords").value,
      intervalHours: Number($("xhs-auto-interval").value), targetCount: Number($("xhs-auto-target").value)
    });
    renderXhsAutomation(true);
  } catch (error) { showXhsError(error); } finally { button.disabled = false; }
});
$("xhs-auto-pause").addEventListener("click", async () => {
  const button = $("xhs-auto-pause"); button.disabled = true;
  try {
    state.xhsAutomation = await api("/api/xhs/automation", { enabled: false });
    renderXhsAutomation(true);
  } catch (error) { showXhsError(error); } finally { button.disabled = !state.xhsAutomation?.enabled; }
});
$("xhs-search-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const data = await api("/api/xhs/tasks", { keyword: $("xhs-keyword").value.trim(), targetCount: Number($("xhs-target").value) });
    state.activeTaskId = data.task.id; state.xhsTasks.unshift(data.task); await selectXhsTask(data.task.id);
  } catch (error) { showXhsError(error); } finally { button.disabled = false; }
});
$("xhs-stop-task").addEventListener("click", async () => {
  if (!state.activeTaskId) return;
  const data = await api(`/api/xhs/tasks/${state.activeTaskId}/stop`, {});
  state.xhsDetail.task = data.task; renderXhsDetail(); schedulePoll(data.task.status);
});

window.addEventListener("deepseek-settings-change", (event) => { state.deepSeek = event.detail; renderConnection(); });

load().catch((error) => { const pre = node("pre", "", error.message); document.body.replaceChildren(pre); });
