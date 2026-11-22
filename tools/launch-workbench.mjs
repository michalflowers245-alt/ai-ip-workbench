import { spawn, execFile } from "node:child_process";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.WORKBENCH_DATA_DIR || path.join(appDir, "data"));
const requestedUrl = `http://127.0.0.1:${process.env.PORT || 5177}`;
const noOpen = process.argv.includes("--no-open");

function runtimeEnvironment() {
  const bypass = new Set([...(process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((item) => item.trim()).filter(Boolean), "localhost", "127.0.0.1", "::1"]);
  const noProxy = [...bypass].join(",");
  return { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || "1", NO_PROXY: noProxy, no_proxy: noProxy,
    PORT: process.env.PORT || "5177" };
}

async function ready(url) {
  try {
    const response = await fetch(url + "/api/workbench/capabilities", { signal: AbortSignal.timeout(1500) });
    const data = await response.json();
    return response.ok && Object.hasOwn(data, "trimAdapter");
  } catch { return false; }
}

async function show(url) {
  if (!noOpen) await new Promise((resolve, reject) => {
    execFile("/usr/bin/open", [url], (error) => error ? reject(error) : resolve());
  });
  console.log(`工作台已打开：${url}`);
  console.log("可以关闭此终端窗口。热点监控会在本机后台继续运行。电脑关机或重启后，再双击桌面入口即可。");
}

async function main() {
  if (await ready(requestedUrl)) return show(requestedUrl);
  await mkdir(dataDir, { recursive: true });
  const logPath = path.join(dataDir, "workbench.log");
  const offset = (await stat(logPath).catch(() => ({ size: 0 }))).size;
  const log = await open(logPath, "a", 0o600);
  const child = spawn(process.execPath, [path.join(appDir, "server.js")], {
    cwd: appDir, env: runtimeEnvironment(), detached: true,
    stdio: ["ignore", log.fd, log.fd]
  });
  let launchError;
  child.once("error", (error) => { launchError = error; });
  child.unref();
  await log.close();
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (launchError) throw launchError;
    const output = (await readFile(logPath)).subarray(offset).toString("utf8");
    const url = output.match(/^自媒体工作台运行于 (http:\/\/127\.0\.0\.1:\d+)/m)?.[1];
    if (url && await ready(url)) return show(url);
    if (child.exitCode !== null) {
      // A simultaneous desktop click may have started the same port first.
      if (await ready(requestedUrl)) return show(requestedUrl);
      throw new Error(`工作台未能启动，请查看日志：${logPath}`);
    }
  }
  child.kill("SIGTERM");
  throw new Error(`工作台启动超时，请查看日志：${logPath}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
