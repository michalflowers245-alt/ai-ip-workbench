import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const officialBase = "https://api.deepseek.com";
const syncInterval = 10 * 60 * 1000;

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

function cleanModel(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._/:+-]{0,199}$/i.test(value) ? value : "";
}

function safeList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length < 40) : [];
}

function readModels(result) {
  if (!Array.isArray(result?.data)) throw problem(502, "DeepSeek 官方 API 未返回可识别的模型列表。");
  const models = [];
  const seen = new Set();
  for (const row of result.data) {
    const id = cleanModel(row?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 200) : id,
      input: safeList(row.input_modalities),
      output: safeList(row.output_modalities),
      maxTokens: Number.isSafeInteger(row.max_output_tokens) && row.max_output_tokens > 0 ? row.max_output_tokens : undefined
    });
  }
  return models;
}

function modelForText(model) {
  return !(model.input?.length && !model.input.includes("text")) &&
    !(model.output?.length && !model.output.includes("text"));
}

function matchModel(state) {
  if (state.model) return state.models.find((item) => item.id === state.model && modelForText(item));
  return state.models.find(modelForText);
}

function viewState(state) {
  return {
    configured: Boolean(state.key),
    active: state.active === true,
    model: state.model || "",
    effectiveModel: matchModel(state)?.id || "",
    models: state.models.map((item) => ({
      ...item, availableForWorkflow: modelForText(item)
    })),
    lastSyncAt: state.lastSyncAt || null,
    notice: state.notice || ""
  };
}

function checkKey(userInput) {
  if (userInput === undefined || userInput === "") return "";
  if (typeof userInput !== "string") throw problem(400, "请填写 DeepSeek API Key。");
  const normalized = userInput.trim();
  if (!/^[!-~]{8,256}$/.test(normalized)) throw problem(400, "请输入有效的 DeepSeek API Key。");
  return normalized;
}

