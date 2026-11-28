import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { asrCapability, ocrCapability, ocrImage } from "./media-adapters.js";
import { detectPageState, extractPageContent, normalizePostUrl, postKeyFromUrl } from "./xhs-extractor.js";

const HOME_URL = "https://www.xiaohongshu.com/";

function messageOf(error) {
  return String(error?.message || error || "未知错误").replace(/\s+/g, " ").slice(0, 500);
}

function safeFilePart(value) {
  return String(value || "post").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "post";
}

function mergeCopy(...blocks) {
  const seen = new Set();
  return blocks.map((value) => String(value || "").trim()).filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  }).join("\n\n");
}

function completeness(post) {
  const checks = [post.title, post.author, post.body || post.mergedCopy, post.publishedAt, post.tags?.length, post.likes ?? post.favorites ?? post.comments, post.coverPath];
  return Math.round(checks.filter((value) => value !== "" && value !== null && value !== undefined && value !== 0).length / checks.length * 100);
}

export class XhsStageError extends Error {
  constructor(stage, message, diagnostics = {}) {
    super(message);
    this.stage = stage;
    this.diagnostics = diagnostics;
  }
}

export class XhsBrowserController {
  constructor({ profileDir, artifactsDir, headless = false } = {}) {
    this.profileDir = profileDir || path.resolve("data/xhs-browser-profile");
    this.artifactsDir = artifactsDir || path.resolve("data/xhs-artifacts");
    this.headless = headless;
    this.context = null;
    this.launching = null;
    this.lastState = {
      status: existsSync(this.profileDir) ? "not_checked" : "not_logged_in",
      message: existsSync(this.profileDir) ? "已存在专用登录目录，请点击“检查登录状态”。" : "尚未建立小红书专用登录状态。"
    };
  }

  capability() {
    return { ocr: ocrCapability(), asr: asrCapability() };
  }

  connectionStatus() {
    return { ...this.lastState, browserOpen: Boolean(this.context), profileStored: existsSync(this.profileDir), ...this.capability() };
  }

