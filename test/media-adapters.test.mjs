import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { asrCapability, ocrCapability, ocrImage, transcribeLocalMedia } from "../lib/media-adapters.js";

test("OCR reports an explicit installation path when no adapter exists", () => {
  const capability = ocrCapability({ platform: "linux", commandPath: () => "" });
  assert.equal(capability.available, false);
  assert.match(capability.message, /OCR|光学字符识别/);
  assert.match(capability.message, /安装/);
});

test("ASR degrades explicitly without Whisper and never invents speech", async () => {
  const capability = asrCapability({ commandPath: () => "" });
  assert.equal(capability.available, false);
  const result = await transcribeLocalMedia("", "/tmp", { commandPath: () => "" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.text, "");
  assert.match(result.message, /Whisper|视频口播/);
});

test("macOS Vision OCR extracts Chinese text from a local screenshot", { skip: process.platform !== "darwin" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xhs-ocr-test-"));
  const imagePath = path.join(dir, "copy.png");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 260 }, deviceScaleFactor: 2 });
    await page.setContent('<style>body{padding:42px;background:white;color:#111;font:700 42px Arial}</style><div>大学生 AI 实践</div><div>先做一个真实项目</div>');
    await page.screenshot({ path: imagePath });
    const result = await ocrImage(imagePath);
    assert.equal(result.status, "success");
    assert.match(result.text.replace(/\s/g, ""), /大学生AI实践/);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});