export function createDeepSeek({ dataDir, fetcher = globalThis.fetch, clock = () => Date.now(), catalogMaxAge = syncInterval }) {
  const credentialDir = path.join(dataDir, "credentials");
  const credentialFile = path.join(credentialDir, "deepseek-provider.json");
  let queue = Promise.resolve();
  let lastAutoAttempt = Number.NEGATIVE_INFINITY;

  function serialized(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }

  async function load() {
    try {
      const info = await lstat(credentialFile);
      if (!info.isFile() || info.mode & 0o077) throw problem(500, "DeepSeek 本机凭据文件没有专用读写权限。");
      return JSON.parse(await readFile(credentialFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { key: "", model: "", active: false, models: [] };
      if (error.status) throw error;
      throw problem(500, "无法读取 DeepSeek 本机配置。");
    }
  }

  async function write(state) {
    const temporary = path.join(credentialDir, ".deepseek-" + randomUUID());
    try {
      await mkdir(credentialDir, { recursive: true, mode: 0o700 });
      if (!(await lstat(credentialDir)).isDirectory()) throw new Error("unsafe directory");
      await chmod(credentialDir, 0o700);
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await rename(temporary, credentialFile);
    } catch {
      throw problem(500, "无法保存 DeepSeek 本机配置。");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function upstream(route, key, payload) {
    let result;
    try {
      result = await fetcher(officialBase + route, {
        method: payload === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(payload ? 180_000 : 30_000),
        headers: {
          Authorization: "Bearer " + key,
          ...(payload ? { "Content-Type": "application/json" } : {})
        },
        ...(payload ? { body: JSON.stringify(payload) } : {})
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") throw problem(504, "DeepSeek 官方 API 响应超时。");
      throw problem(502, "无法连接 DeepSeek 官方 API。");
    }
    if (!result.ok) {
      await result.body?.cancel().catch(() => {});
      if (result.status === 401) throw problem(401, "DeepSeek API Key 无效或已失效。");
      if (result.status === 402) throw problem(402, "DeepSeek 账户可用额度不足。");
      if (result.status === 403) throw problem(403, "该 DeepSeek 账户无法调用此接口。");
      if (result.status === 404) throw problem(404, "DeepSeek 官方 API 找不到该资源或模型。");
      if (result.status === 429) throw problem(429, "DeepSeek 请求过于频繁，请稍后再试。");
      throw problem(502, "DeepSeek 官方 API 请求失败（HTTP " + result.status + "）。");
    }
    try { return await result.json(); }
    catch { throw problem(502, "DeepSeek 官方 API 未返回有效 JSON。"); }
  }

  async function synced(state) {
    if (!state.key) throw problem(409, "请先输入 DeepSeek API Key。");
    const models = readModels(await upstream("/models", state.key));
    const changed = state.model && !models.some((item) => item.id === state.model && modelForText(item));
    return {
      ...state, models,
      model: changed ? "" : state.model,
      lastSyncAt: new Date(clock()).toISOString(),
      notice: changed ? "之前的模型已从官方可用列表移除，现跟随账户的首个可用文本模型。" : ""
    };
  }

  async function ensureFresh() {
    return serialized(async () => {
      const state = await load();
      if (!state.key) return state;
      const now = clock();
      if (now - Date.parse(state.lastSyncAt) < catalogMaxAge || now - lastAutoAttempt < 60_000) return state;
      lastAutoAttempt = now;
      try {
        const next = await synced(state);
        await write(next);
        return next;
      } catch (error) {
        if (!state.models.length) throw error;
        return { ...state, notice: "暂时无法同步，显示最近一次成功获取的模型列表。" };
      }
    });
  }

  async function refresh() {
    return serialized(async () => {
      const next = await synced(await load());
      lastAutoAttempt = clock();
      await write(next);
      return viewState(next);
    });
  }

  async function save({ apiKey, model, active } = {}) {
    return serialized(async () => {
      const stored = await load();
      const key = checkKey(apiKey);
      if (active !== undefined && typeof active !== "boolean") throw problem(400, "请明确是否启用 DeepSeek。");
      let state = key && key !== stored.key ? await synced({ ...stored, model: "", key, models: [] }) : stored;
      if (!state.key && (active || model)) throw problem(409, "请先输入 DeepSeek API Key。");
      if (model !== undefined) {
        if (model !== "" && !state.models.some((item) => item.id === model && modelForText(item))) {
          if (!(key && key !== stored.key)) throw problem(400, "请从该账户的官方模型列表选择。");
        } else state = { ...state, model };
      }
      state = { ...state, active: active ?? state.active };
      if (state.active && !matchModel(state)) throw problem(409, "这个账户暂时没有工作台可使用的文本模型。");
      if (state.key) await write(state);
      return viewState(state);
    });
  }

  async function clear() {
    return serialized(async () => {
      try { await rm(credentialFile, { force: true }); }
      catch { throw problem(500, "无法清除 DeepSeek 本机设置。"); }
      lastAutoAttempt = Number.NEGATIVE_INFINITY;
      return viewState({ key: "", model: "", models: [], active: false });
    });
  }

  async function complete({ system, user, maxTokens, json = false }) {
    let state = await ensureFresh();
    if (!state.active || !state.key) throw problem(409, "DeepSeek 尚未设为当前模型提供方。");
    const start = clock();

    async function request(selected) {
      const currentModel = matchModel(selected);
      if (!currentModel) throw problem(409, "此账户当前没有工作台可使用的模型。");
      const requested = Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : 1200;
      const result = await upstream("/chat/completions", selected.key, {
        model: currentModel.id,
        messages: [
          { role: "system", content: String(system || "") },
          { role: "user", content: String(user || "") }
        ],
        max_tokens: Math.min(requested, currentModel.maxTokens || requested),
        thinking: { type: "disabled" },
        ...(json ? { response_format: { type: "json_object" } } : {})
      });
      const choice = result?.choices?.[0];
      const content = choice?.message?.content;
      if (choice?.finish_reason === "length") throw problem(422, "DeepSeek 回复达到本步骤输出上限，请缩短输入后重试。");
      if (typeof content !== "string" || !content.trim()) throw problem(502, "DeepSeek 返回了空回复。");
      return { text: content.trim(), latencyMs: Math.max(0, clock() - start) };
    }

    try { return await request(state); }
    catch (error) {
      if (error.status !== 404) throw error;
      const before = matchModel(state)?.id;
      await refresh();
      state = await load();
      if (state.active && matchModel(state)?.id && matchModel(state).id !== before) return request(state);
      throw error;
    }
  }

  return {
    view: async ({ refreshIfStale = false } = {}) => viewState(refreshIfStale ? await ensureFresh() : await load()),
    save, refresh, clear, complete
  };
}