  async ensureContext() {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      await mkdir(this.profileDir, { recursive: true });
      try {
        const context = await chromium.launchPersistentContext(this.profileDir, {
          channel: "chrome",
          headless: this.headless,
          viewport: this.headless ? { width: 1440, height: 1000 } : null,
          locale: "zh-CN",
          timeout: 30_000
        });
        context.on("close", () => { if (this.context === context) this.context = null; });
        this.context = context;
        return context;
      } catch (error) {
        this.lastState = { status: "connection_failed", message: `专用 Chrome 启动失败：${messageOf(error)}` };
        throw new XhsStageError("open_browser", this.lastState.message);
      } finally {
        this.launching = null;
      }
    })();
    return this.launching;
  }

  async page() {
    const context = await this.ensureContext();
    return context.pages()[0] || context.newPage();
  }

  async inspectPage(page) {
    const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    const state = detectPageState({ url: page.url(), title: await page.title().catch(() => ""), text });
    if (state.status === "ready") {
      const hasSearch = await page.locator('input[placeholder*="搜索"],input[type="search"],[role="searchbox"]').count().catch(() => 0);
      this.lastState = hasSearch
        ? { status: "logged_in", message: "小红书页面已连接，可以开始搜索。" }
        : { status: "connection_failed", message: "页面已打开，但没有找到搜索框；小红书页面结构可能已变化。" };
    } else {
      this.lastState = state;
    }
    return this.connectionStatus();
  }

  async openLogin() {
    const page = await this.page();
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.bringToFront();
    await page.waitForTimeout(800);
    return this.inspectPage(page);
  }

  async checkLogin() {
    return this.openLogin();
  }

  async clearProfile() {
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    await rm(this.profileDir, { recursive: true, force: true });
    this.lastState = { status: "not_logged_in", message: "工作台专用小红书登录状态已清除。" };
    return this.connectionStatus();
  }

  async dismissOverlays(page) {
    const selectors = ['button[aria-label="关闭"]', '[role="dialog"] button:has-text("关闭")', '[class*="modal"] [class*="close"]'];
    for (const selector of selectors) {
      const item = page.locator(selector).first();
      if (await item.isVisible().catch(() => false)) await item.click({ timeout: 1_000 }).catch(() => {});
    }
  }

  async collectLinks(keyword, targetCount, onProgress = () => {}, shouldStop = () => false) {
    const page = await this.page();
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(700);
    const gate = await this.inspectPage(page);
    if (["needs_login", "needs_verification", "platform_limited", "connection_failed"].includes(gate.status)) {
      throw new XhsStageError("login_check", gate.message, { loginDetected: gate.status === "needs_login", verificationDetected: gate.status === "needs_verification", platformLimited: gate.status === "platform_limited" });
    }
    await this.dismissOverlays(page);
    const search = page.locator('input[placeholder*="搜索"],input[type="search"],[role="searchbox"]').first();
    if (!await search.isVisible({ timeout: 5_000 }).catch(() => false)) {
      throw new XhsStageError("find_search_box", "没有找到小红书搜索框，页面结构可能已变化。", { pageTitle: await page.title(), finalUrl: page.url() });
    }
    await search.fill(keyword);
    await search.press("Enter");
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1_200);
    const links = new Map();
    let unchanged = 0;
    for (let step = 0; step < 12 && links.size < targetCount && !shouldStop(); step += 1) {
      const pageState = await this.inspectPage(page);
      if (["needs_login", "needs_verification", "platform_limited"].includes(pageState.status)) {
        throw new XhsStageError("collect_links", pageState.message, { loginDetected: pageState.status === "needs_login", verificationDetected: pageState.status === "needs_verification", platformLimited: pageState.status === "platform_limited", finalUrl: page.url(), pageTitle: await page.title() });
      }
      const before = links.size;
      const visible = await page.locator('a[href*="/explore/"],a[href*="/discovery/item/"],a[href*="/search_result/"]').evaluateAll((nodes) => nodes.map((node) => ({ href: node.href, text: (node.innerText || node.getAttribute("aria-label") || "").trim() })));
      for (const item of visible) {
        const normalized = normalizePostUrl(item.href);
        if (normalized && !links.has(normalized)) links.set(normalized, { url: normalized, previewText: item.text.slice(0, 500) });
        if (links.size >= targetCount) break;
      }
      unchanged = links.size === before ? unchanged + 1 : 0;
      onProgress({ count: links.size, step, currentUrl: page.url() });
      if (unchanged >= 3) break;
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(850);
    }
    if (shouldStop()) return [...links.values()];
    if (!links.size) {
      throw new XhsStageError("collect_links", "搜索页已打开，但没有收集到帖子链接。请检查关键词、登录状态或页面结构。", {
        pageTitle: await page.title(), finalUrl: page.url(), visibleTextLength: (await page.locator("body").innerText().catch(() => "")).length
      });
    }
    return [...links.values()].slice(0, targetCount);
  }

  async extractPost(taskId, postUrl, retryCount = 0) {
    const context = await this.ensureContext();
    const page = await context.newPage();
    const postKey = postKeyFromUrl(postUrl) || safeFilePart(`${Date.now()}`);
    const taskDir = path.join(this.artifactsDir, safeFilePart(taskId));
    await mkdir(taskDir, { recursive: true });
    let extraction;
    let coverPath = "";
    try {
      await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(1_000);
      await this.dismissOverlays(page);
      extraction = await extractPageContent(page);
      if (extraction.pageState.status !== "ready") {
        throw new XhsStageError("detail_gate", extraction.pageState.message, {
          pageTitle: extraction.pageTitle, finalUrl: extraction.finalUrl,
          visibleTextLength: extraction.visibleTextLength, domLocatorCount: extraction.domLocatorCount,
          loginDetected: extraction.pageState.status === "needs_login", verificationDetected: extraction.pageState.status === "needs_verification",
          platformLimited: extraction.pageState.status === "platform_limited", pageUnavailable: extraction.pageState.status === "unavailable"
        });
      }
      const coverName = `${safeFilePart(postKey)}-cover.png`;
      await page.screenshot({ path: path.join(taskDir, coverName), fullPage: false });
      coverPath = `/api/xhs/artifacts/${encodeURIComponent(safeFilePart(taskId))}/${encodeURIComponent(coverName)}`;

      let imageText = "";
      let ocrStatus = "not_needed";
      let ocrMessage = "帖子正文已从页面读取，不需要 OCR。";
      const isImageHeavy = extraction.domCounts.images > 0 && extraction.body.length < 180;
      if (isImageHeavy) {
        const imageNodes = page.locator('article img,[class*="note-detail"] img,[class*="swiper"] img');
        const count = Math.min(await imageNodes.count(), 4);
        const texts = [];
        let lastOcr = null;
        for (let index = 0; index < count; index += 1) {
          const image = imageNodes.nth(index);
          const box = await image.boundingBox().catch(() => null);
          if (!box || box.width < 220 || box.height < 140) continue;
          const imageName = `${safeFilePart(postKey)}-image-${index + 1}.png`;
          const imagePath = path.join(taskDir, imageName);
          await image.screenshot({ path: imagePath }).catch(() => {});
          if (!existsSync(imagePath)) continue;
          lastOcr = await ocrImage(imagePath);
          if (lastOcr.text) texts.push(lastOcr.text);
        }
        imageText = mergeCopy(...texts);
        ocrStatus = imageText ? "success" : lastOcr?.status || "unavailable";
        ocrMessage = imageText ? `已使用 ${lastOcr?.source || "OCR"} 提取图片文字。` : lastOcr?.message || ocrCapability().message;
        if (imageText) extraction.fieldSources.imageText = lastOcr?.source || "OCR（光学字符识别）";
      }

      let asrStatus = "not_needed";
      let asrMessage = "帖子不是视频，或页面已提供可读取的文字内容。";
      if (extraction.domCounts.videos > 0) {
        if (extraction.videoSubtitle) {
          asrStatus = "subtitle_available";
          asrMessage = "已读取页面可见字幕或可访问字幕轨，无需下载视频。";
        } else {
          const capability = asrCapability();
          asrStatus = capability.available ? "local_media_required" : "unavailable";
          asrMessage = capability.available
            ? "视频口播暂未提取：页面没有字幕，且没有用户有权处理的本地媒体文件；工作台不会下载受限视频。"
            : capability.message;
        }
      }
      const mergedCopy = mergeCopy(extraction.body, imageText, extraction.videoSubtitle);
      const post = {
        platform: "xiaohongshu", postUrl, postKey, title: extraction.title, author: extraction.author,
        publishedAt: extraction.publishedAt, body: extraction.body, imageText, videoSubtitle: extraction.videoSubtitle,
        videoSpeech: "", mergedCopy, tags: extraction.tags, likes: extraction.likes, favorites: extraction.favorites,
        comments: extraction.comments, coverPath, extractedAt: new Date().toISOString(), fieldSources: extraction.fieldSources,
        retryCount, ocrStatus, ocrMessage, asrStatus, asrMessage, cleaningStatus: "not_configured",
        cleaningMessage: "尚未进行 AI（人工智能）清洗。", raw: extraction.raw,
        diagnostics: {
          pageTitle: extraction.pageTitle, finalUrl: extraction.finalUrl, visibleTextLength: extraction.visibleTextLength,
          domLocatorCount: extraction.domLocatorCount, domCounts: extraction.domCounts, expandedCount: extraction.expandedCount,
          loginDetected: false, verificationDetected: false
        }
      };
      if (mergedCopy) post.fieldSources.mergedCopy = "网页正文、OCR 图片文字与页面字幕的去重合并";
      post.completeness = completeness(post);
      post.extractionStatus = post.title && mergedCopy ? (post.completeness >= 55 ? "success" : "partial") : "partial";
      if (!post.title && !mergedCopy) {
        post.failureStage = "content_extract";
        post.errorMessage = "页面已打开，但标题和正文均未提取到；页面结构可能已变化。";
      }
      return post;
    } catch (error) {
      const screenshotName = `${safeFilePart(postKey)}-error.png`;
      const screenshotFile = path.join(taskDir, screenshotName);
      await page.screenshot({ path: screenshotFile, fullPage: false }).catch(() => {});
      const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
      const state = detectPageState({ url: page.url(), title: await page.title().catch(() => ""), text: bodyText });
      const diagnostics = {
        pageTitle: await page.title().catch(() => ""), finalUrl: page.url(),
        screenshotPath: existsSync(screenshotFile) ? `/api/xhs/artifacts/${encodeURIComponent(safeFilePart(taskId))}/${encodeURIComponent(screenshotName)}` : "",
        visibleTextLength: bodyText.length, domLocatorCount: extraction?.domLocatorCount || 0,
        loginDetected: state.status === "needs_login", verificationDetected: state.status === "needs_verification", platformLimited: state.status === "platform_limited", pageUnavailable: state.status === "unavailable",
        ...(error?.diagnostics || {})
      };
      throw new XhsStageError(error?.stage || "detail_extract", messageOf(error), diagnostics);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
  }
}

