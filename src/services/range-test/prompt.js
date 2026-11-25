// 发给 T3 线程的文字：首条消息、确认点的回复。纯函数，规则都留给 skill，这里只把界面上的
// 选择说清楚。

// 每条消息都带上：界面只能用 `t3 thread send` 回话，答不了提问工具（实测过，会一直卡在等回答）
const NO_QUESTION_TOOL =
  "这次由 vjtools 改动测试台驱动：需要问使用者时，用普通文字写出问题后结束本轮，不要用提问工具（界面答不了提问工具）。";

// 逐格回填：M0b 实测 agent 把 22 格攒到最后一刻才一起写，界面上 27 分钟进度都是 0。测一格写一格，界面才看得到进度
const BACKFILL_RULE = "每测完一格就马上回填清单的结果格和 log 的证据，不要攒到最后一起写：界面靠这两个文件显示进度。";

// 截图约定：放进产物目录，界面的证据面板只读得到这里的文件
const EVIDENCE_RULE =
  "截图存到产物目录的 evidence/ 下（文件名带编号和站，如 evidence/A1-视频.png），在 log 里用相对路径引用：![](evidence/A1-视频.png)。";

export function buildStartMessage({ repoPath, base, tip, count, topic, dir }) {
  return [
    "用 commit-range-test 测这段改动。",
    `- 仓库：${repoPath}`,
    `- 范围：${base}..${tip}（${count} 个提交，使用者已在界面上选定，不用再问范围）`,
    `- 主题：${topic}；产物目录：${dir}（三个产物照 skill 的命名放在这里；目录里的 .vjtools-run.json 是界面的记录，不用管）`,
    `- ${NO_QUESTION_TOOL}`,
    "- 做到确认点就停，等界面回复。",
    "",
  ].join("\n");
}

const clean = (s) => String(s ?? "").trim();

/**
 * 确认点的回复。reply：
 *   confirm      true = 确认开测；false = 只按调整改清单，改完停在确认点
 *   removals     [{ id, reason }]   删掉的行
 *   edits        [{ id, expected }] 改预期
 *   questions    [{ id, text }]     对某一行的疑问
 *   groups       只测这些模块（清单里的「## 」小节标题）；null 或全选 = 不限
 *   sites        只测这些站；null 或全选 = 不限
 *   note         补充说明
 */
export function buildReplyMessage(reply) {
  const removals = (reply.removals || []).filter((r) => clean(r.id));
  const edits = (reply.edits || []).filter((r) => clean(r.id) && clean(r.expected));
  const questions = (reply.questions || []).filter((r) => clean(r.id) && clean(r.text));
  const groups = reply.groups?.length ? reply.groups : null;
  const sites = reply.sites?.length ? reply.sites : null;
  const note = clean(reply.note);

  const adjust = [];
  for (const r of removals) adjust.push(`- 删 ${clean(r.id)}：${clean(r.reason) || "使用者定不测"}`);
  for (const r of edits) adjust.push(`- ${clean(r.id)} 预期改为：${clean(r.expected)}`);
  if (groups) adjust.push(`- 只测这些模块：${groups.join("、")}（其余模块的格保持 ⬜，记为使用者定的）`);
  if (sites) adjust.push(`- 只测这些站：${sites.join("、")}（其余站的格保持 ⬜，记为使用者定的）`);

  const lines = [];
  if (reply.confirm) {
    lines.push(adjust.length || questions.length ? "确认开测，先按下面的调整改清单。" : "确认开测，清单不用调整。");
  } else {
    lines.push("先不开测。按下面的调整改清单和对照表，重跑 check，改完停在确认点等界面回复。");
  }
  if (adjust.length) lines.push("调整：", ...adjust);
  if (questions.length) {
    lines.push("疑问（先回答，再按回答改清单）：");
    for (const q of questions) lines.push(`- ${clean(q.id)}：${clean(q.text)}`);
  }
  if (note) lines.push(`补充：${note}`);
  if (reply.confirm) {
    lines.push(BACKFILL_RULE, EVIDENCE_RULE, "产物目录里的 .vjtools-confirmed-checklist.md 是界面拍的确认快照，不用管，也不要改。");
  }
  lines.push(NO_QUESTION_TOOL, "");
  return lines.join("\n");
}

