import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { createWorkflowTools } from "../lib/workflow-tools.js";

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const taskId = "CONTENT-20261117-81";
const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const shortSample = [
  "-v", "error",
  "-f", "lavfi", "-i", "color=c=0x243852:s=180x320:r=24:d=3.2",
  "-f", "lavfi", "-i", "sine=frequency=480:duration=3.2",
  "-c:v", "libx264", "-c:a", "aac", "-shortest",
];
const digest = async (filePath) => createHash("sha256").update(await readFile(filePath)).digest("hex");

async function temporaryFolder(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "workbench-action-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test("keeps the source, renders reviewed caption times, and leaves visual review pending", { skip: !ffmpeg, timeout: 55_000 }, async (t) => {
  const dataDir = await temporaryFolder(t);
  const tools = createWorkflowTools({ projectRoot, dataDir });
  if (!tools.capabilities().subtitles) return t.skip("local Chrome unavailable");
  const original = path.join(dataDir, "original.mp4");
  await exec("ffmpeg", [...shortSample, original]);
  const hash = await digest(original);
  const early = await tools.inspectMedia({ sourcePath: original });
  assert.equal(early.width, 180);
  await assert.rejects(
    tools.prepareEdit({ taskId, sourcePath: original, ranges: [{ start: 1, end: 2 }, { start: 0, end: 1 }] }),
    /重叠/,
  );
  await assert.rejects(tools.prepareEdit({ taskId, sourcePath: original, aspectRatio: "constructor" }), { status: 400 });
  const result = await tools.renderMedia({
    taskId,
    sourcePath: original,
    segments: [{ start: 0.4, end: 1.75, text: "测试白色字幕" }, { start: 2, end: 2.7, text: "另一个字幕" }],
  });
  assert.equal(result.status, "awaiting_review");
  assert.equal(result.frameChecks.status, "pending_review");
  assert.equal(result.frames.length, 3);
  assert.equal(result.audioPreserved, true);
  assert.equal(result.durationMatched, true);
  assert.equal(result.media.hasAudio, true);
  assert.notEqual(result.filePath, original);
  assert.equal(await digest(original), hash);
  assert.match(await readFile(result.subtitlesPath, "utf8"), /00:00:01,750/);
  assert.ok((await stat(result.filePath)).size > 0);
  assert.ok((await stat(result.frames[1].filePath)).size > 0);
  const brightPixels = async (at) => {
    const { stdout } = await exec("ffmpeg", [
      "-v", "error", "-ss", at, "-i", result.filePath,
      "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-",
    ], { encoding: "buffer" });
    return stdout.filter((pixel) => pixel >= 185).length;
  };
  assert.equal(await brightPixels("0.16"), 0);
  assert.ok(await brightPixels("1.00") > 25);
  assert.equal(await brightPixels("2.95"), 0);
  const cover = await tools.renderCover({ taskId, sourcePath: result.filePath, title: "真实片段封面" });
  assert.equal(cover.adapter, "local_source_frame");
  assert.ok((await stat(cover.coverPath)).size > 0);
});

test("binds metric snapshots to their platform and receipt, preserving zero", async (t) => {
  const dataDir = await temporaryFolder(t);
  const tools = createWorkflowTools({ projectRoot, dataDir });
  if (!tools.capabilities().metrics.snapshots) return t.skip("project metrics adapter unavailable");
  const base = {
    taskId,
    platform: "douyin",
    postId: "fixture-post-1",
    snapshot: {
      platform: "douyin",
      platform_post_id: "fixture-post-1",
      collected_at: "2026-11-17T12:34:00+08:00",
      metrics: { views: 0, comments: null },
    },
  };
  await assert.rejects(tools.collectMetrics({ ...base, postId: "fixture-post-2" }), /同平台作品/);
  await assert.rejects(tools.collectMetrics({ ...base, snapshot: { ...base.snapshot, metrics: { views: null } } }), /真实/);
  const record = await tools.collectMetrics(base);
  assert.equal(record.platform_post_id, base.postId);
  assert.equal(record.metrics.views, 0);
  assert.equal(record.metrics.comments, null);
  assert.equal(record.collection_state, "COLLECTED");
  assert.equal(JSON.parse(await readFile(record.reportPath, "utf8")).content_id, taskId);
});

test("blocks unconfirmed publishing and reconciles external receipts without claiming login", { skip: !ffmpeg }, async (t) => {
  const dataDir = await temporaryFolder(t);
  const calledPublish = [];
  const original = path.join(dataDir, "upload.mp4");
  await exec("ffmpeg", [...shortSample, original]);
  const tools = createWorkflowTools({
    projectRoot, dataDir,
    run: async (command, args) => {
      if (command === "zsh") {
        calledPublish.push(args);
        if (!args.includes("--confirm")) return { code: 0, stdout: "仅预览", stderr: "" };
        if (args.includes("douyin")) return { code: 0, stdout: "抖音命令已返回成功", stderr: "" };
        if (args.includes("x")) return { code: 0, stdout: "推特（X）发布成功，帖子 ID：123456", stderr: "" };
        return { code: 1, stdout: "开始执行小红书发布", stderr: "没有可用回执" };
      }
      const result = await exec(command, args);
      return { ...result, code: 0 };
    },
  });
  const capabilities = tools.capabilities().platforms;
  if (!capabilities.douyin.video || !capabilities.x.video) return t.skip("installed platform tools unavailable");
  const post = { platform: "douyin", account: "fixture", sourcePath: original, title: "隔离测试" };
  await assert.rejects(tools.publishPlatform(post), /明确确认/);
  assert.equal(calledPublish.length, 0);
  assert.equal((await tools.publishPlatform({ ...post, confirmed: true })).status, "SUBMITTED");
  assert.equal((await tools.publishPlatform({ ...post, platform: "xiaohongshu", confirmed: true })).status, "UNKNOWN");
  const result = await tools.publishPlatform({ ...post, platform: "x", confirmed: true });
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.url, "https://x.com/i/status/123456");
  await assert.rejects(tools.publishPlatform({ ...post, platform: "x", confirmed: true, schedule: "2026-11-20 19:00" }), /不支持定时/);
  assert.equal(calledPublish.filter((args) => args.includes("--confirm")).length, 3);
});