export class XhsResearchService {
  constructor({ store, browser, cleaner = null, now = () => new Date(), schedulerIntervalMs = 30_000 } = {}) {
    this.store = store;
    this.browser = browser;
    this.cleaner = cleaner;
    this.now = now;
    this.schedulerIntervalMs = schedulerIntervalMs;
    this.active = new Set();
    this.queue = Promise.resolve();
    this.schedulerTimer = null;
    this.schedulerBusy = false;
    this.activeAutomationTaskId = null;
  }

  start(keyword, targetCount = 10) {
    const clean = String(keyword || "").trim().replace(/\s+/g, " ").slice(0, 100);
    if (clean.length < 2) throw new Error("搜索词至少需要 2 个字。");
    const target = Math.min(Math.max(Number(targetCount) || 10, 1), 20);
    const task = this.store.createTask(clean, target);
    this.enqueueTask(task.id);
    return task;
  }

  enqueueTask(taskId) {
    const result = this.queue.then(() => this.run(taskId));
    this.queue = result.catch(() => {});
    return result;
  }

  automationStatus() {
    return this.store.getAutomation();
  }

  configureAutomation(input = {}) {
    const current = this.store.getAutomation();
    const rawKeywords = Array.isArray(input.keywords) ? input.keywords : String(input.keywords || "").split(/[\n,，;；]+/);
    const normalizedKeywords = rawKeywords.map((value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 100)).filter(Boolean);
    if (normalizedKeywords.some((value) => value.length < 2)) throw new Error("每个监控词至少需要 2 个字。");
    const keywords = [...new Set(normalizedKeywords)];
    if (keywords.length > 5) throw new Error("自动监控最多支持 5 个关键词，请先合并或删除多余关键词。");
    const intervalHours = [6, 12, 24].includes(Number(input.intervalHours)) ? Number(input.intervalHours) : Number(current.interval_hours) || 12;
    const targetCount = Math.min(Math.max(Number(input.targetCount) || Number(current.target_count) || 5, 1), 20);
    const enabled = input.enabled === undefined ? current.enabled : input.enabled === true || input.enabled === 1;
    if (enabled && keywords.length === 0) throw new Error("自动监控至少需要一个 2 个字以上的关键词。");
    const loggedIn = this.browser.connectionStatus().status === "logged_in";
    const at = this.now();
    const next = !enabled ? {
      enabled: false, state: "disabled", next_run_at: null, last_message: "自动监控已暂停。"
    } : loggedIn ? {
      enabled: true, state: "scheduled", next_run_at: at.toISOString(), last_message: "已保存监控词；首次采集将尽快开始。"
    } : {
      enabled: true, state: "waiting_for_login", next_run_at: null,
      last_message: "监控配置已保存。请在专用浏览器登录并检查状态，工作台才会开始采集。"
    };
    const saved = this.store.updateAutomation({
      ...next,
      keywords_json: JSON.stringify(enabled ? keywords : (input.keywords === undefined ? current.keywords : keywords)),
      interval_hours: intervalHours,
      target_count: targetCount,
      last_status: enabled ? (loggedIn ? "scheduled" : "waiting_for_login") : current.last_status
    });
    if (!enabled && this.activeAutomationTaskId) this.stop(this.activeAutomationTaskId);
    if (enabled) this.startScheduler();
    return saved;
  }

