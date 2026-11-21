import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const visionScript = path.join(root, "tools", "macos-vision-ocr.swift");

function commandPath(name) {
  const result = spawnSync("/usr/bin/env", ["which", name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function run(command, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: error.message, code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

export function ocrCapability(options = {}) {
  const platform = options.platform || process.platform;
  const find = options.commandPath || commandPath;
  if (platform === "darwin" && find("swift")) {
    return {
      available: true,
      adapter: "macos_vision",
      message: "使用 macOS Vision 在本机识别简体中文和英文，不上传图片。"
    };
  }
  const tesseract = find("tesseract");
  if (tesseract) {
    const langs = spawnSync(tesseract, ["--list-langs"], { encoding: "utf8" });
    const text = `${langs.stdout || ""}\n${langs.stderr || ""}`;
    if (/\bchi_sim\b/.test(text)) {
      return { available: true, adapter: "tesseract", command: tesseract, message: "使用本机 Tesseract 中文模型识别图片文字。" };
    }
    return { available: false, adapter: "none", message: "图片文字尚未提取：OCR（光学字符识别）运行环境缺少 chi_sim 中文模型。请安装 Tesseract 中文语言包。" };
  }
  return { available: false, adapter: "none", message: "图片文字尚未提取：OCR（光学字符识别）运行环境不可用。macOS 可安装 Xcode Command Line Tools，其他系统可安装 Tesseract 与 chi_sim 中文模型。" };
}

export async function ocrImage(imagePath, options = {}) {
  try {
    await access(imagePath);
  } catch {
    return { status: "failed", text: "", source: "OCR", message: "OCR 输入图片不存在。" };
  }
  const capability = ocrCapability(options);
  if (!capability.available) return { status: "unavailable", text: "", source: "OCR", message: capability.message };
  const result = capability.adapter === "macos_vision"
    ? await run(options.swiftPath || commandPath("swift"), [visionScript, imagePath], options.timeoutMs)
    : await run(capability.command, [imagePath, "stdout", "-l", "chi_sim+eng"], options.timeoutMs);
  if (!result.ok) {
    return {
      status: "failed", text: "", source: capability.adapter === "macos_vision" ? "macOS Vision OCR" : "Tesseract OCR",
      message: `图片文字尚未提取：OCR 运行失败。${String(result.stderr || "").trim().slice(0, 240)}`
    };
  }
  const text = String(result.stdout || "").replace(/\r/g, "").trim();
  return {
    status: text ? "success" : "empty",
    text,
    source: capability.adapter === "macos_vision" ? "macOS Vision OCR" : "Tesseract OCR",
    message: text ? capability.message : "OCR 已运行，但没有识别到清晰文字。"
  };
}

export function asrCapability(options = {}) {
  const find = options.commandPath || commandPath;
  const faster = find("faster-whisper");
  if (faster) return { available: true, adapter: "faster_whisper", command: faster, message: "使用本机 Faster-Whisper 转写用户有权处理的本地媒体。" };
  const whisper = find("whisper");
  if (whisper) return { available: true, adapter: "whisper", command: whisper, message: "使用本机 Whisper 转写用户有权处理的本地媒体。" };
  return {
    available: false,
    adapter: "none",
    message: "视频口播暂未提取：本机未安装 Whisper 或 Faster-Whisper；工作台也不会绕过平台限制下载视频。"
  };
}

export async function transcribeLocalMedia(mediaPath, outputDir, options = {}) {
  const capability = asrCapability(options);
  if (!capability.available) return { status: "unavailable", text: "", source: "ASR", message: capability.message };
  if (!mediaPath) return { status: "not_available", text: "", source: "ASR", message: "视频口播暂未提取：没有用户有权处理的本地媒体文件。" };
  const args = [mediaPath, "--language", "zh", "--output_format", "txt", "--output_dir", outputDir];
  const result = await run(capability.command, args, options.timeoutMs || 600_000);
  if (!result.ok) return { status: "failed", text: "", source: capability.adapter, message: `视频口播暂未提取：ASR 运行失败。${String(result.stderr || "").trim().slice(0, 240)}` };
  const outputPath = path.join(outputDir, `${path.basename(mediaPath, path.extname(mediaPath))}.txt`);
  const text = await readFile(outputPath, "utf8").catch(() => "");
  return {
    status: text.trim() ? "completed" : "empty",
    text: text.trim(), source: capability.adapter,
    message: text.trim() ? "本地 ASR 转写已完成。" : "ASR 已运行，但没有生成可读取的文字。"
  };
}
