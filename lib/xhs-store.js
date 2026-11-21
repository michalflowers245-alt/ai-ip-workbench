import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function hydratePost(row) {
  if (!row) return null;
  const post = { ...row };
  post.tags = parseJson(post.tags_json, []);
  post.fieldSources = parseJson(post.field_sources_json, {});
  post.diagnostics = parseJson(post.diagnostics_json, {});
  delete post.tags_json;
  delete post.field_sources_json;
  delete post.diagnostics_json;
  return post;
}

function cleanPatch(patch, allowed) {
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) => allowed.has(key) && value !== undefined));
}

export class XhsStore {
  constructor(file) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS xhs_search_tasks (
        id TEXT PRIMARY KEY,
        keyword TEXT NOT NULL,
        target_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress_message TEXT NOT NULL DEFAULT '',
        total_links INTEGER NOT NULL DEFAULT 0,
        processed_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        current_url TEXT NOT NULL DEFAULT '',
        stop_requested INTEGER NOT NULL DEFAULT 0,
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS xhs_posts (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'xiaohongshu',
        post_url TEXT NOT NULL UNIQUE,
        post_key TEXT NOT NULL,
        search_keyword TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        published_at TEXT,
        body TEXT NOT NULL DEFAULT '',
        image_text TEXT NOT NULL DEFAULT '',
        video_subtitle TEXT NOT NULL DEFAULT '',
        video_speech TEXT NOT NULL DEFAULT '',
        merged_copy TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        likes INTEGER,
        favorites INTEGER,
        comments INTEGER,
        cover_path TEXT NOT NULL DEFAULT '',
        extracted_at TEXT,
        extraction_status TEXT NOT NULL DEFAULT 'pending',
        completeness INTEGER NOT NULL DEFAULT 0,
        field_sources_json TEXT NOT NULL DEFAULT '{}',
        failure_stage TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        retry_count INTEGER NOT NULL DEFAULT 0,
        diagnostics_json TEXT NOT NULL DEFAULT '{}',
        ocr_status TEXT NOT NULL DEFAULT 'not_needed',
        ocr_message TEXT NOT NULL DEFAULT '',
        asr_status TEXT NOT NULL DEFAULT 'not_needed',
        asr_message TEXT NOT NULL DEFAULT '',
        cleaning_status TEXT NOT NULL DEFAULT 'not_configured',
        cleaning_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS xhs_content_extractions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES xhs_search_tasks(id) ON DELETE CASCADE,
        post_id TEXT NOT NULL REFERENCES xhs_posts(id) ON DELETE CASCADE,
        raw_json TEXT NOT NULL DEFAULT '{}',
        merged_copy TEXT NOT NULL DEFAULT '',
        cleaned_copy TEXT NOT NULL DEFAULT '',
        cleaning_status TEXT NOT NULL DEFAULT 'not_configured',
        field_sources_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS xhs_task_posts (
        task_id TEXT NOT NULL REFERENCES xhs_search_tasks(id) ON DELETE CASCADE,
        post_id TEXT NOT NULL REFERENCES xhs_posts(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(task_id, post_id)
      );
      CREATE TABLE IF NOT EXISTS xhs_task_errors (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES xhs_search_tasks(id) ON DELETE CASCADE,
        post_url TEXT NOT NULL DEFAULT '',
        page_title TEXT NOT NULL DEFAULT '',
        final_url TEXT NOT NULL DEFAULT '',
        screenshot_path TEXT NOT NULL DEFAULT '',
        visible_text_length INTEGER NOT NULL DEFAULT 0,
        dom_locator_count INTEGER NOT NULL DEFAULT 0,
        login_detected INTEGER NOT NULL DEFAULT 0,
        verification_detected INTEGER NOT NULL DEFAULT 0,
        platform_limited INTEGER NOT NULL DEFAULT 0,
        failure_stage TEXT NOT NULL,
        error_message TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_xhs_tasks_created ON xhs_search_tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_xhs_posts_keyword ON xhs_posts(search_keyword, extracted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_xhs_task_posts_keyword ON xhs_task_posts(keyword);
    `);
    const errorColumns = new Set(this.db.prepare("PRAGMA table_info(xhs_task_errors)").all().map((column) => column.name));
    if (!errorColumns.has("platform_limited")) this.db.exec("ALTER TABLE xhs_task_errors ADD COLUMN platform_limited INTEGER NOT NULL DEFAULT 0");
    this.db.prepare(`UPDATE xhs_search_tasks SET status='interrupted', stage='service_restart',
      progress_message='工作台重启；已经完成的结果仍然保留，可重新发起搜索。', completed_at=?, updated_at=?
      WHERE status IN ('queued','opening_browser','searching','extracting','stopping')`).run(now(), now());
  }

  createTask(keyword, targetCount) {
    const id = `xhs_${randomUUID()}`;
    const at = now();
    this.db.prepare(`INSERT INTO xhs_search_tasks
      (id,keyword,target_count,status,stage,progress_message,created_at,updated_at)
      VALUES(?,?,?,'queued','queued','任务已创建，正在等待浏览器。',?,?)`).run(id, keyword, targetCount, at, at);
    return this.getTask(id);
  }

  updateTask(id, patch) {
    const allowed = new Set([
      "status", "stage", "progress_message", "total_links", "processed_count", "success_count",
      "failed_count", "current_url", "stop_requested", "error_message", "started_at", "completed_at"
    ]);
    const values = cleanPatch(patch, allowed);
    values.updated_at = now();
    const keys = Object.keys(values);
    if (keys.length) this.db.prepare(`UPDATE xhs_search_tasks SET ${keys.map((key) => `${key}=?`).join(",")} WHERE id=?`).run(...keys.map((key) => values[key]), id);
    return this.getTask(id);
  }

  getTask(id) {
    return this.db.prepare("SELECT * FROM xhs_search_tasks WHERE id=?").get(id) || null;
  }

  listTasks(options = {}) {
    if (typeof options !== "object" || options === null) options = { limit: options };
    const clauses = [], values = [];
    if (options.keyword) { clauses.push("keyword LIKE ?"); values.push(`%${String(options.keyword).slice(0, 100)}%`); }
    if (options.from) { clauses.push("created_at >= ?"); values.push(String(options.from)); }
    if (options.to) { clauses.push("created_at <= ?"); values.push(String(options.to)); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
    return this.db.prepare(`SELECT * FROM xhs_search_tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...values, limit);
  }

  isStopRequested(id) {
    return Boolean(this.getTask(id)?.stop_requested);
  }

  savePost(taskId, keyword, post, ordinal = 0) {
    const existing = this.db.prepare("SELECT id,retry_count FROM xhs_posts WHERE post_url=?").get(post.postUrl);
    const id = existing?.id || `post_${randomUUID()}`;
    const at = now();
    const payload = {
      platform: "xiaohongshu",
      post_url: post.postUrl,
      post_key: post.postKey || id,
      search_keyword: keyword,
      title: post.title || "",
      author: post.author || "",
      published_at: post.publishedAt || null,
      body: post.body || "",
      image_text: post.imageText || "",
      video_subtitle: post.videoSubtitle || "",
      video_speech: post.videoSpeech || "",
      merged_copy: post.mergedCopy || "",
      tags_json: JSON.stringify(post.tags || []),
      likes: post.likes ?? null,
      favorites: post.favorites ?? null,
      comments: post.comments ?? null,
      cover_path: post.coverPath || "",
      extracted_at: post.extractedAt || at,
      extraction_status: post.extractionStatus || "partial",
      completeness: Math.max(0, Math.min(100, Number(post.completeness) || 0)),
      field_sources_json: JSON.stringify(post.fieldSources || {}),
      failure_stage: post.failureStage || "",
      error_message: post.errorMessage || "",
      retry_count: Number(post.retryCount ?? existing?.retry_count ?? 0),
      diagnostics_json: JSON.stringify(post.diagnostics || {}),
      ocr_status: post.ocrStatus || "not_needed",
      ocr_message: post.ocrMessage || "",
      asr_status: post.asrStatus || "not_needed",
      asr_message: post.asrMessage || "",
      cleaning_status: post.cleaningStatus || "not_configured",
      cleaning_message: post.cleaningMessage || "",
      updated_at: at
    };
    if (existing) {
      const keys = Object.keys(payload);
      this.db.prepare(`UPDATE xhs_posts SET ${keys.map((key) => `${key}=?`).join(",")} WHERE id=?`).run(...keys.map((key) => payload[key]), id);
    } else {
      const keys = ["id", ...Object.keys(payload), "created_at"];
      this.db.prepare(`INSERT INTO xhs_posts (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(id, ...Object.values(payload), at);
    }
    this.db.prepare(`INSERT INTO xhs_task_posts(task_id,post_id,keyword,ordinal,status,error_message)
      VALUES(?,?,?,?,?,?) ON CONFLICT(task_id,post_id) DO UPDATE SET ordinal=excluded.ordinal,status=excluded.status,error_message=excluded.error_message`)
      .run(taskId, id, keyword, ordinal, payload.extraction_status, payload.error_message);
    this.db.prepare(`INSERT INTO xhs_content_extractions
      (id,task_id,post_id,raw_json,merged_copy,cleaned_copy,cleaning_status,field_sources_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
        `extract_${randomUUID()}`, taskId, id, JSON.stringify(post.raw || {}), post.mergedCopy || "",
        post.cleanedCopy || "", payload.cleaning_status, payload.field_sources_json, at
      );
    return this.getPost(id);
  }

  getPost(id) {
    return hydratePost(this.db.prepare("SELECT * FROM xhs_posts WHERE id=?").get(id));
  }

  countPosts() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM xhs_posts").get().count);
  }

  queryPosts(options = {}) {
    const clauses = [], values = [];
    if (options.keyword) { clauses.push("search_keyword LIKE ?"); values.push(`%${String(options.keyword).slice(0, 100)}%`); }
    if (options.from) { clauses.push("extracted_at >= ?"); values.push(String(options.from)); }
    if (options.to) { clauses.push("extracted_at <= ?"); values.push(String(options.to)); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    return this.db.prepare(`SELECT * FROM xhs_posts ${where} ORDER BY extracted_at DESC LIMIT ?`).all(...values, limit).map(hydratePost);
  }

  getTaskResults(taskId) {
    return this.db.prepare(`SELECT p.*,tp.ordinal,tp.status AS task_status,tp.error_message AS task_error
      FROM xhs_task_posts tp JOIN xhs_posts p ON p.id=tp.post_id WHERE tp.task_id=? ORDER BY tp.ordinal,p.extracted_at`).all(taskId).map(hydratePost);
  }

  latestTaskForPost(postId) {
    return this.db.prepare(`SELECT t.* FROM xhs_search_tasks t JOIN xhs_task_posts tp ON tp.task_id=t.id
      WHERE tp.post_id=? ORDER BY t.created_at DESC LIMIT 1`).get(postId) || null;
  }

  addError(taskId, detail) {
    this.db.prepare(`INSERT INTO xhs_task_errors
      (id,task_id,post_url,page_title,final_url,screenshot_path,visible_text_length,dom_locator_count,
       login_detected,verification_detected,platform_limited,failure_stage,error_message,occurred_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        `error_${randomUUID()}`, taskId, detail.postUrl || "", detail.pageTitle || "", detail.finalUrl || "",
        detail.screenshotPath || "", Number(detail.visibleTextLength) || 0, Number(detail.domLocatorCount) || 0,
        detail.loginDetected ? 1 : 0, detail.verificationDetected ? 1 : 0,
        detail.platformLimited ? 1 : 0,
        detail.failureStage || "unknown", detail.errorMessage || "未知错误", now()
      );
  }

  getErrors(taskId) {
    return this.db.prepare("SELECT * FROM xhs_task_errors WHERE task_id=? ORDER BY occurred_at").all(taskId);
  }

  close() {
    this.db.close();
  }
}