  gateState(status) {
    if (status === "needs_login" || status === "not_logged_in") return { state: "waiting_for_login", message: "等待你在专用浏览器登录并通过状态检查。" };
    if (status === "needs_verification") return { state: "paused_for_verification", message: "检测到平台验证，自动采集已暂停；请在浏览器中亲自完成验证后重新检查登录状态。" };
    if (status === "platform_limited") return { state: "paused_for_platform_limit", message: "检测到平台访问限制，自动采集已暂停，不会自动重试。" };
    if (status === "connection_failed") return { state: "paused_for_connection", message: "小红书页面连接失败，自动采集已暂停。" };
    return { state: "waiting_for_login", message: "登录状态未确认，自动采集暂未启动。" };
  }

  async refreshAutomationAfterLogin(connection) {
    const config = this.store.getAutomation();
    if (!config.enabled) return config;
    if (connection?.status === "logged_in") {
      const saved = this.store.updateAutomation({
        state: "scheduled", next_run_at: this.now().toISOString(), last_status: "scheduled",
        last_message: "登录状态已核验，首次自动采集已排入队列。"
      });
      this.startScheduler();
      return saved;
    }
    const mapped = this.gateState(connection?.status);
    if (this.activeAutomationTaskId) this.stop(this.activeAutomationTaskId);
    return this.store.updateAutomation({ state: mapped.state, next_run_at: null, last_status: connection?.status || "connection_failed", last_message: mapped.message || connection?.message || "登录状态尚未确认。" });
  }

