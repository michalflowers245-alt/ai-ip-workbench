// Browser drafts are separate from accepted task versions and never authorize actions.
export function createDraftStore(storage) {
  const memory = new Map();
  const prefix = "self-media-workbench:draft:v1:";
  let persistent = true;
  const key = (task, stage) => prefix + task + ":" + stage;
  return {
    get persistent() { return persistent; },
    read(task, stage) {
      const id = key(task, stage);
      // A failed storage write must not replace the newest in-page edit with an older disk value.
      if (memory.has(id)) return memory.get(id);
      try {
        const raw = storage.getItem(id);
        if (raw) {
          const value = JSON.parse(raw);
          if (value?.values && typeof value.values === "object" && !Array.isArray(value.values)) {
            memory.set(id, value);
            return value;
          }
        }
      } catch { persistent = false; }
      return memory.get(id) || null;
    },
    write(task, stage, entry) {
      const id = key(task, stage);
      if (!Object.keys(entry.values || {}).length) return this.remove(task, stage);
      const value = { ...entry, updatedAt: new Date().toISOString() };
      memory.set(id, value);
      try { storage.setItem(id, JSON.stringify(value)); } catch { persistent = false; }
      return value;
    },
    remove(task, stage) {
      const id = key(task, stage);
      memory.set(id, null);
      try { storage.removeItem(id); } catch { persistent = false; }
      return null;
    },
    reconcile(task, stage, revision, version, consumed) {
      const old = this.read(task, stage);
      if (!old) return;
      const values = Object.fromEntries(Object.entries(old.values).filter(([key]) => !consumed.some((name) => name === "*" || key === name || key.startsWith(name + "."))));
      return this.write(task, stage, { ...old, revision, version, values });
    }
  };
}

export function taskPage(tasks, { role = "home", excludeId, query = "", status = "", page = 1, size = 12, start = 0 } = {}) {
  const term = query.trim().toLocaleLowerCase();
  const rows = tasks.filter((task) => task.id !== excludeId && (role === "home" || task.stage === role))
    .slice(start).filter((task) => (!status || task.status === status)
      && (!term || [task.id, task.title, task.nextAction].some((value) => String(value || "").toLocaleLowerCase().includes(term))));
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((current - 1) * size, current * size), total: rows.length, page: current, pages };
}
