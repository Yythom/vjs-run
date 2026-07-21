// mock server HTTP 层集成测试：node --test scripts/
//
// 这一层此前零覆盖——variant-match/request-schema 的测试都只测纯模块，
// 没有任何用例真正起过服务器、发过一个请求。而请求处理器里恰恰是最难复现的逻辑：
// mock / proxy / 404 / 502 四路分支的优先级、x-mock-* 控制参数、变体命中、
// cookie→auth 条件注入、录制回调。这里用「起真服务器 + 真 fetch」补上。
//
// 每个用例用独立 mkdtemp 目录（spec / rules 文件），避免 server.js 里那个
// 按 mtime 缓存的 jsonFileCache 在用例间串味。
// 端口一律传 0 让内核分配，避免和用户本机跑着的 mock server 撞端口。

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startMockServer } from "../src/mock/server.js";

// ─── 夹具 ────────────────────────────────────────────────────────────────────

/** 最小可用的 OpenAPI 3 文档：一个 GET 列表、一个带路径参数的 GET、一个 POST。 */
function sampleSpec() {
  const okJson = (properties) => ({
    description: "ok",
    content: {
      "application/json": {
        schema: { type: "object", properties },
      },
    },
  });

  return {
    openapi: "3.0.0",
    info: { title: "test-api", version: "1.0.0" },
    paths: {
      "/api/users": {
        get: {
          operationId: "listUsers",
          summary: "用户列表",
          responses: {
            200: okJson({
              rc: { type: "integer" },
              code: { type: "string", enum: ["0"] },
              data: { type: "array", items: { type: "object", properties: { id: { type: "integer" } } } },
            }),
          },
        },
        post: {
          operationId: "createUser",
          responses: { 200: okJson({ rc: { type: "integer" } }) },
        },
      },
      "/api/users/{id}": {
        get: {
          operationId: "getUser",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: okJson({ id: { type: "integer" } }) },
        },
      },
    },
  };
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mock-server-test-"));
}

/** 写出 spec + 可选 rules，返回 startMockServer 需要的路径。 */
function fixture({ spec = sampleSpec(), rules } = {}) {
  const dir = freshDir();
  const specPath = path.join(dir, "api.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));

  let mockRulesFile = "";
  if (rules !== undefined) {
    mockRulesFile = path.join(dir, "mock-rules.json");
    fs.writeFileSync(mockRulesFile, JSON.stringify(rules));
  }
  return { dir, specPath, mockRulesFile };
}

/**
 * 起一台 mock server 跑 fn(ctx)，结束后必定关服务器和 watcher。
 * chokidar watcher 不关会吊住测试进程不退出。
 */
async function withServer(options, fn) {
  const records = [];
  const handle = await startMockServer({
    port: 0,
    onRecord: (entry) => records.push(entry),
    ...options,
  });
  const port = handle.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    return await fn({ base, records, handle, get: (p, init) => fetch(base + p, init) });
  } finally {
    await Promise.all((handle.watchers || []).map((w) => w.close?.()));
    await new Promise((resolve) => handle.server.close(resolve));
  }
}

