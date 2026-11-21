import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeepSeek } from "../lib/deepseek.js";

const sampleKey = "sk-test-fixture-only";
const flash = { id: "deepseek-flash", name: "DeepSeek Flash", max_output_tokens: 6000 };
const pro = { id: "deepseek-v4-pro", name: "DeepSeek Pro" };
const beta = { id: "future-deepseek-beta", name: "Future DeepSeek Beta", max_output_tokens: 3600 };

async function fixture(t, fetcher, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "deepseek-workbench-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, provider: createDeepSeek({ dataDir, fetcher, ...options }) };
}

function models(...items) {
  return Response.json({ object: "list", data: items });
}

test("validates a user-entered API key, lists its official models, and keeps credentials private", async (t) => {
  const observed = [];
  const { dataDir, provider } = await fixture(t, (url, options) => {
    observed.push({ url, options });
    return models(flash, pro, { id: "image-test", input_modalities: ["image"], output_modalities: ["image"] }, flash);
  });
  assert.equal((await provider.view()).configured, false);
  assert.equal(observed.length, 0);
  const configured = await provider.save({ apiKey: sampleKey, active: true });
  assert.equal(configured.active, true);
  assert.equal(configured.effectiveModel, flash.id);
  assert.deepEqual(configured.models.map((item) => item.id), [flash.id, pro.id, "image-test"]);
  assert.equal(configured.models[2].availableForWorkflow, false);
  assert.equal(JSON.stringify(configured).includes(sampleKey), false);
  assert.deepEqual(observed.map((call) => [call.url, call.options.method]), [["https://api.deepseek.com/models", "GET"]]);
  assert.equal(observed[0].options.redirect, "error");
  assert.equal(observed[0].options.headers.Authorization, "Bearer " + sampleKey);
  assert.equal((await stat(path.join(dataDir, "credentials"))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dataDir, "credentials", "deepseek-provider.json"))).mode & 0o777, 0o600);

  await assert.rejects(provider.save({ model: "image-test" }), { status: 400 });
  const resolved = await provider.save({ model: pro.id, active: false });
  assert.equal(resolved.model, pro.id);
  assert.equal(resolved.effectiveModel, pro.id);
  assert.equal(resolved.active, false);
  assert.equal(observed.length, 1);
  assert.deepEqual((await provider.clear()).models, []);
  assert.equal((await provider.view()).configured, false);
  await assert.rejects(stat(path.join(dataDir, "credentials", "deepseek-provider.json")), { code: "ENOENT" });
});

test("official catalog updates reach generation without static IDs, and retired selections fall back", async (t) => {
  const observed = [];
  let now = Date.parse("2026-11-17T03:00:00Z");
  let available = [flash, pro];
  const { provider } = await fixture(t, (url, options) => {
    observed.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (url.endsWith("/models")) return models(...available);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"title":"样例"}' } }] });
  }, { clock: () => now, catalogMaxAge: 60_000 });

  await provider.save({ apiKey: sampleKey, active: true });
  await provider.save({ model: pro.id });
  const first = await provider.complete({ system: "只输出 JSON", user: "写标题", maxTokens: 5000, json: true });
  assert.equal(first.text, '{"title":"样例"}');
  assert.equal(observed.at(-1).body.model, pro.id);

  available = [beta, flash];
  now += 60_001;
  const next = await provider.complete({ system: "只输出 JSON", user: "写标题", maxTokens: 5000, json: true });
  assert.equal(next.text, '{"title":"样例"}');
  assert.equal(observed.at(-2).url, "https://api.deepseek.com/models");
  assert.equal(observed.at(-1).url, "https://api.deepseek.com/chat/completions");
  assert.equal(observed.at(-1).body.model, beta.id);
  assert.equal(observed.at(-1).body.max_tokens, 3600);
  assert.deepEqual(observed.at(-1).body.response_format, { type: "json_object" });
  assert.deepEqual(observed.at(-1).body.thinking, { type: "disabled" });
  const state = await provider.view();
  assert.equal(state.model, "");
  assert.equal(state.effectiveModel, beta.id);
  assert.match(state.notice, /官方可用列表移除/);
});

test("keeps the working configuration when a replacement key is rejected", async (t) => {
  const nextKey = "sk-invalid-test-fixture";
  const { provider } = await fixture(t, (_, { headers }) => {
    if (headers.Authorization === "Bearer " + nextKey) return Response.json({ error: nextKey }, { status: 401 });
    return models(flash);
  });
  await provider.save({ apiKey: sampleKey, active: true });
  await assert.rejects(provider.save({ apiKey: nextKey, active: false }), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message.includes(nextKey), false);
    return true;
  });
  assert.equal((await provider.view()).active, true);
  assert.equal((await provider.refresh()).effectiveModel, flash.id);
});
