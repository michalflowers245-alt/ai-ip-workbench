import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function jsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitFor(url, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("workbench did not start in time");
}

test("the workbench only uses a local OpenAI-compatible chat proxy after a successful test", async (t) => {
  const seen = [];
  let proxyHealthy = true;
  const proxy = http.createServer(async (req, res) => {
    const body = await jsonBody(req);
    seen.push({ path: req.url, authorization: req.headers.authorization || null, body });
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      if (!proxyHealthy) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "offline" }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: "本机代理成功" } }] }));
    }
    res.writeHead(404).end();
  });
  const proxyPort = await listen(proxy);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "self-media-workbench-test-"));
  const workbenchPort = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: appDir,
    env: {
      PORT: String(workbenchPort),
      WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_REQUEST_TIMEOUT_MS: "2000"
    },
    stdio: "ignore"
  });
  const baseUrl = `http://127.0.0.1:${workbenchPort}`;

  t.after(async () => {
    child.kill();
    await close(proxy);
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitFor(`${baseUrl}/api/state`);
  async function call(pathname, body) {
    const response = await fetch(`${baseUrl}${pathname}`, body === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }

  const connection = {
    // Unsupported fields must not create an alternate route.
    mode: "ignored-alternate-mode",
    protocol: "responses",
    proxyBaseUrl: `http://127.0.0.1:${proxyPort}/v1`,
    model: "local-model"
  };
  let result = await call("/api/model-connection", connection);
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "local_openai_proxy");
  assert.equal(result.body.protocol, "chat_completions");
  assert.equal(result.body.connected, false);
  assert.equal("authorization" in result.body, false);

  result = await call("/api/generate", { employee: "writing", message: "未测试时不能调用" });
  assert.equal(result.status, 409);
  assert.equal(seen.length, 0);

  result = await call("/api/model-connection/proxy/test", {});
  assert.equal(result.status, 200);
  assert.equal(result.body.connected, true);
  assert.equal(result.body.lastTest.status, "success");

  result = await call("/api/generate", { employee: "writing", message: "为测试写一句话" });
  assert.equal(result.status, 200);
  assert.equal(result.body.answer, "本机代理成功");
  assert.ok(seen.every((request) => request.path === "/v1/chat/completions"));
  assert.ok(seen.every((request) => request.authorization === null));
  assert.equal(seen[0].body.model, "local-model");
  assert.equal(seen[0].body.temperature, 0.4);
  assert.ok(Array.isArray(seen[0].body.messages));

  proxyHealthy = false;
  result = await call("/api/generate", { employee: "writing", message: "代理失效时不能保持已接通" });
  assert.equal(result.status, 502);
  result = await call("/api/model-connection");
  assert.equal(result.status, 200);
  assert.equal(result.body.lastTest.status, "failed");
  result = await call("/api/generate", { employee: "writing", message: "失效后不应重复发送" });
  assert.equal(result.status, 409);
  proxyHealthy = true;
  result = await call("/api/model-connection/proxy/test", {});
  assert.equal(result.status, 200);

  result = await call("/api/model-connection", { ...connection, model: "local-model-v2" });
  assert.equal(result.status, 200);
  assert.equal(result.body.lastTest, null);
  result = await call("/api/generate", { employee: "research", message: "改模型后需要重新测试" });
  assert.equal(result.status, 409);

  result = await call("/api/model-connection", { ...connection, proxyBaseUrl: "https://example.com/v1" });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /本机/);

  result = await call("/api/model-connection/proxy/disconnect", {});
  assert.equal(result.status, 200);
  assert.equal(result.body.lastTest, null);
  result = await call("/api/generate", { employee: "research", message: "断开后不能调用" });
  assert.equal(result.status, 409);

  result = await call("/api/knowledge", { type: "今日素材", title: "兼容性测试", content: "原有知识库写入仍然可用" });
  assert.equal(result.status, 200);
  assert.equal(result.body.db.knowledge.at(-1).title, "兼容性测试");
  result = await call("/api/feedback", { title: "旧功能数据", platform: "小红书", views: 88, leads: 2, deals: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.db.feedback.at(-1).views, 88);

  result = await call("/api/xhs/connection");
  assert.equal(result.status, 200);
  assert.equal(typeof result.body.ocr.available, "boolean");
  assert.equal("cookies" in result.body, false);
  result = await call("/api/xhs/tasks");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.tasks, []);
  result = await call("/api/xhs/tasks", { keyword: "a", targetCount: 99 });
  assert.equal(result.status, 400);

  const html = await fetch(`${baseUrl}/`).then((response) => response.text());
  assert.match(html, /小红书内容研究/);
  assert.match(html, /打开登录浏览器/);
});
