import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const platforms = new Set(["douyin", "xiaohongshu", "tencent", "x"]);
const videoExtensions = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const aspectSizes = new Map([
  ["9:16", [1080, 1920]], ["3:4", [1080, 1440]], ["16:9", [1920, 1080]], ["1:1", [1080, 1080]],
]);
const jobTimeout = 15 * 60_000;
const fixedPath = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":");
const faceScanScript = `
import Foundation
import Vision

let frames = CommandLine.arguments.dropFirst()
var faces = [[[Double]]]()
for frame in frames {
    let request = VNDetectFaceRectanglesRequest()
    try VNImageRequestHandler(url: URL(fileURLWithPath: frame)).perform([request])
    faces.append((request.results ?? []).map { result in
        let rect = result.boundingBox
        return [rect.minX, 1 - rect.maxY, rect.maxX, 1 - rect.minY]
    })
}
print(String(decoding: try JSONSerialization.data(withJSONObject: faces), as: UTF8.self))
`;

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

function commandExists(command) {
  return spawnSync("/usr/bin/which", [command], { env: { PATH: fixedPath }, stdio: "ignore" }).status === 0;
}

function haveAll(commands) {
  return commands.every(commandExists);
}

function runProcess(command, args, { cwd, timeoutMs = jobTimeout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: fixedPath },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    }, timeoutMs);
    const append = (current, chunk) => (current + chunk.toString()).slice(-1_000_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, started: false, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, started: true, timedOut });
    });
  });
}

function normalPlatform(platform) {
  if (!platforms.has(platform)) throw problem(400, "请选择已接入的平台");
  return platform;
}

function normalTaskId(value) {
  if (typeof value !== "string" || !/^CONTENT-\d{8}-\d{2}$/.test(value)) {
    throw problem(400, "需要有效的 CONTENT-ID");
  }
  return value;
}

function numberBetween(value, minimum, maximum, message) {
  const numeric = typeof value === "number" || typeof value === "string" && value.trim() !== "";
  const parsed = numeric ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw problem(400, message);
  return parsed;
}

function singleLine(value, label, required = false) {
  const parsed = typeof value === "string" ? value.trim() : "";
  if ((required && !parsed) || /[\u0000\r\n]/.test(parsed) || parsed.length > 500) {
    throw problem(400, `${label}需要填写一行有效内容`);
  }
  return parsed;
}

function publishText(value, label) {
  if (typeof value !== "string" || value.includes("\0") || value.length > 4_000) {
    throw problem(400, `${label}需要是不超过 4000 字的有效文字`);
  }
  return value;
}

async function localFile(value, extensions, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw problem(400, `请选择本地${label}的绝对路径`);
  }
  if (!extensions.has(path.extname(value).toLowerCase())) throw problem(400, `${label}格式暂未支持`);
  try {
    const absolutePath = await realpath(value);
    const metadata = await stat(absolutePath);
    if (!metadata.isFile() || !metadata.size || !extensions.has(path.extname(absolutePath).toLowerCase())) {
      throw new Error("invalid file");
    }
    return { absolutePath, metadata };
  } catch {
    throw problem(404, `未找到可用的本地${label}`);
  }
}

function parseFps(input) {
  const [num, den] = String(input || "").split("/").map(Number);
  return num > 0 && den > 0 ? Number((num / den).toFixed(3)) : null;
}

function validateRanges(ranges, duration) {
  if (ranges === undefined || ranges === null) return null;
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 160) {
    throw problem(400, "保留区间需要是按时间排列的非空数组，最多 160 段");
  }
  let previousEnd = 0;
  return ranges.map((range) => {
    const { start, end } = range || {};
    const first = numberBetween(start, previousEnd, duration, "保留区间超出片长或相互重叠");
    const last = numberBetween(end, first, duration + 0.02, "保留区间超出片长或结束时间错误");
    if (last - first < 0.08) throw problem(400, "保留区间至少需要 0.08 秒");
    previousEnd = last;
    return { start: first, end: Math.min(last, duration) };
  });
}

function timestamp(seconds) {
  return new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23).replace(".", ",");
}

function writeSrt(segments) {
  return segments.map(({ start, end, text }, index) => `${index + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${text}\n`).join("\n");
}

function parseTranscription(json) {
  const results = Array.isArray(json?.transcription) ? json.transcription : [];
  return results.flatMap((segment) => {
    const start = Number(segment.offsets?.from) / 1000;
    const end = Number(segment.offsets?.to) / 1000;
    const text = segment.text?.trim();
    if (!Number.isFinite(start) || end <= start || !text || /^\[[^\]]+\]$/.test(text)) return [];
    return [{ start, end, text }];
  });
}

