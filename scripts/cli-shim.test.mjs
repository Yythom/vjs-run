// app 内置 vjtools 命令（src/services/cli-shim.js）：node --test scripts/
//
// 全部在 mkdtemp 目录里进行：假的「app 可执行文件」、假的 PATH 目录、替身管理员授权，
// 绝不往真实的 /usr/local/bin、/opt/homebrew/bin 写东西。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cliShimPath,
  findCliLinks,
  getCliStatus,
  installCliLink,
  pickLinkDir,
  uninstallCliLink,
  writeCliShim,
} from "../src/services/cli-shim.js";

function tmp(prefix = "cli-shim-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 假 app：打印收到的环境变量和参数，代替 Electron 二进制 */
function fakeApp(dir) {
  const exec = path.join(dir, "My App's.app", "Contents", "MacOS", "vjtools");
  fs.mkdirSync(path.dirname(exec), { recursive: true });
  fs.writeFileSync(exec, '#!/bin/sh\necho "RUN_AS_NODE=$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do echo "ARG=$a"; done\n', {
    mode: 0o755,
  });
  return exec;
}

function setup() {
  const root = tmp();
  const execPath = fakeApp(root);
  const cliEntry = path.join(root, "My App's.app", "Contents", "Resources", "app.asar", "src", "cli", "index.js");
  const shimPath = cliShimPath(path.join(root, "user data"));
  writeCliShim({ shimPath, execPath, cliEntry });
  return { root, execPath, cliEntry, shimPath };
}

test("生成的脚本以 node 模式调起 app，参数原样透传（路径含空格、单引号也不出错）", () => {
  const { shimPath, cliEntry } = setup();
  assert.equal(fs.statSync(shimPath).mode & 0o777, 0o755);

  const r = spawnSync(shimPath, ["mock", "status", "--json", "带 空格"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), [
    "RUN_AS_NODE=1",
    `ARG=${cliEntry}`,
    "ARG=mock",
    "ARG=status",
    "ARG=--json",
    "ARG=带 空格",
  ]);
});

test("app 被挪走后脚本给出明确报错；重新写入（app 下次启动）即恢复", () => {
  const { shimPath, execPath, cliEntry, root } = setup();
  const moved = path.join(root, "moved");
  fs.renameSync(path.dirname(path.dirname(path.dirname(execPath))), moved);

  const broken = spawnSync(shimPath, ["--version"], { encoding: "utf8" });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /找不到 vjtools app/);

  const newExec = path.join(moved, "Contents", "MacOS", "vjtools");
  assert.equal(writeCliShim({ shimPath, execPath: newExec, cliEntry }).changed, true);
  assert.equal(spawnSync(shimPath, [], { encoding: "utf8" }).status, 0);
  // 内容没变时不重写
  assert.equal(writeCliShim({ shimPath, execPath: newExec, cliEntry }).changed, false);
});