  startScheduler() {
    const config = this.store.getAutomation();
    if (config.enabled && config.state === "running") {
      this.store.updateAutomation({ state: "scheduled", next_run_at: this.now().toISOString(), last_status: "interrupted", last_message: "工作台上次关闭时自动采集中断；已安排一次恢复检查。" });
    } else if (config.enabled && config.state === "scheduled" && !config.next_run_at) {
      this.store.updateAutomation({ next_run_at: this.now().toISOString() });
    }
    if (!this.schedulerTimer) {
      this.schedulerTimer = setInterval(() => { void this.tickAutomation(); }, this.schedulerIntervalMs);
      this.schedulerTimer.unref?.();
    }
    void this.tickAutomation();
    return this.store.getAutomation();
  }

  stopScheduler() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  async tickAutomation() {
    if (this.schedulerBusy) return this.store.getAutomation();
    let config = this.store.getAutomation();
    if (!config.enabled || !config.next_run_at || Date.parse(config.next_run_at) > this.now().getTime()) return config;
    this.schedulerBusy = true;
    try {
      await this.queue;
      config = this.store.getAutomation();
      if (!config.enabled) return config;
      this.store.updateAutomation({ state: "running", next_run_at: null, last_run_at: this.now().toISOString(), last_status: "running", last_message: "正在按关键词顺序采集公开可见帖子。" });
      let connection;
      try {
        connection = await this.browser.checkLogin();
      } catch (error) {
        const mapped = this.gateState(error?.diagnostics?.verificationDetected ? "needs_verification" : error?.diagnostics?.loginDetected ? "needs_login" : error?.diagnostics?.platformLimited ? "platform_limited" : "connection_failed");
        return this.store.updateAutomation({ state: mapped.state, last_status: "paused", last_message: error?.message || mapped.message, next_run_at: null });
      }
      if (connection?.status !== "logged_in") {
        const mapped = this.gateState(connection?.status);
        return this.store.updateAutomation({ state: mapped.state, last_status: connection?.status || "paused", last_message: mapped.message, next_run_at: null });
      }

      let completed = 0;
      let success = 0;
      let failed = 0;
      for (const keyword of config.keywords) {
        if (!this.store.getAutomation().enabled) break;
        const task = this.store.createTask(keyword, config.target_count, "automation");
        this.activeAutomationTaskId = task.id;
        const result = await this.enqueueTask(task.id);
        this.activeAutomationTaskId = null;
        completed += 1;
        success += Number(result.success_count || 0);
        failed += Number(result.failed_count || 0) + (result.status === "failed" ? 1 : 0);
        if (["needs_login", "needs_verification", "platform_limited"].includes(result.status)) {
          const mapped = this.gateState(result.status);
          return this.store.updateAutomation({ state: mapped.state, last_status: result.status, last_message: `${keyword}：${mapped.message}`, next_run_at: null });
        }
      }
      config = this.store.getAutomation();
      if (!config.enabled) return this.store.updateAutomation({ state: "disabled", next_run_at: null, last_status: "stopped", last_message: `已暂停自动监控；本轮已完成 ${completed} 个关键词任务。` });
      const nextRunAt = new Date(this.now().getTime() + config.interval_hours * 60 * 60 * 1000).toISOString();
      return this.store.updateAutomation({
        state: "scheduled", next_run_at: nextRunAt,
        last_status: failed ? "partial" : "completed",
        last_message: `本轮完成 ${completed}/${config.keywords.length} 个关键词，成功帖子 ${success} 条，失败或不完整 ${failed} 条。`
      });
    } catch (error) {
      const latest = this.store.getAutomation();
      if (!latest.enabled) return this.store.updateAutomation({ state: "disabled", next_run_at: null, last_status: "stopped", last_message: "自动监控已暂停。" });
      return this.store.updateAutomation({ state: "paused_for_error", next_run_at: null, last_status: "failed", last_message: `自动采集异常，已暂停等待检查：${messageOf(error)}` });
    } finally {
      this.activeAutomationTaskId = null;
      this.schedulerBusy = false;
    }
  }