/** 起一台假后端，记录收到的请求，按 reply 应答。 */
async function withBackend(reply, fn) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    seen.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      rawBody,
    });
    const out = reply?.(req, rawBody) || {};
    res.writeHead(out.status || 200, out.headers || { "content-type": "application/json" });
    res.end(out.body ?? JSON.stringify({ from: "backend" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    return await fn({ url, seen });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ─── 四路分支：mock / proxy / 502 / 404 ──────────────────────────────────────

test("MOCK：mockAll 时 swagger 路由直接返回按 schema 采样的数据", async () => {
  const { specPath } = fixture();
  await withServer({ specPath, mockAll: true }, async ({ get }) => {
    const res = await get("/api/users");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.ok("rc" in body && "data" in body, `采样结果应含 schema 里的字段: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.data));
  });
});

test("502：swagger 里有定义，但没有后端、没有启用规则、没有控制参数 —— 不能静默发假数据", async () => {
  const { specPath } = fixture();
  await withServer({ specPath }, async ({ get }) => {
    const res = await get("/api/users");
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /No backend base URL configured/);
    assert.equal(body.path, "/api/users");
  });
});

test("PROXY：swagger 有定义但无 mock 理由时转发到后端，并带上 x-mock-proxy 标记", async () => {
  const { specPath } = fixture();
  await withBackend(() => ({ body: JSON.stringify({ real: true }) }), async ({ url, seen }) => {
    await withServer({ specPath, backendBaseUrl: url }, async ({ get }) => {
      const res = await get("/api/users");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-mock-proxy"), "true");
      assert.deepEqual(await res.json(), { real: true });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, "/api/users");
    });
  });
});

test("404 MISS：swagger 外的路径 + 无规则 + 无后端", async () => {
  const { specPath } = fixture();
  await withServer({ specPath }, async ({ get }) => {
    const res = await get("/api/nope");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /No mock route matched/);
  });
});

// ─── 规则命中 ────────────────────────────────────────────────────────────────

test("rule-custom：swagger 外的路径也能被自定义规则命中（录制的 backend-only 接口）", async () => {
  const { specPath, mockRulesFile } = fixture({
    rules: [{ method: "GET", path: "/api/legacy", response: { legacy: true }, status: 201 }],
  });
  await withServer({ specPath, mockRulesFile }, async ({ get }) => {
    const res = await get("/api/legacy");
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { legacy: true });
  });
});

test("rule-response：规则的 response 覆盖 swagger 采样结果", async () => {
  const { specPath, mockRulesFile } = fixture({
    rules: [{ method: "GET", path: "/api/users", response: { rc: 9, mine: true } }],
  });
  await withServer({ specPath, mockRulesFile }, async ({ get }) => {
    const res = await get("/api/users");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { rc: 9, mine: true });
  });
});

test("enabled:false 的规则不参与命中：退回 502 而不是走 mock", async () => {
  const { specPath, mockRulesFile } = fixture({
    rules: [{ method: "GET", path: "/api/users", response: { rc: 9 }, enabled: false }],
  });
  await withServer({ specPath, mockRulesFile }, async ({ get }) => {
    assert.equal((await get("/api/users")).status, 502);
  });
});

test("规则路径支持 {param} 占位，且 method 不匹配时不命中", async () => {
  const { specPath, mockRulesFile } = fixture({
    rules: [{ method: "GET", path: "/api/users/{id}", response: { hit: true } }],
  });
  await withServer({ specPath, mockRulesFile }, async ({ get }) => {
    assert.deepEqual(await (await get("/api/users/42")).json(), { hit: true });
    // POST /api/users 在 spec 里存在，但规则是 GET，不该命中 → 无后端 → 502
    assert.equal((await get("/api/users", { method: "POST" })).status, 502);
  });
});

// ─── 变体 ────────────────────────────────────────────────────────────────────

test("变体按 body 条件命中，未命中时回退规则顶层 response", async () => {
  const { specPath, mockRulesFile } = fixture({
    rules: [
      {
        method: "POST",
        path: "/api/users",
        response: { fallback: true },
        variants: [
          {
            name: "vip",
            when: { body: { "user.level": "vip" } },
            response: { vip: true },
            status: 202,
          },
        ],
      },
    ],
  });
  await withServer({ specPath, mockRulesFile }, async ({ get }) => {
    const hit = await get("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: { level: "vip" } }),
    });
    assert.equal(hit.status, 202);
    assert.deepEqual(await hit.json(), { vip: true });

    const miss = await get("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: { level: "normal" } }),
    });
    assert.equal(miss.status, 200);
    assert.deepEqual(await miss.json(), { fallback: true });
  });
});

test("变体按 query 条件命中", async () => {
  const { specPath, mockRulesFile } = fixture({
    rules: [
      {
        method: "GET",
        path: "/api/users",
        response: { fallback: true },
        variants: [{ name: "empty", when: { query: { page: "2" } }, response: { page2: true } }],
      },
    ],
  });
  await withServer({ specPath, mockRulesFile }, async ({ get }) => {
    assert.deepEqual(await (await get("/api/users?page=2")).json(), { page2: true });
    assert.deepEqual(await (await get("/api/users?page=1")).json(), { fallback: true });
  });
});

// ─── 请求控制参数 ────────────────────────────────────────────────────────────

test("__mockStatus / x-mock-status 能在无规则时单独触发 mock 并改状态码", async () => {
  const { specPath } = fixture();
  await withServer({ specPath }, async ({ get }) => {
    // 无规则无后端本会 502，控制参数本身就是 mock 的理由
    const viaQuery = await get("/api/users?__mockStatus=200");
    assert.equal(viaQuery.status, 200);

    const viaHeader = await get("/api/users", { headers: { "x-mock-status": "200" } });
    assert.equal(viaHeader.status, 200);
  });
});

test("__mockDelay 生效且请求仍正常返回", async () => {
  const { specPath } = fixture();
  await withServer({ specPath }, async ({ get }) => {
    const started = Date.now();
    const res = await get("/api/users?__mockDelay=150");
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started >= 140, "应至少延迟约 150ms");
  });
});

// ─── CORS ────────────────────────────────────────────────────────────────────

// 下面几条锁的是 CORS 的**对外行为**，不绑定实现：断言的是浏览器实际依赖的那几个
// 响应头，换不换 cors 包都该成立。曾评估过手写替代 cors，逐头对拍验证过两种实现
// 在 5 个场景下全等——最终判断不值得（净省 7 行、3 个小包），保留 cors@2.8.6。
// 这几条测试留下来当护栏：将来若真要动 CORS，先让它们绿。

test("CORS 预检：204 + Content-Length 0 + 方法/头部白名单", async () => {
  const { specPath } = fixture();
  await withServer({ specPath }, async ({ get }) => {
    const res = await get("/api/users", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(res.status, 204);
    // Safari 少了 Content-Length: 0 会一直等 body 挂住
    assert.equal(res.headers.get("content-length"), "0");
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
    );
    const allowHeaders = res.headers.get("access-control-allow-headers");
    for (const h of ["content-type", "Mgmtauth", "x-mock-status", "x-mock-delay"]) {
      assert.ok(allowHeaders.includes(h), `allow-headers 应含 ${h}: ${allowHeaders}`);
    }
  });
});

// 处理器里原本在 cors 之后还有一段手写的 `if (method === "OPTIONS") -> 204`，
// 那是死代码：cors 在 preflightContinue:false 下会终结**所有** OPTIONS 请求，
// 后面那段永远走不到。删掉它的前提就是这条——没有任何 OPTIONS 会漏下去被当成
// 普通请求路由。无 Origin 头是最容易漏的情形，故单独锁一条。
test("CORS：无 Origin 的 OPTIONS 也被终结为 204，不会掉进路由匹配", async () => {
  const { specPath } = fixture();
  await withServer({ specPath }, async ({ get }) => {
    // /api/users 有定义但无后端无规则，若漏下去会变成 502
    assert.equal((await get("/api/users", { method: "OPTIONS" })).status, 204);
    // swagger 外的路径若漏下去会变成 404
    assert.equal((await get("/api/nope", { method: "OPTIONS" })).status, 204);
  });
});

test("CORS：反射 Origin 必须配 Vary: Origin（否则中间层缓存会跨站串响应）", async () => {
  const { specPath } = fixture();
  await withServer({ specPath, mockAll: true }, async ({ get }) => {
    for (const origin of ["http://localhost:5173", "https://foo.example"]) {
      const res = await get("/api/users", { headers: { origin } });
      assert.equal(res.headers.get("access-control-allow-origin"), origin, "应反射来源而非 *");
      assert.equal(res.headers.get("vary"), "Origin");
    }
  });
});

test("CORS：无 Origin 头时不发 allow-origin（带凭证时 * 非法）", async () => {
  const { specPath } = fixture();
  await withServer({ specPath, mockAll: true }, async ({ get }) => {
    const res = await get("/api/users");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  });
});

test("CORS：实际请求暴露 x-mock-proxy 等响应头，但不发预检专用头", async () => {
  const { specPath } = fixture();
  await withServer({ specPath, mockAll: true }, async ({ get }) => {
    const res = await get("/api/users", { headers: { origin: "http://localhost:5173" } });
    const exposed = res.headers.get("access-control-expose-headers");
    for (const h of ["x-backend-reqid", "X-Request-Id", "x-mock-proxy"]) {
      assert.ok(exposed.includes(h), `expose-headers 应含 ${h}: ${exposed}`);
    }
    assert.equal(res.headers.get("access-control-allow-methods"), null);
    assert.equal(res.headers.get("access-control-allow-headers"), null);
  });
});

// ─── /__mock/* 内置端点 ──────────────────────────────────────────────────────

test("/__mock/health 汇报载入状态", async () => {
  const { specPath } = fixture();
  await withServer({ specPath, backendBaseUrl: "http://example.test" }, async ({ get }) => {
    const body = await (await get("/__mock/health")).json();
    assert.equal(body.ok, true);
    assert.equal(body.files, 1);
    assert.equal(body.routes, 3); // users GET + users POST + users/{id} GET
    assert.deepEqual(body.titles, ["test-api"]);
  });
});

test("/__mock/routes 列出全部路由，/__mock/search 按关键字过滤", async () => {
  const { specPath } = fixture();
  await withServer({ specPath }, async ({ get }) => {
    const routes = await (await get("/__mock/routes")).json();
    assert.equal(routes.length, 3);
    assert.ok(routes.some((r) => r.method === "GET" && r.path === "/api/users"));

    const found = await (await get("/__mock/search?q=listUsers")).json();
    assert.equal(found.length, 1);
    assert.equal(found[0].operationId, "listUsers");

    assert.equal((await (await get("/__mock/search?q=zzz-no-such")).json()).length, 0);
  });
});

// ─── 代理：鉴权注入与字节级转发 ──────────────────────────────────────────────

test("代理注入：cookie 里的 VJTOKEN 在请求头没有 Authorization 时才注入", async () => {
  const { specPath } = fixture();
  await withBackend(null, async ({ url, seen }) => {
    await withServer({ specPath, backendBaseUrl: url }, async ({ get }) => {
      await get("/api/users", { headers: { cookie: "VJTOKEN=tok-from-cookie" } });
      assert.equal(seen[0].headers.authorization, "tok-from-cookie");
    });
  });
});

test("代理注入：已有 Authorization 时不被 cookie 覆盖（前端显式值优先）", async () => {
  const { specPath } = fixture();
  await withBackend(null, async ({ url, seen }) => {
    await withServer({ specPath, backendBaseUrl: url }, async ({ get }) => {
      await get("/api/users", {
        headers: { cookie: "VJTOKEN=tok-from-cookie", authorization: "tok-from-header" },
      });
      assert.equal(seen[0].headers.authorization, "tok-from-header");
    });
  });
});

test("代理注入：TOKEN 只在 /mgmt 路径下注入 Mgmtauth", async () => {
  const spec = sampleSpec();
  spec.paths["/mgmt/api/admins"] = {
    get: { operationId: "listAdmins", responses: { 200: { description: "ok" } } },
  };
  const { specPath } = fixture({ spec });
  await withBackend(null, async ({ url, seen }) => {
    await withServer({ specPath, backendBaseUrl: url }, async ({ get }) => {
      await get("/api/users", { headers: { cookie: "TOKEN=t1" } });
      assert.equal(seen[0].headers.mgmtauth, undefined, "非 mgmt 路径不该注入");

      await get("/mgmt/api/admins", { headers: { cookie: "TOKEN=t1" } });
      assert.equal(seen[1].headers.mgmtauth, "t1");
    });
  });
});

test("代理转发：POST body 字节级原样送达后端，query 一并透传", async () => {
  const { specPath } = fixture();
  const payload = JSON.stringify({ 中文: "值", nested: { n: 1 } });
  await withBackend(null, async ({ url, seen }) => {
    await withServer({ specPath, backendBaseUrl: url }, async ({ get }) => {
      await get("/api/users?a=1&b=2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      assert.equal(seen[0].url, "/api/users?a=1&b=2");
      assert.equal(seen[0].rawBody.toString("utf8"), payload);
    });
  });
});

test("代理：后端非 200 状态码原样透传", async () => {
  const { specPath } = fixture();
  await withBackend(() => ({ status: 503, body: JSON.stringify({ down: true }) }), async ({ url }) => {
    await withServer({ specPath, backendBaseUrl: url }, async ({ get }) => {
      const res = await get("/api/users");
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { down: true });
    });
  });
});

// ─── 录制回调 ────────────────────────────────────────────────────────────────

test("onRecord：mock 命中记录 kind/source/status/请求体", async () => {
  const { specPath, mockRulesFile } = fixture({
    rules: [{ method: "POST", path: "/api/users", response: { ok: 1 } }],
  });
  await withServer({ specPath, mockRulesFile }, async ({ get, records }) => {
    await get("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: 1 }),
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "mock");
    assert.equal(records[0].source, "rule-response");
    assert.equal(records[0].method, "POST");
    assert.equal(records[0].path, "/api/users");
    assert.equal(records[0].status, 200);
    assert.deepEqual(records[0].requestBody, { q: 1 });
    assert.deepEqual(records[0].responseBody, { ok: 1 });
  });
});

test("onRecord：变体命中时带上 variant 名", async () => {
  const { specPath, mockRulesFile } = fixture({
    rules: [
      {
        method: "GET",
        path: "/api/users",
        response: { fallback: true },
        variants: [{ name: "vip", when: { query: { t: "1" } }, response: { vip: true } }],
      },
    ],
  });
  await withServer({ specPath, mockRulesFile }, async ({ get, records }) => {
    await get("/api/users?t=1");
    assert.equal(records[0].source, "rule-variant");
    assert.equal(records[0].variant, "vip");
  });
});

test("onRecord：proxy 与 miss 各自记录对应 kind", async () => {
  const { specPath } = fixture();
  await withBackend(null, async ({ url }) => {
    await withServer({ specPath, backendBaseUrl: url }, async ({ get, records }) => {
      await get("/api/users");
      assert.equal(records.at(-1).kind, "proxy");
    });
  });

  const plain = fixture();
  await withServer({ specPath: plain.specPath }, async ({ get, records }) => {
    await get("/api/nope");
    assert.equal(records.at(-1).kind, "miss");
    assert.equal(records.at(-1).status, 404);
  });
});

test("onRecord 回调抛错不影响请求处理（旁路能力）", async () => {
  const { specPath, mockRulesFile } = fixture({
    rules: [{ method: "GET", path: "/api/users", response: { ok: 1 } }],
  });
  await withServer(
    {
      specPath,
      mockRulesFile,
      onRecord: () => {
        throw new Error("recorder boom");
      },
    },
    async ({ get }) => {
      const res = await get("/api/users");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: 1 });
    },
  );
});

// ─── mockDataDir 文件覆盖 ────────────────────────────────────────────────────
//
// 用文件覆盖某接口的返回。候选路径有三种写法（见 getMockOverrideCandidates），
// 逐一锁住；命中后 source 记为 file:<路径>，且走 fixed 语义——用户手写的内容
// 不该被 tunePayloadForRequest 按 page/size 改造。

/** 在 mockDataDir 下写一个覆盖文件，返回 mockDataDir。 */
function writeOverride(dir, relPath, payload) {
  const mockDataDir = path.join(dir, "mock-data");
  const full = path.join(mockDataDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(payload));
  return mockDataDir;
}

test("override 候选一：{fullPath}.{method}.json", async () => {
  const { dir, specPath } = fixture();
  const mockDataDir = writeOverride(dir, "api/users.get.json", { hi: 1 });
  await withServer({ specPath, mockDataDir }, async ({ get, records }) => {
    const res = await get("/api/users");
    assert.equal(res.status, 200);
    // 非信封内容会被套上默认信封，原内容进 data
    assert.deepEqual(await res.json(), {
      rc: 0,
      code: "SUCCESS",
      message: "success",
      data: { hi: 1 },
    });
    assert.match(records[0].source, /^file:/);
  });
});

test("override 候选二：{fullPath}/{method}.json", async () => {
  const { dir, specPath } = fixture();
  const mockDataDir = writeOverride(dir, "api/users/get.json", { hi: 2 });
  await withServer({ specPath, mockDataDir }, async ({ get }) => {
    assert.deepEqual((await (await get("/api/users")).json()).data, { hi: 2 });
  });
});

test("override 候选三：{specFileName}/{openapiPath}.{method}.json", async () => {
  const { dir, specPath } = fixture();
  // spec 文件名是 api.json → 目录名 api，openapiPath 为 /api/users
  const mockDataDir = writeOverride(dir, "api/api/users.get.json", { hi: 3 });
  await withServer({ specPath, mockDataDir }, async ({ get }) => {
    assert.deepEqual((await (await get("/api/users")).json()).data, { hi: 3 });
  });
});

test("override：内容自带信封字段时不再重复包裹", async () => {
  const { dir, specPath } = fixture();
  const mockDataDir = writeOverride(dir, "api/users.get.json", {
    rc: 0,
    code: "SUCCESS",
    data: [{ id: 7 }],
  });
  await withServer({ specPath, mockDataDir }, async ({ get }) => {
    const body = await (await get("/api/users")).json();
    assert.deepEqual(body.data, [{ id: 7 }], "不该出现 data.data 的二次包裹");
  });
});

test("override：fixed 语义——不被 page/size 参数改造数组长度", async () => {
  const { dir, specPath } = fixture();
  const mockDataDir = writeOverride(dir, "api/users.get.json", { list: [{ id: 1 }] });
  await withServer({ specPath, mockDataDir }, async ({ get }) => {
    const body = await (await get("/api/users?page=1&size=50")).json();
    assert.deepEqual(body.data.list, [{ id: 1 }], "用户手写内容应原样返回");
  });
});

test("override：路径不匹配的文件不命中，退回 502", async () => {
  const { dir, specPath } = fixture();
  const mockDataDir = writeOverride(dir, "api/other.get.json", { hi: 1 });
  await withServer({ specPath, mockDataDir }, async ({ get }) => {
    assert.equal((await get("/api/users")).status, 502);
  });
});

test("override：method 不同的文件不命中（.get.json 不该服务 POST）", async () => {
  const { dir, specPath } = fixture();
  const mockDataDir = writeOverride(dir, "api/users.get.json", { hi: 1 });
  await withServer({ specPath, mockDataDir }, async ({ get }) => {
    assert.equal((await get("/api/users")).status, 200);
    assert.equal((await get("/api/users", { method: "POST" })).status, 502);
  });
});

// ─── 后端不可达 ──────────────────────────────────────────────────────────────

test("代理失败：后端连不上时返回 502 PROXY_ERR，并记录 proxy-error", async () => {
  const { specPath } = fixture();
  // 先起一台再关掉，拿到一个「确定没人监听」的端口
  const dead = http.createServer(() => {});
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadUrl = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((r) => dead.close(r));

  await withServer({ specPath, backendBaseUrl: deadUrl }, async ({ get, records }) => {
    const res = await get("/api/users");
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /Proxy request failed/);
    assert.ok(body.target.startsWith(deadUrl), `target 应指向后端: ${body.target}`);
    assert.equal(records.at(-1).kind, "proxy-error");
    assert.equal(records.at(-1).status, 502);
  });
});

// ─── 变体全不命中时的代理回退 ────────────────────────────────────────────────

test("只有变体、全不命中、无顶层 response → 转发后端，且已消费的 body 必须补传", async () => {
  // 这条最容易回归：判定变体需要读 body，请求流因此被消费；
  // 转发时若不补传 consumedRawBody，后端收到的会是空 body。
  const { specPath, mockRulesFile } = fixture({
    rules: [
      {
        method: "POST",
        path: "/api/legacy", // swagger 之外的路径，走 !route 分支
        variants: [{ name: "vip", when: { body: { level: "vip" } }, response: { vip: true } }],
      },
    ],
  });
  const payload = JSON.stringify({ level: "normal", keep: "me" });
  await withBackend(null, async ({ url, seen }) => {
    await withServer({ specPath, mockRulesFile, backendBaseUrl: url }, async ({ get }) => {
      const res = await get("/api/legacy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-mock-proxy"), "true");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].rawBody.toString("utf8"), payload, "body 不能在变体判定后丢失");
    });
  });
});

test("只有变体、命中时仍走 mock 不转发", async () => {
  const { specPath, mockRulesFile } = fixture({
    rules: [
      {
        method: "POST",
        path: "/api/legacy",
        variants: [{ name: "vip", when: { body: { level: "vip" } }, response: { vip: true } }],
      },
    ],
  });
  await withBackend(null, async ({ url, seen }) => {
    await withServer({ specPath, mockRulesFile, backendBaseUrl: url }, async ({ get }) => {
      const res = await get("/api/legacy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: "vip" }),
      });
      assert.deepEqual(await res.json(), { vip: true });
      assert.equal(seen.length, 0, "命中变体不该打到后端");
    });
  });
});

test("只有变体、全不命中、也没有后端 → 404 而不是 200 空响应", async () => {
  const { specPath, mockRulesFile } = fixture({
    rules: [
      {
        method: "GET",
        path: "/api/legacy",
        variants: [{ name: "x", when: { query: { a: "1" } }, response: { x: true } }],
      },
    ],
  });
  await withServer({ specPath, mockRulesFile }, async ({ get }) => {
    assert.equal((await get("/api/legacy?a=2")).status, 404);
  });
});

// ─── 顶层错误处理 ────────────────────────────────────────────────────────────

test("处理过程抛错 → 500 且带错误信息，服务器不崩", async () => {
  const { dir, specPath } = fixture();
  // 坏 JSON 的 override 文件会让 loadMockOverride 抛错，冒泡到顶层 catch
  const mockDataDir = path.join(dir, "mock-data");
  fs.mkdirSync(path.join(mockDataDir, "api"), { recursive: true });
  fs.writeFileSync(path.join(mockDataDir, "api/users.get.json"), "{ 这不是合法 JSON");

  await withServer({ specPath, mockDataDir }, async ({ get }) => {
    const res = await get("/api/users");
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, "Mock server error");
    assert.match(body.message, /Failed to load mock override/);

    // 关键：出错后服务器仍然可用，不是崩了
    assert.equal((await get("/api/nope")).status, 404);
  });
});

// ─── 启动校验 ────────────────────────────────────────────────────────────────

test("非 OpenAPI 3 文档启动即报错", async () => {
  const { specPath } = fixture({ spec: { swagger: "2.0", paths: {} } });
  await assert.rejects(() => startMockServer({ specPath, port: 0 }), /OpenAPI 3\.x/);
});

test("spec 里没有任何可 mock 路由时启动报错", async () => {
  const { specPath } = fixture({
    spec: { openapi: "3.0.0", info: { title: "t", version: "1" }, paths: {} },
  });
  await assert.rejects(() => startMockServer({ specPath, port: 0 }), /No mockable routes/);
});