test("getCliStatus：区分 PATH 上的 vjtools 是 app 内置还是别处装的", () => {
  const { shimPath, root } = setup();
  const binA = path.join(root, "binA");
  const binB = path.join(root, "binB");
  fs.mkdirSync(binA);
  fs.mkdirSync(binB);

  assert.equal(getCliStatus({ shimPath, pathEnv: `${binA}:${binB}` }).source, null);

  fs.symlinkSync(shimPath, path.join(binB, "vjtools"));
  const ours = getCliStatus({ shimPath, pathEnv: `${binA}:${binB}` });
  assert.equal(ours.source, "app");
  assert.equal(ours.onPath, path.join(binB, "vjtools"));

  // PATH 更靠前的位置有 npm 装的：以 PATH 顺序为准
  fs.writeFileSync(path.join(binA, "vjtools"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(getCliStatus({ shimPath, pathEnv: `${binA}:${binB}` }).source, "external");
});

test("pickLinkDir：只选在 PATH 上且可写的候选目录，按候选顺序", () => {
  const root = tmp();
  const [readonly, notOnPath, good, later] = ["ro", "off", "good", "later"].map((name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return dir;
  });
  fs.chmodSync(readonly, 0o555);
  const pathEnv = [readonly, good, later].join(":");
  assert.equal(pickLinkDir(pathEnv, { candidates: [readonly, notOnPath, good, later] }), good);
  assert.equal(pickLinkDir(pathEnv, { candidates: [notOnPath] }), null);
  // ~/ 展开成 home
  assert.equal(pickLinkDir(good, { home: root, candidates: ["~/good"] }), good);
  fs.chmodSync(readonly, 0o755);
});

test("installCliLink：装进可写的 PATH 目录；重复安装返回 already", async () => {
  const { shimPath, root } = setup();
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const admin = () => assert.fail("有可写目录时不应请求管理员权限");

  const first = await installCliLink({ shimPath, pathEnv: bin, candidates: [bin], admin });
  assert.deepEqual(first, { status: "installed", linkPath: path.join(bin, "vjtools") });
  assert.equal(fs.readlinkSync(path.join(bin, "vjtools")), shimPath);

  const again = await installCliLink({ shimPath, pathEnv: bin, candidates: [bin], admin });
  assert.equal(again.status, "already");
});

test("installCliLink：PATH 上已有别处装的 vjtools 时不覆盖", async () => {
  const { shimPath, root } = setup();
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const npmBin = path.join(bin, "vjtools");
  fs.writeFileSync(npmBin, "#!/bin/sh\necho npm\n", { mode: 0o755 });

  const res = await installCliLink({ shimPath, pathEnv: bin, candidates: [bin], admin: () => assert.fail() });
  assert.deepEqual(res, { status: "external", linkPath: npmBin });
  assert.equal(fs.readFileSync(npmBin, "utf8"), "#!/bin/sh\necho npm\n");
});

test("installCliLink：坏掉的旧软链会被替换，同名真文件拒绝覆盖", async () => {
  const { shimPath, root } = setup();
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const link = path.join(bin, "vjtools");

  fs.symlinkSync(path.join(root, "已删除的旧版"), link);
  const replaced = await installCliLink({ shimPath, pathEnv: bin, candidates: [bin] });
  assert.equal(replaced.status, "installed");
  assert.equal(fs.readlinkSync(link), shimPath);

  fs.unlinkSync(link);
  fs.writeFileSync(link, "不可执行的同名文件"); // whichCli 看不到它（没有 x 权限）
  await assert.rejects(installCliLink({ shimPath, pathEnv: bin, candidates: [bin] }), /已存在且不是软链/);
  assert.equal(fs.readFileSync(link, "utf8"), "不可执行的同名文件");
});

test("installCliLink：没有可写目录时走管理员授权；用户取消返回 canceled", async () => {
  const { shimPath, root } = setup();
  const commands = [];
  const granted = await installCliLink({
    shimPath,
    pathEnv: "/usr/local/bin:/usr/bin",
    candidates: [path.join(root, "不存在")],
    admin: async (command) => {
      commands.push(command);
      return true;
    },
  });
  assert.deepEqual(granted, { status: "installed", linkPath: "/usr/local/bin/vjtools", admin: true, onPath: true });
  assert.match(commands[0], /ln -sfn '.*user data\/bin\/vjtools' '\/usr\/local\/bin\/vjtools'/);
  assert.match(commands[0], /已存在且不是软链/, "授权命令里也要带上不覆盖真文件的检查");

  const canceled = await installCliLink({
    shimPath,
    pathEnv: "/usr/bin",
    candidates: [],
    admin: async () => false,
  });
  assert.deepEqual(canceled, { status: "canceled" });
});

test("installCliLink：内置命令还没生成时报错（开发模式不生成）", async () => {
  const root = tmp();
  await assert.rejects(
    installCliLink({ shimPath: path.join(root, "bin", "vjtools"), pathEnv: "", candidates: [] }),
    /内置命令还没生成/,
  );
});

test("uninstallCliLink：删掉本 app 装的软链（多处都删），npm 装的不碰", async () => {
  const { shimPath, root } = setup();
  const [npmBin, binA, offPath] = ["npm", "a", "off"].map((name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return dir;
  });
  const npmCli = path.join(npmBin, "vjtools");
  fs.writeFileSync(npmCli, "#!/bin/sh\necho npm\n", { mode: 0o755 });
  fs.symlinkSync(shimPath, path.join(binA, "vjtools"));
  // 不在 PATH 上的候选目录（授权装进 /usr/local/bin 但它不在 PATH 上的情形）
  fs.symlinkSync(shimPath, path.join(offPath, "vjtools"));
  const pathEnv = `${binA}:${npmBin}`;
  const admin = () => assert.fail("目录可写时不应请求管理员权限");

  assert.deepEqual(findCliLinks({ shimPath, pathEnv, candidates: [offPath] }).sort(), [
    path.join(binA, "vjtools"),
    path.join(offPath, "vjtools"),
  ]);

  const res = await uninstallCliLink({ shimPath, pathEnv, candidates: [offPath], admin });
  assert.equal(res.status, "removed");
  assert.deepEqual(res.removed.sort(), [path.join(binA, "vjtools"), path.join(offPath, "vjtools")]);
  assert.equal(res.remaining, npmCli, "移除后 PATH 上还剩 npm 装的那个");
  assert.equal(fs.existsSync(path.join(binA, "vjtools")), false);
  assert.equal(fs.readFileSync(npmCli, "utf8"), "#!/bin/sh\necho npm\n");
  assert.equal(fs.existsSync(shimPath), true, "内置命令本身保留");

  assert.deepEqual(await uninstallCliLink({ shimPath, pathEnv, candidates: [offPath], admin }), { status: "none" });
});

test("uninstallCliLink：内置命令被删了（readlink 仍指向它）的软链也认得出来", async () => {
  const { shimPath, root } = setup();
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(shimPath, path.join(bin, "vjtools"));
  fs.symlinkSync(path.join(root, "别的东西"), path.join(bin, "other"));
  fs.unlinkSync(shimPath);

  const res = await uninstallCliLink({ shimPath, pathEnv: bin, candidates: [] });
  assert.deepEqual(res, { status: "removed", removed: [path.join(bin, "vjtools")], remaining: null });
  assert.equal(fs.lstatSync(path.join(bin, "other")).isSymbolicLink(), true);
});

test("uninstallCliLink：目录不可写时走管理员授权；用户取消返回 canceled", async () => {
  const { shimPath, root } = setup();
  const bin = path.join(root, "root owned");
  fs.mkdirSync(bin);
  const link = path.join(bin, "vjtools");
  fs.symlinkSync(shimPath, link);
  fs.chmodSync(bin, 0o555);
  try {
    const commands = [];
    const granted = await uninstallCliLink({
      shimPath,
      pathEnv: bin,
      candidates: [],
      admin: async (command) => {
        commands.push(command);
        return true;
      },
    });
    assert.equal(granted.status, "removed");
    assert.deepEqual(granted.removed, [link]);
    assert.equal(commands[0], `if [ -L '${link}' ]; then rm -f '${link}'; fi`, "授权命令只删软链");

    const canceled = await uninstallCliLink({ shimPath, pathEnv: bin, candidates: [], admin: async () => false });
    assert.deepEqual(canceled, { status: "canceled", removed: [] });
  } finally {
    fs.chmodSync(bin, 0o755);
  }
});