function proposeCuts(segments, duration, silenceLog) {
  const silence = [];
  let previousStart;
  for (const match of silenceLog.matchAll(/silence_(start|end): (\d+(?:\.\d+)?)/g)) {
    const time = Number(match[2]);
    if (match[1] === "start") {
      previousStart = time;
    } else if (previousStart !== undefined) {
      const start = previousStart + 0.15;
      const end = Math.min(duration, time) - 0.15;
      if (end - start >= 0.4) silence.push({ start, end, reason: "长停顿，复听后决定是否缩短", risk: "low" });
      previousStart = undefined;
    }
  }
  const spoken = segments.flatMap((segment, index) => {
    const line = segment.text.replace(/[^\p{L}\p{N}]/gu, "");
    if (/^(嗯+|呃+|额+|啊+|唔+)$/.test(line)) return [{ ...segment, reason: "独立语气词，确认语气和呼吸衔接", risk: "low" }];
    const nextLine = segments[index + 1]?.text.replace(/[^\p{L}\p{N}]/gu, "");
    if (line.length >= 4 && line === nextLine) return [{ ...segment, reason: "相邻两次说法相同，核对第一次是否可删", risk: "high" }];
    return [];
  });
  return [...silence, ...spoken].sort((a, b) => a.start - b.start);
}

function normalizeCaptions(segments, duration) {
  if (!Array.isArray(segments) || segments.length > 500) throw problem(400, "字幕需要是时间轴数组，最多 500 条");
  let previousEnd = 0;
  return segments.map((segment) => {
    const { start, end, text } = segment || {};
    const first = numberBetween(start, previousEnd - 0.01, duration, "字幕时间不在成片内或相互重叠");
    const last = Math.min(duration, numberBetween(end, first, duration + 0.08, "字幕结束时间超出成片"));
    const content = typeof text === "string" ? text.trim().replace(/\r\n/g, "\n") : "";
    if (!content || content.length > 180 || last - first < 0.04) throw problem(400, "请核对空白、过长或时长过短的字幕");
    previousEnd = last;
    return { start: Math.max(first, 0), end: last, text: content };
  });
}

function safeJson(text, message) {
  try { return JSON.parse(text); } catch { throw problem(422, message); }
}

