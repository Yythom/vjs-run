// generateSwaggerSpecs 的落盘行为：node --test scripts/
//
// 重点防回归：生成失败（swagger 服务器 / converter 不可达）时不能把旧 spec 删掉，
// 否则目录被清空，mock 从此起不来。
// 全局 fetch 被 stub 掉，不发任何真实网络请求；输出目录用 mkdtemp，不碰用户数据。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateSwaggerSpecs, PROJECT_TYPES } from "../src/mock/generate-spec.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gen-spec-test-"));
}

const jsonResponse = (body) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** failTypes 里的服务拉 api-docs 时网络失败，其余服务正常走 api-docs → converter → errors */
function stubFetch({ failTypes = [] } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/api/convert")) {
      // converter：把 swagger2 原样「转」成一份带标记的 openapi3
      const origin = JSON.parse(init.body);
      return jsonResponse({
        openapi: "3.0.0",
        info: { title: origin.info.title, version: "1" },
        paths: { [`/${origin.info.title}/ping`]: { get: { responses: {} } } },
        components: { schemas: {} },
      });
    }
    const type = PROJECT_TYPES.find((t) => u.includes(`/${t}/`));
    if (u.includes("/errors/api-ecs")) return jsonResponse([]);
    if (failTypes.includes(type)) throw new TypeError("fetch failed");
    return jsonResponse({ swagger: "2.0", info: { title: type }, paths: {} });
  };
}

const OLD = '{"openapi":"3.0.0","info":{"title":"old"},"paths":{}}';

test("全部服务生成失败：旧 spec 原样保留，不留 .tmp", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "vjg.json"), OLD);
  fs.writeFileSync(path.join(dir, "api-index.json"), "{}");
  stubFetch({ failTypes: PROJECT_TYPES });

  await assert.rejects(
    generateSwaggerSpecs({ serverUrl: "http://swagger.test", outputDir: dir }),
    /部分服务的 OpenAPI JSON 生成失败/,
  );
  assert.equal(fs.readFileSync(path.join(dir, "vjg.json"), "utf8"), OLD);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["api-index.json", "vjg.json"]);
});

test("部分失败：成功的服务被覆盖，失败的服务保留旧文件", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "vjg.json"), OLD);
  fs.writeFileSync(path.join(dir, "vjh.json"), OLD);
  stubFetch({ failTypes: ["vjh"] });

  await assert.rejects(
    generateSwaggerSpecs({ serverUrl: "http://swagger.test", outputDir: dir }),
    /vjh\(fetch failed\)/,
  );
  const vjg = JSON.parse(fs.readFileSync(path.join(dir, "vjg.json"), "utf8"));
  assert.ok(vjg.paths["/vjg/ping"], "vjg 应被新内容覆盖");
  assert.equal(fs.readFileSync(path.join(dir, "vjh.json"), "utf8"), OLD, "vjh 失败应保留旧文件");
  assert.equal(fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), false);
});

test("全部成功：各服务 json 覆盖写入，并生成 api-index.json", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "vjg.json"), OLD);
  fs.writeFileSync(path.join(dir, "notes.txt"), "别动我");
  stubFetch();

  const { generated, failed } = await generateSwaggerSpecs({
    serverUrl: "http://swagger.test/",
    outputDir: dir,
  });
  assert.deepEqual([...generated].sort(), [...PROJECT_TYPES].sort());
  assert.deepEqual(failed, []);
  for (const type of PROJECT_TYPES) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, `${type}.json`), "utf8"));
    assert.ok(doc.paths[`/${type}/ping`], `${type}.json 内容应为新生成的`);
  }
  assert.ok(fs.existsSync(path.join(dir, "api-index.json")));
  assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "别动我");
});
