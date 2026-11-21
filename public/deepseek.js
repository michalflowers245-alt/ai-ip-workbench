const opener = document.getElementById("open-deepseek");

if (opener) {
  const dialog = document.createElement("dialog");
  dialog.id = "deepseek-dialog";
  dialog.className = "settings-dialog";
  dialog.setAttribute("aria-labelledby", "deepseek-title");
  dialog.innerHTML = `
    <div class="dialog-head">
      <div>
        <p class="eyebrow">模型连接</p>
        <h2 id="deepseek-title">DeepSeek 官方 API</h2>
      </div>
      <button class="icon-btn" type="button" data-close aria-label="关闭 DeepSeek 设置">×</button>
    </div>
    <p class="dialog-copy">输入 DeepSeek API Key 后，工作台会同步该账户的官方模型列表。启用 DeepSeek 时，模型请求会发送到 DeepSeek 官方 API。</p>
    <form class="connection-form" autocomplete="off">
      <div class="proxy-fields">
        <label>
          DeepSeek API Key
          <input type="password" name="deepseek-key" autocomplete="off" spellcheck="false" placeholder="输入你在 DeepSeek 平台创建的密钥">
        </label>
        <label>
          模型
          <select name="deepseek-model" aria-label="DeepSeek 模型">
            <option value="">自动使用账户首个可用文本模型</option>
          </select>
        </label>
        <label>
          <span><input type="checkbox" name="deepseek-active" style="width:auto"> 设为当前模型提供方</span>
        </label>
      </div>
      <div class="connection-actions">
        <button type="submit">保存并同步</button>
        <button type="button" class="secondary-btn" data-refresh>刷新模型列表</button>
        <button type="button" class="danger-btn" data-clear>清除本机密钥</button>
      </div>
    </form>
    <section class="connection-status" aria-live="polite">
      <div><span>状态</span><b data-provider-status>检测中</b></div>
      <div><span>实际模型</span><b data-effective-model>未选择</b></div>
      <div><span>最近同步</span><b data-synced>尚未同步</b></div>
      <p data-provider-notice></p>
    </section>
    <p data-result class="result-message" aria-live="polite"></p>
  `;
  document.body.append(dialog);

  const form = dialog.querySelector("form");
  const key = form.elements.namedItem("deepseek-key");
  const model = form.elements.namedItem("deepseek-model");
  const active = form.elements.namedItem("deepseek-active");
  const submit = form.querySelector('[type="submit"]');
  const refresh = form.querySelector("[data-refresh]");
  const clear = form.querySelector("[data-clear]");
  const result = dialog.querySelector("[data-result]");
  let current;
  let busy = false;
  let interval;

  async function request(route, body) {
    const response = await fetch(route, body === undefined ? undefined : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "DeepSeek 连接无法完成。");
    return value;
  }

  function render(state, { preserve = false } = {}) {
    const picked = preserve ? model.value : state.model;
    const enabled = preserve ? active.checked : state.active || !state.configured;
    current = state;
    active.checked = enabled;
    key.placeholder = state.configured ? "已保存，留空可沿用" : "输入你在 DeepSeek 平台创建的密钥";
    model.replaceChildren(new Option("自动使用账户首个可用文本模型", ""));
    for (const entry of state.models) {
      const display = entry.name === entry.id ? entry.id : entry.name + " (" + entry.id + ")";
      const option = new Option(display + (entry.availableForWorkflow ? "" : " · 暂不可作为文本模型"), entry.id);
      option.disabled = !entry.availableForWorkflow;
      model.append(option);
    }
    if (picked && state.models.some((item) => item.id === picked && item.availableForWorkflow)) model.value = picked;
    dialog.querySelector("[data-provider-status]").textContent = state.active ? "DeepSeek 当前启用" : state.configured ? "DeepSeek 已配置，本机代理当前启用" : "等待输入 API Key";
    dialog.querySelector("[data-effective-model]").textContent = state.effectiveModel || "未选择";
    dialog.querySelector("[data-synced]").textContent = state.lastSyncAt
      ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(state.lastSyncAt))
      : "尚未同步";
    dialog.querySelector("[data-provider-notice]").textContent = state.notice || "打开设置或发起工作台请求时会检查模型目录更新，间隔 10 分钟。";
    window.dispatchEvent(new CustomEvent("deepseek-settings-change", { detail: state }));
  }

  function busyControls(value) {
    busy = value;
    submit.disabled = value;
    refresh.disabled = value || !current?.configured;
    clear.disabled = value || !current?.configured;
  }

  async function run(operation, pending, done, options) {
    if (busy) return;
    busyControls(true);
    result.textContent = pending || "";
    result.classList.remove("error");
    try {
      const state = await operation();
      render(state, options);
      result.textContent = done || "";
    } catch (error) {
      result.textContent = error.message;
      result.classList.add("error");
    } finally { busyControls(false); }
  }

  opener.addEventListener("click", () => {
    if (!dialog.open) dialog.showModal();
    run(() => request("/api/deepseek"));
    clearInterval(interval);
    interval = setInterval(() => run(() => request("/api/deepseek"), "", "", { preserve: true }), 60_000);
  });
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    key.value = "";
    clearInterval(interval);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const state = await request("/api/deepseek", {
        apiKey: key.value.trim() || undefined, model: model.value, active: active.checked
      });
      key.value = "";
      return state;
    }, "正在向 DeepSeek 校验和同步…", "DeepSeek 设置已保存。");
  });
  refresh.addEventListener("click", () => run(
    () => request("/api/deepseek/refresh", {}), "正在读取官方目录…", "官方模型列表已刷新。", { preserve: true }
  ));
  clear.addEventListener("click", () => {
    if (!window.confirm("清除本机保存的 DeepSeek 密钥并切回本机代理？")) return;
    run(async () => {
      const state = await request("/api/deepseek/clear", {});
      key.value = "";
      return state;
    }, "", "已清除本机密钥。");
  });

  busyControls(false);
}
