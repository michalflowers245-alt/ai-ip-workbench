import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("browser preserves drafts, handles concurrent updates, searches all tasks and stops at preview", { timeout: 120_000 }, async (t) => {
  const socket = http.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "studio-browser-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: appDir, env: { ...process.env, PORT: String(port), WORKBENCH_DATA_DIR: dataDir, WORKBENCH_ENABLE_MONITOR: "0" }, stdio: "ignore"
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  t.after(async () => { await browser?.close(); child.kill(); await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve)); await rm(dataDir, { recursive: true, force: true }); });
  async function api(url, body) {
    const response = await fetch(base + url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.ok, true, result.error);
    return result;
  }
  for (let i = 0; ; i++) {
    try { await api("/api/workbench/tasks"); break; } catch (error) { if (i > 100) throw error; await delay(50); }
  }
  const fixtures = [];
  for (let i = 1; i <= 40; i++) fixtures.push((await api("/api/workbench/tasks", {
    entryStage: "writing", title: `隔离验收文稿 ${i}`, format: "text", inputs: { text: `原始正文 ${i}` }
  })).task);
  const original = fixtures[0];
  const actionUrl = `/api/workbench/tasks/${original.id}/action`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  const studio = page.locator("#studio-workspace");
  const script = () => studio.getByLabel("正文", { exact: true });
  async function openOriginal() {
    await page.goto(`${base}/?workspace=writing&task=${original.id}`);
    await script().waitFor();
  }
  async function value(locator, expected) {
    await page.waitForFunction(({ label, expected }) => [...document.querySelectorAll("#studio-workspace label")].some((item) => item.querySelector("span")?.textContent === label && item.querySelector("textarea,input")?.value === expected), { label: await locator.evaluate((node) => node.closest("label").querySelector("span").textContent), expected });
  }

  await t.test("new-task intake survives switching and clears only after creation", async () => {
    await page.goto(base + "/?workspace=writing");
    await studio.getByLabel("任务标题", { exact: true }).fill("尚未创建的独立任务");
    await studio.getByLabel("已有稿件或研究材料", { exact: true }).fill("导入旧稿的原始输入");
    await page.locator("#employee-nav").getByRole("button", { name: "剪辑", exact: true }).click();
    await studio.getByRole("heading", { level: 1, name: "剪辑" }).waitFor();
    await page.locator("#employee-nav").getByRole("button", { name: "文案制作", exact: true }).click();
    await value(studio.getByLabel("任务标题", { exact: true }), "尚未创建的独立任务");
    await page.reload();
    await value(studio.getByLabel("已有稿件或研究材料", { exact: true }), "导入旧稿的原始输入");
    await studio.getByRole("button", { name: "新建任务", exact: true }).click();
    await studio.locator(".studio-task-board").getByRole("heading", { name: "尚未创建的独立任务", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("self-media-workbench:draft:v1:intake:writing")), null);
  });

  await t.test("unsubmitted writing survives navigation and reload, save clears its draft", async () => {
    await openOriginal();
    await script().fill("还没有保存的正文 · 真实浏览器输入");
    await studio.getByText("有未保存修改", { exact: false }).waitFor();
    await page.locator("#employee-nav").getByRole("button", { name: "剪辑", exact: true }).click();
    await studio.getByRole("heading", { level: 1, name: "剪辑" }).waitFor();
    await page.locator("#employee-nav").getByRole("button", { name: "文案制作", exact: true }).click();
    await value(script(), "还没有保存的正文 · 真实浏览器输入");
    await page.reload();
    await value(script(), "还没有保存的正文 · 真实浏览器输入");
    await studio.getByRole("button", { name: "保存稿件", exact: true }).click();
    await studio.locator(".studio-banner").filter({ hasText: /已保存.*修订/ }).waitFor();
    assert.equal((await api(`/api/workbench/tasks/${original.id}`)).task.stages.writing.data.script, "还没有保存的正文 · 真实浏览器输入");
    assert.equal(await page.evaluate((id) => localStorage.getItem(`self-media-workbench:draft:v1:${id}:writing`), original.id), null);
  });

  await t.test("revision conflict keeps local input and offers explicit recovery", async () => {
    await script().fill("这份是当前浏览器还没保存的修改");
    const { task } = await api(`/api/workbench/tasks/${original.id}`);
    await api(actionUrl, { action: "save", revision: task.revision, data: { script: "另一窗口刚保存的新版本", body: "另一窗口刚保存的新版本" } });
    await studio.getByRole("button", { name: "保存稿件", exact: true }).click();
    await studio.getByRole("button", { name: "重新读取，保留草稿" }).click();
    await studio.getByRole("button", { name: "恢复草稿到当前表单" }).waitFor();
    await value(script(), "另一窗口刚保存的新版本");
    await studio.getByRole("button", { name: "恢复草稿到当前表单" }).click();
    await value(script(), "这份是当前浏览器还没保存的修改");
    await studio.getByRole("button", { name: "保存稿件", exact: true }).click();
    await studio.locator(".studio-banner").filter({ hasText: /已保存.*修订/ }).waitFor();
  });

  await t.test("late save response cannot pull the user back to an old workspace", async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let fetched;
    const received = new Promise((resolve) => { fetched = resolve; });
    await page.route(`**${actionUrl}`, async (route) => {
      const response = await route.fetch();
      fetched();
      await held;
      await route.fulfill({ response });
    });
    try {
      await script().fill("延迟响应保存的内容");
      await studio.getByRole("button", { name: "保存稿件", exact: true }).click();
      await received;
      await page.locator("#employee-nav").getByRole("button", { name: "剪辑", exact: true }).click();
      await studio.getByRole("heading", { level: 1, name: "剪辑" }).waitFor();
      release();
      await page.waitForResponse((res) => res.url().endsWith("/api/workbench/tasks") && res.ok());
      assert.match(page.url(), /workspace=editing/);
      assert.equal(await studio.locator("h1").textContent(), "剪辑");
      assert.equal((await api(`/api/workbench/tasks/${original.id}`)).task.stages.writing.data.script, "延迟响应保存的内容");
    } finally { release(); await page.unroute(`**${actionUrl}`); }
  });

  await t.test("task search and paging reach records beyond the previous 36 item cap", async () => {
    await page.goto(base + "/?workspace=writing");
    const query = studio.getByLabel("查找任务", { exact: true });
    await query.fill(fixtures[1].id);
    assert.equal(await studio.locator(".studio-task").count(), 1);
    assert.match(await studio.locator(".studio-task").textContent(), /隔离验收文稿 2/);
    await studio.locator(".studio-task").click();
    await value(script(), "原始正文 2");
    await studio.locator(".studio-banner").waitFor({ state: "hidden" });
    await query.fill("");
    await studio.getByRole("button", { name: "下一页", exact: true }).click();
    assert.match(await studio.locator(".studio-pagination").textContent(), /2/);
    await query.fill("不可能匹配的任务");
    await studio.getByText("没有匹配的任务，试试其他关键词或状态。", { exact: true }).waitFor();
  });

  await t.test("text handoff and restored publishing targets produce a preview without publishing", async () => {
    await openOriginal();
    await studio.getByLabel("已核对来源事实、归因限定、示例真实性和文稿逻辑", { exact: true }).check();
    await studio.getByRole("button", { name: "交给发布与数据", exact: true }).click();
    await studio.getByLabel("发布前预测与依据", { exact: true }).fill("验收假设：内容只生成发布预览，真实表现未知。");
    await studio.getByLabel("账号别名", { exact: true }).fill("隔离验收账号");
    await studio.getByLabel("简介", { exact: true }).fill("此内容仅用于界面测试。");
    await page.reload();
    await value(studio.getByLabel("账号别名", { exact: true }), "隔离验收账号");
    await studio.getByRole("button", { name: "保存发布预览", exact: true }).click();
    await studio.getByRole("heading", { name: "当前发布批次", exact: true }).waitFor();
    const { task } = await api(`/api/workbench/tasks/${original.id}`);
    assert.equal(task.status, "AWAITING_PUBLISH_CONFIRMATION");
    assert.equal(task.approval, null);
    assert.equal(task.publications.length, 0);
    assert.equal(task.batch.targets[0].account, "隔离验收账号");
  });

  await t.test("mobile navigation and long content do not overflow horizontally", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await page.getByRole("heading", { name: "自媒体工作台", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole("button", { name: "导航", exact: true }).click();
    await page.locator("#employee-nav").getByRole("button", { name: "发布与数据分析", exact: true }).click();
    await studio.getByRole("heading", { name: "发布与数据分析", level: 1 }).waitFor();
    assert.equal(await page.getByRole("button", { name: "导航", exact: true }).getAttribute("aria-expanded"), "false");
    await page.goto(`${base}/?workspace=analytics&task=${original.id}`);
    await studio.getByRole("heading", { name: "当前发布批次", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
  assert.deepEqual(errors, []);
});