function postIdentity(value) {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input) return null;
  const fromLink = input.match(/\/status\/(\d+)/);
  return fromLink ? fromLink[1] : input.replace(/[?#].*$/, "").replace(/\/$/, "");
}

function assetPosition(choice) {
  if (!["auto", "top", "bottom"].includes(choice)) throw problem(400, "字幕位置请选择自动避脸、画面上方或下方");
  return choice;
}

function captionGeometry(height, position) {
  const stripHeight = Math.max(22, Math.round(height * 0.13));
  const margin = Math.round(height * 0.06);
  const y = position === "top" ? margin : height - stripHeight - margin;
  return { stripHeight, y, top: y / height, bottom: (y + stripHeight) / height };
}

export function createWorkflowTools({ projectRoot, dataDir, run = runProcess } = {}) {
  if (!projectRoot || !dataDir) throw new Error("projectRoot and dataDir are required");
  const root = path.resolve(projectRoot);
  const workRoot = path.join(path.resolve(dataDir), "artifacts");
  const skillRoot = path.join(homedir(), ".codex", "skills");
  const cutScript = path.join(skillRoot, "space-video-edit", "scripts", "cut_by_ranges.sh");
  const publishScript = path.join(root, "工具", "publish_cn_video.sh");
  const sauBinary = path.join(root, "工具", "social-auto-upload", ".venv", "bin", "sau");
  const metricsScript = path.join(root, "工具", "collect_platform_metrics.py");
  const whisperModel = process.env.WORKBENCH_WHISPER_MODEL || path.join(homedir(), ".cache", "whisper", "ggml-large-v3-turbo.bin");
  const chrome = process.env.WORKBENCH_CHROME_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  async function workspace(taskId, prefix) {
    const folder = path.join(workRoot, normalTaskId(taskId), `${prefix}-${randomUUID().slice(0, 8)}`);
    await mkdir(folder, { recursive: true });
    return folder;
  }

  async function execute(command, args, label, options) {
    const result = await run(command, args, options);
    if (result.code !== 0) {
      const detail = result.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 360);
      throw problem(result.timedOut ? 504 : 422, `${label}${result.timedOut ? "超时" : "失败"}${detail ? `，${detail}` : ""}`);
    }
    return result;
  }

  function capabilities() {
    const media = haveAll(["ffmpeg", "ffprobe"]);
    const asr = media && commandExists("whisper-cli") && existsSync(whisperModel);
    const subtitles = media && (existsSync(chrome) || existsSync(chromium.executablePath()));
    const publishScriptAvailable = existsSync(publishScript) && commandExists("zsh");
    const domesticVideo = publishScriptAvailable && existsSync(sauBinary);
    return {
      media,
      asr,
      subtitles,
      cover: subtitles,
      trimAdapter: existsSync(cutScript) && commandExists("jq") ? "space-video-edit" : "ffmpeg",
      platforms: {
        douyin: { video: domesticVideo, schedule: domesticVideo, cover: domesticVideo, manual: true },
        xiaohongshu: { video: domesticVideo, schedule: domesticVideo, cover: domesticVideo, manual: true },
        tencent: { video: domesticVideo, schedule: domesticVideo, cover: domesticVideo, manual: true },
        x: { video: publishScriptAvailable && haveAll(["xurl", "jq"]), schedule: false, cover: false, manual: true },
      },
      metrics: { snapshots: commandExists("python3") && existsSync(metricsScript), xRead: commandExists("xurl") },
    };
  }

  async function inspectMedia({ sourcePath }) {
    const { absolutePath, metadata } = await localFile(sourcePath, videoExtensions, "影片");
    const { stdout } = await execute("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,avi", "-show_format", "-show_streams", "-print_format", "json", absolutePath], "媒体探测", { timeoutMs: 20_000 });
    const probe = safeJson(stdout, "FFprobe 返回了无法识别的媒体信息");
    const video = probe.streams?.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    const duration = Number(probe.format?.duration ?? video?.duration);
    if (!video || !video.width || !video.height || !Number.isFinite(duration) || duration <= 0) {
      throw problem(422, "素材缺少可读取的视频流、尺寸或片长");
    }
    const rotation = Number(video.side_data_list?.find((item) => typeof item.rotation === "number")?.rotation ?? video.tags?.rotate ?? 0);
    const rotated = Math.abs(rotation) % 180 === 90;
    return {
      sourcePath: absolutePath,
      filePath: absolutePath,
      duration,
      width: rotated ? video.height : video.width,
      height: rotated ? video.width : video.height,
      frameRate: parseFps(video.avg_frame_rate),
      videoCodec: video.codec_name || null,
      audioCodec: audio?.codec_name || null,
      hasAudio: Boolean(audio),
      audioSampleRate: Number(audio?.sample_rate) || null,
      bytes: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      container: probe.format?.format_name || null,
    };
  }

  async function transcribeMedia({ taskId, sourcePath, language = "zh" }) {
    if (!["zh", "en", "auto"].includes(language)) throw problem(400, "转写语言请选择中文、英文或自动识别");
    if (!capabilities().asr) throw problem(503, "本机转写暂未接通，需要 whisper-cli 和已有的 Whisper 本地模型");
    const media = await inspectMedia({ sourcePath });
    if (!media.hasAudio) throw problem(422, "影片没有可转写的音轨");
    const folder = await workspace(taskId, "asr");
    const audioPath = path.join(folder, "audio.wav");
    const prefix = path.join(folder, "transcript");
    await execute("ffmpeg", ["-v", "error", "-nostdin", "-protocol_whitelist", "file", "-i", media.sourcePath, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath], "提取本地人声");
    const [, silence] = await Promise.all([
      execute("whisper-cli", ["-m", whisperModel, "-f", audioPath, "-l", language, "-ml", "24", "-sow", "-ojf", "-of", prefix, "-np"], "本地 Whisper 转写"),
      run("ffmpeg", ["-hide_banner", "-nostdin", "-i", audioPath, "-af", "silencedetect=noise=-35dB:d=0.8", "-f", "null", "-"]),
    ]);
    const transcriptPath = `${prefix}.json`;
    const segments = parseTranscription(safeJson(await readFile(transcriptPath, "utf8"), "本机转写结果不是有效 JSON"));
    const subtitlesPath = path.join(folder, "transcript.srt");
    if (segments.length) await writeFile(subtitlesPath, writeSrt(segments), "utf8");
    return {
      media,
      adapter: "whisper.cpp",
      transcriptPath,
      subtitlesPath: segments.length ? subtitlesPath : null,
      segments,
      text: segments.map((segment) => segment.text).join("\n"),
      suggestedCuts: proposeCuts(segments, media.duration, silence.stderr),
      status: segments.length ? "transcribed" : "no_speech",
    };
  }

  async function makeCut(media, ranges, speed, aspectRatio, folder) {
    const size = aspectSizes.get(aspectRatio);
    if (aspectRatio !== "original" && !size) throw problem(400, "请选择原比例、9:16、3:4、1:1 或 16:9");
    let input = media.sourcePath;
    let adapter = "ffmpeg";
    let filter = [];
    if (ranges && existsSync(cutScript) && commandExists("jq")) {
      const rangesPath = path.join(folder, "keep-ranges.json");
      input = path.join(folder, "ranges.mp4");
      await writeFile(rangesPath, JSON.stringify(ranges, null, 2), "utf8");
      await execute("bash", [cutScript, media.sourcePath, rangesPath, input], "按已确认区间剪口播");
      adapter = "space-video-edit";
    } else if (ranges) {
      const sections = ranges.map(({ start, end }, index) => {
        const video = `[0:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`;
        const audio = media.hasAudio ? `;[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]` : "";
        return video + audio;
      });
      const tracks = ranges.map((_, index) => `[v${index}]${media.hasAudio ? `[a${index}]` : ""}`).join("");
      sections.push(`${tracks}concat=n=${ranges.length}:v=1:a=${Number(media.hasAudio)}[v]${media.hasAudio ? "[a]" : ""}`);
      filter = [...sections];
    }

    const videoFilters = [`setpts=PTS/${speed}`];
    if (size) {
      const [width, height] = size;
      videoFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`);
    } else {
      videoFilters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    }
    videoFilters.push("setsar=1");
    const voice = [`atempo=${speed}`, "highpass=f=75", "afftdn=nr=7:nf=-45", "deesser=i=0.2:m=0.22:f=0.55", "acompressor=threshold=0.125:ratio=2:attack=10:release=90", "loudnorm=I=-16:TP=-1.5:LRA=11"];
    const args = ["-v", "error", "-nostdin", "-protocol_whitelist", "file", "-i", input];
    if (filter.length) {
      filter.push(`[v]${videoFilters.join(",")}[video]`);
      if (media.hasAudio) filter.push(`[a]${voice.join(",")}[audio]`);
      args.push("-filter_complex", filter.join(";"), "-map", "[video]");
      if (media.hasAudio) args.push("-map", "[audio]");
    } else {
      args.push("-map", "0:v:0", "-vf", videoFilters.join(","));
      if (media.hasAudio) args.push("-map", "0:a:0", "-af", voice.join(","));
    }
    const output = path.join(folder, "clean.mp4");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p");
    if (media.hasAudio) args.push("-c:a", "aac", "-ar", "48000", "-b:a", "192k");
    args.push("-movflags", "+faststart", output);
    await execute("ffmpeg", args, "口播剪辑与人声处理");
    return { output, adapter, audioFilters: media.hasAudio ? voice : [] };
  }

  async function prepareEdit({ taskId, sourcePath, ranges, speed = 1.1, aspectRatio = "original", language }) {
    const media = await inspectMedia({ sourcePath });
    const playbackSpeed = numberBetween(speed, 0.75, 1.5, "语速支持 0.75× 至 1.5×");
    const retained = validateRanges(ranges, media.duration);
    const folder = await workspace(taskId, "edit");
    const clean = await makeCut(media, retained, playbackSpeed, aspectRatio, folder);
    const inspected = await inspectMedia({ sourcePath: clean.output });
    const prepared = { ...inspected, aspectRatio, speed: playbackSpeed };
    let transcript = null;
    let transcriptionProblem = "";
    if (prepared.hasAudio && capabilities().asr) {
      try {
        transcript = await transcribeMedia({ taskId, sourcePath: clean.output, language });
      } catch (error) {
        transcriptionProblem = error.message;
      }
    }
    const editPlanPath = path.join(folder, "edit-plan.json");
    await writeFile(editPlanPath, JSON.stringify({
      original: media,
      output: prepared,
      keepRanges: retained,
      speed: playbackSpeed,
      aspectRatio,
      trimAdapter: clean.adapter,
      audioFilters: clean.audioFilters,
      transcriptPath: transcript?.transcriptPath || null,
      transcriptionProblem: transcriptionProblem || null,
    }, null, 2), "utf8");
    return {
      sourcePath: clean.output,
      filePath: clean.output,
      media: prepared,
      editPlanPath,
      trimAdapter: clean.adapter,
      transcript,
      segments: transcript?.segments || [],
      message: transcript?.segments.length ? "剪后音轨已重新转写，请核对字幕和画面" : "请检查剪后音轨或导入剪后字幕",
      transcriptionProblem: transcriptionProblem || null,
    };
  }

  const withPage = async (viewport, callback) => {
    let browser;
    try {
      browser = await chromium.launch({ ...(existsSync(chrome) ? { executablePath: chrome } : {}), headless: true });
    } catch {
      throw problem(503, "本机 Chrome 未能启动，字幕和封面暂时无法渲染");
    }
    try {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      return await callback(page);
    } finally {
      await browser.close();
    }
  };

  async function burnCaptions(media, segments, position, folder, output) {
    const { stripHeight, y, top, bottom } = captionGeometry(media.height, position);
    const fontSize = Math.max(11, Math.round(Math.min(media.width * 0.042, media.height * 0.035)));
    const toSeconds = (value) => Math.max(0, value).toFixed(3);
    const src = await withPage({ width: media.width, height: stripHeight }, async (page) => {
      await page.setContent(`<style>
        html,body{margin:0;background:transparent;width:100%;height:100%}
        body{display:flex;justify-content:center;align-items:center}
        div{width:84%;white-space:pre-line;text-wrap:balance;overflow-wrap:anywhere;text-align:center;color:#fff;font:${fontSize}px/1.2 "PingFang SC","Heiti SC","Noto Sans CJK SC",sans-serif;font-weight:600;text-shadow:0 1px 3px #222,0 0 2px #111}
      </style><div aria-label="字幕"></div>`);
      const timeline = [];
      let cursor = 0;
      const frame = async (filename, caption) => {
        await page.locator("div").evaluate((element, content) => { element.textContent = content; }, caption);
        if (await page.locator("div").evaluate((element) => element.scrollHeight > innerHeight - 2)) {
          throw problem(422, "有字幕超出安全区，请缩短句子或拆成两条");
        }
        await page.screenshot({ path: path.join(folder, filename), omitBackground: true });
      };
      await frame("blank.png", "");
      for (const [index, segment] of segments.entries()) {
        const filename = `caption-${index}.png`;
        await frame(filename, segment.text);
        if (segment.start - cursor > 0.015) timeline.push(`file 'blank.png'\nduration ${toSeconds(segment.start - cursor)}`);
        timeline.push(`file '${filename}'\nduration ${toSeconds(segment.end - segment.start)}`);
        cursor = segment.end;
      }
      if (media.duration - cursor > 0.015) timeline.push(`file 'blank.png'\nduration ${toSeconds(media.duration - cursor)}`);
      timeline.push("file 'blank.png'");
      return timeline.join("\n") + "\n";
    });
    const sequencePath = path.join(folder, "captions.ffconcat");
    await writeFile(sequencePath, src, "utf8");
    await execute("ffmpeg", [
      "-v", "error", "-nostdin", "-protocol_whitelist", "file", "-i", media.sourcePath,
      "-safe", "1", "-f", "concat", "-i", sequencePath,
      "-filter_complex", `[0:v:0][1:v:0]overlay=x=0:y=${y}:eof_action=pass[v]`,
      "-map", "[v]", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
      "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", output,
    ], "字幕合成");
    return { top, bottom };
  }

  async function framesFor(media, folder) {
    return Promise.all([["开头", 0.08], ["中段", 0.5], ["结尾", 0.92]].map(async ([label, fraction], index) => {
      const at = Math.min(media.duration * fraction, Math.max(0, media.duration - 0.05));
      const filePath = path.join(folder, `qc-${index + 1}.jpg`);
      await execute("ffmpeg", ["-v", "error", "-nostdin", "-ss", at.toFixed(3), "-protocol_whitelist", "file", "-i", media.sourcePath, "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", filePath], `${label}抽帧`);
      if (!existsSync(filePath)) throw problem(422, "未能抽取全部质检画面");
      return { label, at, filePath };
    }));
  }

  async function checkCaptionPosition(media, requested, folder) {
    const fallback = requested === "auto" ? "bottom" : requested;
    if (process.platform !== "darwin" || !commandExists("swift")) {
      return { position: fallback, faceScan: "manual_required", overlapAt: [] };
    }
    const source = path.join(folder, "scan-faces.swift");
    await writeFile(source, faceScanScript, "utf8");
    const frames = await framesFor(media, folder);
    const result = await run("swift", [source, ...frames.map((frame) => frame.filePath)], { timeoutMs: 15_000 });
    if (result.code !== 0) return { position: fallback, faceScan: "manual_required", overlapAt: [] };
    let faces;
    try { faces = JSON.parse(result.stdout); } catch { return { position: fallback, faceScan: "manual_required", overlapAt: [] }; }
    const overlaps = (position) => {
      const band = captionGeometry(media.height, position);
      return frames.filter((_, index) => faces[index]?.some((face) => face[1] <= band.bottom + 0.03 && face[3] >= band.top - 0.03));
    };
    const lower = overlaps("bottom");
    const canMoveHigher = requested === "auto" && lower.length > 0 && overlaps("top").length < lower.length;
    const position = canMoveHigher ? "top" : fallback;
    return { position, faceScan: faces.some((sample) => sample.length) ? "faces_sampled" : "no_faces_detected", overlapAt: overlaps(position).map((frame) => frame.at) };
  }

  async function verifyMedia({ taskId, sourcePath, preparedSource, captionBand, captionPlacement, signal }) {
    const media = await inspectMedia({ sourcePath });
    const folder = await workspace(taskId, "qc");
    const frames = await framesFor(media, folder);
    const outputAudio = media.hasAudio ? await run("ffmpeg", [
      "-hide_banner", "-nostdin", "-protocol_whitelist", "file", "-i", media.sourcePath,
      "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-",
    ], { timeoutMs: 120_000 }) : null;
    const peakPattern = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/;
    const meanPattern = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/;
    const peak = outputAudio?.stderr.match(peakPattern)?.[1] ?? null;
    const mean = outputAudio?.stderr.match(meanPattern)?.[1] ?? null;
    const frameChecks = { status: "pending_review", reason: "请播放成片，并对照开中尾抽帧确认字幕避脸、口型和衔接" };
    const observed = {
      media,
      frames,
      measuredAudio: { peakDb: peak === null ? null : Number(peak), meanDb: mean === null ? null : Number(mean) },
      sourceDuration: preparedSource?.duration ?? null,
      audioPreserved: preparedSource ? Boolean(preparedSource.hasAudio) === media.hasAudio : null,
      durationMatched: preparedSource ? Math.abs(preparedSource.duration - media.duration) <= 0.25 : null,
      captionBand: captionBand ?? null,
      captionPlacement: captionPlacement ?? null,
      subtitleMode: signal ?? null,
      frameChecks,
    };
    if (observed.audioPreserved === false || observed.durationMatched === false) throw problem(422, "成片音轨或时长与剪后素材不一致，请检查后重试");
    const reportPath = path.join(folder, "qc.json");
    await writeFile(reportPath, JSON.stringify(observed, null, 2), "utf8");
    return { ...observed, reportPath, status: "awaiting_review", filePath: media.sourcePath, sourcePath: media.sourcePath };
  }

  async function renderMedia({ taskId, sourcePath, ranges, segments, speed, aspectRatio = "original", renderSubtitles = true, captionPosition = "auto" }) {
    let prepared = await inspectMedia({ sourcePath });
    let captions = segments;
    if (ranges || speed !== undefined && Number(speed) !== 1 || aspectRatio !== "original") {
      if (segments?.length) throw problem(400, "先生成剪后素材并重新校对字幕，再从剪后时间线导出");
      const cut = await prepareEdit({ taskId, sourcePath, ranges, speed, aspectRatio });
      if (renderSubtitles && cut.segments.length) throw problem(409, "剪后字幕已可重新转写，请先准备并审阅剪后字幕，再以剪后素材导出");
      prepared = cut.media;
      captions = cut.segments;
    }
    const position = assetPosition(captionPosition);
    const folder = await workspace(taskId, "export");
    let output = prepared.sourcePath;
    let captionBand = null;
    let captionPlacement = null;
    let subtitlesPath = null;
    const normalized = renderSubtitles ? normalizeCaptions(captions || [], prepared.duration) : [];
    if (normalized.length) {
      if (!capabilities().subtitles) throw problem(503, "本机字幕渲染尚未接通，需要可运行的 Chrome");
      output = path.join(folder, "final.mp4");
      subtitlesPath = path.join(folder, "subtitles.srt");
      await writeFile(subtitlesPath, writeSrt(normalized), "utf8");
      captionPlacement = await checkCaptionPosition(prepared, position, folder);
      captionBand = await burnCaptions(prepared, normalized, captionPlacement.position, folder, output);
    }
    const result = await verifyMedia({ taskId, sourcePath: output, preparedSource: prepared, captionBand, captionPlacement, signal: normalized.length ? "burned" : "none" });
    return { ...result, subtitlesPath };
  }

  async function renderCover({ taskId, sourcePath, title, frameAt }) {
    if (!capabilities().cover) throw problem(503, "本机封面渲染尚未接通，需要可运行的 Chrome");
    const media = await inspectMedia({ sourcePath });
    const at = frameAt === undefined ? media.duration / 3 : numberBetween(frameAt, 0, Math.max(0, media.duration - 0.05), "封面画面时间超出成片");
    const folder = await workspace(taskId, "cover");
    const framePath = path.join(folder, "frame.jpg");
    await execute("ffmpeg", ["-v", "error", "-nostdin", "-ss", at.toFixed(3), "-protocol_whitelist", "file", "-i", media.sourcePath, "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", framePath], "抽取真实封面帧");
    const coverPath = path.join(folder, "cover.png");
    const image = await readFile(framePath);
    const caption = singleLine(title, "封面标题", true);
    await withPage({ width: 720, height: 1280 }, async (page) => {
      await page.setContent(`<style>
        body{margin:0;background:#181818;color:white;font-family:"PingFang SC","Heiti SC",sans-serif}
        img{position:absolute;width:100%;height:100%;object-fit:contain}
        div{position:absolute;inset:0;background:linear-gradient(0deg,#000c,transparent 45%)}
        h1{position:absolute;left:9%;right:9%;bottom:8%;margin:0;text-wrap:balance;overflow-wrap:anywhere;font-size:58px;line-height:1.2}
      </style><img alt=""><div></div><h1></h1>`);
      await page.locator("img").evaluate((element, value) => { element.src = value; return element.decode(); }, `data:image/jpeg;base64,${image.toString("base64")}`);
      await page.locator("h1").evaluate((element, value) => { element.textContent = value; }, caption);
      if (await page.locator("h1").evaluate((element) => element.clientHeight > 380)) throw problem(422, "封面标题过长，请缩短后重试");
      await page.screenshot({ path: coverPath });
    });
    return { coverPath, filePath: coverPath, framePath, frameAt: at, adapter: "local_source_frame", status: "awaiting_review" };
  }

  async function publishArgs({ platform, account, sourcePath, assetPath, title, description, tags, coverPath, schedule, xText, xApp, xUsername, visibility }) {
    const channel = normalPlatform(platform);
    if (!capabilities().platforms[channel].video) throw problem(503, "该平台的视频发布工具尚未接通，可在平台发布后补录");
    if (visibility && !["default", "public", "平台默认", "公开"].includes(visibility)) {
      throw problem(400, "该发布工具无法设置所选可见性，请使用平台官方入口");
    }
    const media = await inspectMedia({ sourcePath: sourcePath || assetPath });
    if (path.extname(media.sourcePath).toLowerCase() !== ".mp4") throw problem(400, "自动发布需要已核验的 MP4");
    const accountName = singleLine(account, "账号", true);
    const options = [
      "--platforms", channel, "--account", accountName,
      "--file", media.sourcePath, "--title", singleLine(title, "标题", true),
    ];
    if (description) options.push("--desc", publishText(description, "发布简介"));
    if (tags) options.push("--tags", singleLine(Array.isArray(tags) ? tags.join(",") : tags, "标签"));
    if (coverPath) {
      const image = await localFile(coverPath, imageExtensions, "封面");
      if (channel !== "x") options.push("--cover", image.absolutePath);
    }
    if (schedule && schedule !== "立即" && schedule !== "now") {
      if (channel === "x") throw problem(400, "X 直发不支持定时，请在平台重新选择");
      const value = singleLine(schedule, "发布时间").replace("T", " ");
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) throw problem(400, "定时发布需要 YYYY-MM-DD HH:mm 格式");
      options.push("--schedule", value);
    }
    if (channel === "x") {
      const handle = singleLine(xUsername || accountName, "X 账号", true).replace(/^@/, "");
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw problem(400, "请填写明确的 X 用户名");
      options.push("--x-username", handle);
      if (xText) options.push("--x-text", publishText(xText, "X 正文"));
      if (xApp) options.push("--x-app", singleLine(xApp, "X 应用"));
    }
    return options;
  }

  async function previewPublish(payload) {
    const args = await publishArgs(payload);
    await execute("zsh", [publishScript, ...args], "发布预览", { cwd: root, timeoutMs: 20_000 });
    return { status: "previewed", platform: payload.platform };
  }

  async function publishPlatform(payload) {
    if (payload.confirmed !== true) throw problem(403, "需要当前发布批次的明确确认");
    const args = await publishArgs(payload);
    await execute("zsh", [publishScript, ...args], "发布预览", { cwd: root, timeoutMs: 20_000 });
    const result = await run("zsh", [publishScript, ...args, "--confirm"], { cwd: root, timeoutMs: 12 * 60_000 });
    const platform = payload.platform;
    const matched = platform === "x" ? result.stdout.match(/帖子 ID[：:]\s*(\d+)/) : null;
    if (matched) {
      return { platform, status: "PUBLISHED", postId: matched[1], url: `https://x.com/i/status/${matched[1]}`, observedAt: new Date().toISOString() };
    }
    if (result.code === 0 && platform !== "x" && result.stdout.includes("命令已返回成功")) {
      return { platform, status: "SUBMITTED", message: "平台已接收提交，待核实作品链接或 ID" };
    }
    if (result.started === false || !result.timedOut && !result.stdout.includes("开始执行") && result.code !== 0) {
      return { platform, status: "FAILED", message: "发布工具未进入提交阶段，可确认账号和配置后重试" };
    }
    if (!result.timedOut && platform === "x" && result.stderr.includes("媒体上传失败") && !result.stderr.includes("发帖失败")) {
      return { platform, status: "FAILED", message: "素材上传失败，发帖步骤尚未开始" };
    }
    return { platform, status: "UNKNOWN", message: "提交结果未核实，请先在平台检查已发布或待审核作品" };
  }

  async function collectMetrics({ taskId, version = "v1", platform, postId, url, snapshot, snapshotPath }) {
    const channel = normalPlatform(platform);
    const id = normalTaskId(taskId);
    const currentVersion = singleLine(version, "内容版本", true);
    const chosenId = postIdentity(postId);
    const chosenUrl = postIdentity(url);
    if (!chosenId && !chosenUrl) throw problem(400, "先登记已发布作品的 ID 或链接");
    if (!capabilities().metrics.snapshots) throw problem(503, "本机指标采集工具尚未接通");
    let input = snapshot;
    if (snapshotPath) {
      const file = await localFile(snapshotPath, new Set([".json"]), "数据快照");
      if (file.metadata.size > 4_000_000) throw problem(400, "数据快照超过 4 MB");
      input = safeJson(await readFile(file.absolutePath, "utf8"), "平台数据快照不是有效 JSON");
    }
    if (input) {
      const inputId = postIdentity(input.platform_post_id ?? input.postId);
      const inputUrl = postIdentity(input.platform_url ?? input.url);
      if ((input.platform && input.platform !== channel) || (inputId && chosenId && inputId !== chosenId) || (inputUrl && chosenUrl && inputUrl !== chosenUrl) ||
          ![inputId, inputUrl].filter(Boolean).some((value) => [chosenId, chosenUrl].includes(value))) {
        throw problem(422, "导入快照需要匹配已登记的同平台作品 ID 或链接");
      }
      if (!input.collected_at || !Number.isFinite(Date.parse(input.collected_at))) throw problem(400, "请提供该作品实际采集时间 collected_at");
      if (!input.metrics || typeof input.metrics !== "object" || Array.isArray(input.metrics)) throw problem(400, "数据快照需要 metrics 对象");
      const metrics = Object.values(input.metrics);
      if (!metrics.some((value) => typeof value === "number" && Number.isFinite(value)) || metrics.some((value) => value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) {
        throw problem(422, "至少提供一个真实的非负数字指标，未取得的指标用 null");
      }
      input = { ...input, platform: channel, platform_post_id: inputId || null, platform_url: input.platform_url ?? input.url ?? null };
    } else if (channel !== "x") {
      throw problem(400, "请导入该作品的创作者后台数据快照");
    }

    const folder = await workspace(id, "metrics");
    const reportPath = path.join(folder, "metrics.json");
    const args = [metricsScript, "--content-id", id, "--version", currentVersion, "--platform", channel, "--out", reportPath];
    let result;
    if (input) {
      const originalPath = path.join(folder, "platform-snapshot.json");
      await writeFile(originalPath, JSON.stringify(input, null, 2), "utf8");
      if (channel === "x") {
        result = {
          content_id: id, version: currentVersion, platform: channel,
          platform_post_id: input.platform_post_id, platform_url: input.platform_url,
          collected_at: input.collected_at, collection_state: "COLLECTED",
          source_type: "creator_center_snapshot", metrics: input.metrics, raw: input,
        };
        await writeFile(reportPath, JSON.stringify(result, null, 2), "utf8");
      } else {
        args.push("--input-json", originalPath);
      }
    } else {
      const numericId = [chosenId, chosenUrl].find((value) => /^\d+$/.test(value || ""));
      if (!numericId) throw problem(422, "请提供可识别的 X 作品 ID 或链接");
      args.push("--post-id", numericId);
    }
    if (!result) {
      await execute("python3", args, "数据回收", { cwd: root, timeoutMs: 90_000 });
      result = safeJson(await readFile(reportPath, "utf8"), "未取得可识别的指标记录");
    }
    if (!Object.values(result.metrics || {}).some((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
      throw problem(422, "平台未返回可用于复盘的指标");
    }
    return { ...result, reportPath };
  }

  return { capabilities, inspectMedia, transcribeMedia, prepareEdit, verifyMedia, renderMedia, renderCover, previewPublish, publishPlatform, collectMetrics };
}