  async close() {
    this.stopScheduler();
    if (this.activeAutomationTaskId) this.stop(this.activeAutomationTaskId);
    while (this.schedulerBusy) await new Promise((resolve) => setTimeout(resolve, 20));
    await this.queue;
  }

  stop(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) return null;
  if (["completed", "partial", "failed", "stopped", "needs_login", "needs_verification", "platform_limited"].includes(task.status)) return task;
    return this.store.updateTask(taskId, { stop_requested: 1, status: "stopping", stage: "stopping", progress_message: "正在当前安全节点停止任务。" });
  }

  async run(taskId) {
    if (this.active.has(taskId)) return this.store.getTask(taskId);
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("搜索任务不存在。");
    this.active.add(taskId);
    let links = [];
    try {
      this.store.updateTask(taskId, { status: "opening_browser", stage: "open_browser", started_at: new Date().toISOString(), progress_message: "正在打开已登录的小红书专用浏览器。" });
      links = await this.browser.collectLinks(task.keyword, task.target_count, ({ count, currentUrl }) => {
        this.store.updateTask(taskId, { status: "searching", stage: "collect_links", total_links: count, current_url: currentUrl || "", progress_message: `正在滚动搜索页，已收集 ${count} 条不重复帖子链接。` });
      }, () => this.store.isStopRequested(taskId));
      links = [...new Map(links.map((item) => [normalizePostUrl(item.url), item])).entries()]
        .filter(([url]) => url)
        .map(([url, item]) => ({ ...item, url }))
        .slice(0, task.target_count);
      if (this.store.isStopRequested(taskId)) return this.store.updateTask(taskId, { status: "stopped", stage: "stopped", completed_at: new Date().toISOString(), progress_message: "任务已停止，已完成结果仍然保留。" });
      this.store.updateTask(taskId, { status: "extracting", stage: "detail_extract", total_links: links.length, progress_message: `已找到 ${links.length} 条帖子，开始逐条提取详情。` });
      let success = 0;
      let failed = 0;
      for (let index = 0; index < links.length; index += 1) {
        if (this.store.isStopRequested(taskId)) break;
        const item = links[index];
        this.store.updateTask(taskId, { current_url: item.url, processed_count: index, success_count: success, failed_count: failed, progress_message: `正在处理第 ${index + 1}/${links.length} 条帖子。` });
        try {
          const post = await this.extractWithRetry(taskId, item.url);
          if (this.cleaner && post.mergedCopy) {
            try {
              const cleaned = await this.cleaner(post);
              post.cleaningStatus = cleaned.status;
              post.cleaningMessage = cleaned.message;
              if (cleaned.text) {
                post.cleanedCopy = cleaned.text;
                post.mergedCopy = cleaned.text;
                post.fieldSources.mergedCopy = "本机模型 AI 清洗（基于已提取原文）";
              }
            } catch (error) {
              post.cleaningStatus = "failed";
              post.cleaningMessage = `AI 清洗失败，已保留原始提取：${messageOf(error)}`;
            }
          }
          this.store.savePost(taskId, task.keyword, post, index + 1);
          if (post.extractionStatus === "success") success += 1;
          else failed += 1;
        } catch (error) {
          failed += 1;
          const detail = { postUrl: item.url, failureStage: error.stage || "detail_extract", errorMessage: messageOf(error), ...(error.diagnostics || {}) };
          this.store.addError(taskId, detail);
          this.store.savePost(taskId, task.keyword, {
            postUrl: item.url, postKey: postKeyFromUrl(item.url), title: item.previewText || "提取失败的帖子",
            extractionStatus: detail.loginDetected ? "needs_login" : detail.verificationDetected ? "needs_verification" : detail.platformLimited ? "platform_limited" : detail.pageUnavailable ? "unavailable" : "failed",
            completeness: 0, failureStage: detail.failureStage, errorMessage: detail.errorMessage, coverPath: detail.screenshotPath || "",
            diagnostics: detail, retryCount: 0, ocrStatus: "not_run", ocrMessage: "正文提取失败，OCR 未运行。",
            asrStatus: "not_run", asrMessage: "正文提取失败，ASR 未运行。", cleaningStatus: "not_run", cleaningMessage: "正文提取失败，AI 清洗未运行。"
          }, index + 1);
          if (detail.loginDetected || detail.verificationDetected || detail.platformLimited) {
            const status = detail.verificationDetected ? "needs_verification" : detail.loginDetected ? "needs_login" : "platform_limited";
            return this.store.updateTask(taskId, { status, stage: detail.failureStage, processed_count: index + 1, success_count: success, failed_count: failed, error_message: detail.errorMessage, completed_at: new Date().toISOString(), progress_message: detail.errorMessage });
          }
        }
        this.store.updateTask(taskId, { processed_count: index + 1, success_count: success, failed_count: failed });
      }
      const stopped = this.store.isStopRequested(taskId);
      const status = stopped ? "stopped" : success && failed ? "partial" : success ? "completed" : "failed";
      return this.store.updateTask(taskId, {
        status, stage: stopped ? "stopped" : "complete", processed_count: success + failed, success_count: success, failed_count: failed,
        current_url: "", completed_at: new Date().toISOString(),
        progress_message: stopped ? "任务已停止，已完成结果仍然保留。" : `任务完成：成功 ${success} 条，失败 ${failed} 条。`
      });
    } catch (error) {
      const diagnostics = error.diagnostics || {};
      this.store.addError(taskId, { failureStage: error.stage || "unknown", errorMessage: messageOf(error), ...diagnostics });
      const status = diagnostics.verificationDetected ? "needs_verification" : diagnostics.loginDetected ? "needs_login" : diagnostics.platformLimited ? "platform_limited" : "failed";
      return this.store.updateTask(taskId, {
        status, stage: error.stage || "unknown", error_message: messageOf(error), completed_at: new Date().toISOString(), progress_message: messageOf(error)
      });
    } finally {
      this.active.delete(taskId);
    }
  }

  async extractWithRetry(taskId, url) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.browser.extractPost(taskId, url, attempt);
      } catch (error) {
        lastError = error;
        const diagnostics = error?.diagnostics || {};
        if (diagnostics.loginDetected || diagnostics.verificationDetected || diagnostics.platformLimited || diagnostics.pageUnavailable || attempt === 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
    }
    throw lastError;
  }

  detail(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    return { task, results: this.store.getTaskResults(taskId), errors: this.store.getErrors(taskId), capabilities: this.browser.capability() };
  }

  async retry(postId) {
    const post = this.store.getPost(postId);
    const task = this.store.latestTaskForPost(postId);
    if (!post || !task) throw new Error("没有找到可重新提取的帖子记录。");
    const retried = await this.browser.extractPost(task.id, post.post_url, Number(post.retry_count || 0) + 1);
    if (this.cleaner && retried.mergedCopy) {
      try {
        const cleaned = await this.cleaner(retried);
        retried.cleaningStatus = cleaned.status;
        retried.cleaningMessage = cleaned.message;
        if (cleaned.text) retried.mergedCopy = cleaned.text;
      } catch (error) {
        retried.cleaningStatus = "failed";
        retried.cleaningMessage = `AI 清洗失败，已保留原始提取：${messageOf(error)}`;
      }
    }
    return this.store.savePost(task.id, task.keyword, retried, 0);
  }
}