/** 回复里有没有实际内容：不确认、又什么都没改时不该发 */
export function isEmptyReply(reply) {
  if (reply.confirm) return false;
  const text = buildReplyMessage(reply);
  return !/^(调整：|疑问|补充：)/m.test(text);
}

/**
 * 确认开测之后、线程一轮结束时的后续消息：
 *   continue       还有本地能测的 ⬜ 格，接着测
 *   fix-evidence   status 报了证据问题，逐条处理；problems 是 status 的原文
 *   check-offline  核对标了【测试服】【真机】【线上】的行，只做只读访问
 *   regress        修完 bug 做第 9 步回归；commits 是使用者勾选的修复提交 [{ sha, subject }]
 */
export function buildFollowUpMessage(kind, { problems = [], commits = [] } = {}) {
  const lines = [];
  if (kind === "continue") {
    lines.push(
      "接着测：从清单里还是 ⬜ 的格做起（第 7 步）。标了【测试服】【真机】【线上】的行本地测不了，不用管。测完照第 8 步收尾、报告。",
    );
  } else if (kind === "fix-evidence") {
    lines.push("`status --log --map` 报了下面这些证据问题，逐条处理：缺证据的补上，没写测试提交的补上，过期的退回 ⬜ 重测。");
    for (const p of problems) lines.push(`- ${p}`);
    lines.push("处理完再跑一遍带 --log --map 的 status，没有问题后照第 8 步只报告变化。");
  } else if (kind === "check-offline") {
    lines.push(
      "核对清单里标了【测试服】【真机】【线上】、还是 ⬜ 的格：能用只读方式核对的就核对（只做 GET 访问、看页面、读响应头），不下单、不付款、不登录真实账号、不改任何数据；核对不了的保持 ⬜，在报告「没测到」里写明还需要什么（哪个环境、什么账号、谁来测）。",
      "线上环境还没发布这次改动的，照实写「未发布，暂不能核对」，不要按旧版本判不通过。",
    );
  } else if (kind === "regress") {
    if (!commits.length) throw new Error("回归要带上修复提交");
    lines.push("修完了，做第 9 步回归。修复提交（使用者在界面上勾选的）：");
    for (const c of commits) lines.push(`- ${String(c.sha).slice(0, 10)} ${c.subject || ""}`.trimEnd());
    lines.push(
      "读这些提交的 diff，按对照表找到受影响的清单行退回 ⬜、旧证据标作废，修复新增的分支补 EXT 行；再重测受影响的行和原来标 ❌ 的行，log 先写新的「测试提交」，正文第一行写「回归」。最后跑 check 和 status，报告只写变化。",
    );
  } else {
    throw new Error(`未知的后续操作：${kind}`);
  }
  lines.push(BACKFILL_RULE, EVIDENCE_RULE, NO_QUESTION_TOOL, "");
  return lines.join("\n");
}

/**
 * 换新线程续接：旧线程失败、找不到、或者上下文太长时，新起一个线程从产物文件接着做。
 * skill 自己支持中断续测（看清单头「阶段」：待确认回确认点，已确认从 ⬜ 的格做起），这里只把位置交代清楚
 */
export function buildResumeMessage({ repoPath, base, tip, count, topic, dir }) {
  return [
    "用 commit-range-test 接着测这段改动（中断后续测，上一个线程已经不用了）。",
    `- 仓库：${repoPath}`,
    `- 范围：${base}..${tip}（${count} 个提交）`,
    `- 主题：${topic}；产物目录：${dir}，三个产物已经在里面（.vjtools-run.json 和 .vjtools-confirmed-checklist.md 是界面的记录，不用管）`,
    `- ${BACKFILL_RULE}`,
    "- 照 SKILL.md 中断续测的规矩：先看清单头的「阶段」。还是「待确认」就回到确认点，把清单交给界面；已经是「已确认」就不重做第 1～5 步，读 references/phase2-testing.md，先跑一遍带 --log --map 的 status，有证据问题先处理，再从还是 ⬜ 的格接着测，最后照第 8 步报告。",
    `- ${EVIDENCE_RULE}`,
    `- ${NO_QUESTION_TOOL}`,
    "",
  ].join("\n");
}
