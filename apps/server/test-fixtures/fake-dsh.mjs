#!/usr/bin/env node
/**
 * test-fixtures/fake-dsh.mjs — dsh 的假可执行文件（仅供开发验证，不进入打包产物）
 *
 * 用途：在没有 DeepSeek API Key（甚至没装 dsh）的环境下验证 DshRuntime 适配层。
 * 事件形状与退出码语义完全照抄实测到的真实 dsh 输出。
 *
 * 通过环境变量 FAKE_DSH_MODE 选择行为；也可在任务文本（stdin）里写 `FAKEMODE:<mode>`
 * 覆盖，便于在**同一次服务运行**中按任务分别触发不同分支。
 *   normal（默认）    正常成功：session → status×4 → text → thinking → tool_call → tool_result → final，退出 0
 *   empty-final       空产出成功：final 文本为空，退出 0
 *   no-final-error    只发 error、不发 final，退出 1
 *   network-error     瞬时错误（429 限流），退出 1  → 应判定为可重试
 *   auth-error        结构性错误（AUTH 401），退出 1 → 应判定为不可重试
 *   fail-once         首次调用失败（会话已建立），之后成功；用 FAKE_DSH_STATE 指定状态文件路径，
 *                     用于验证「重试在同一会话上接续」
 *   interrupt         发 session 后长时间挂起，用于中止/超时验证
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
let mode = process.env.FAKE_DSH_MODE ?? 'normal';

// 回显 --patch 内容与 stdin 任务，供断言 patch 生成与 stdin 传参是否正确
const patchIdx = argv.indexOf('--patch');
const patchPath = patchIdx >= 0 ? argv[patchIdx + 1] : null;
if (patchPath) {
  process.stderr.write(`FAKE_DSH patch=${patchPath}\n`);
  try {
    process.stderr.write(`FAKE_DSH patchContentBegin\n${readFileSync(patchPath, 'utf8')}FAKE_DSH patchContentEnd\n`);
  } catch (e) {
    process.stderr.write(`FAKE_DSH patchReadError=${e.message}\n`);
  }
}
process.stderr.write(`FAKE_DSH argv=${JSON.stringify(argv)}\n`);

let task = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  task += d;
});
process.stdin.on('end', () => {
  // 任务文本里出现 FAKEMODE:<mode> 时覆盖模式，便于单次服务运行覆盖多个分支
  const marker = /FAKEMODE:([a-z-]+)/.exec(task);
  if (marker) mode = marker[1];
  process.stderr.write(`FAKE_DSH mode=${mode}\n`);
  process.stderr.write(`FAKE_DSH dshHome=${process.env.DSH_HOME ?? '<unset>'}\n`);
  process.stderr.write(`FAKE_DSH hasApiKey=${process.env.DEEPSEEK_API_KEY ? 'yes' : 'no'}\n`);
  process.stderr.write(`FAKE_DSH taskBytes=${Buffer.byteLength(task, 'utf8')}\n`);
  // 完整回显任务原文（含换行/引号/中文），供验证 stdin 传输无丢失无损坏
  process.stderr.write(`FAKE_DSH taskBegin\n${task}\nFAKE_DSH taskEnd\n`);
  run(task);
});

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function run() {
  if (mode === 'interrupt') {
    send({ type: 'session', sessionId: 'session-fake-interrupt', cwd: process.cwd() });
    send({ type: 'status', phase: 'turn_start', turn: 1 });
    // 挂起直到被杀掉
    setInterval(() => {}, 1000);
    return;
  }

  send({ type: 'session', sessionId: 'session-fake-1234', cwd: process.cwd() });
  send({ type: 'status', phase: 'turn_start', turn: 1 });
  send({ type: 'status', phase: 'step_start', turn: 1, step: 1 });

  if (mode === 'no-final-error') {
    send({ type: 'error', message: 'FAKE_DSH: runner 级失败' });
    process.stderr.write('dsh: FAKE_DSH: runner 级失败\n');
    // 清理已写入的 patch 文件，模拟真实 dsh 的一次性运行
    process.exit(1);
  }

  // 首次调用失败（此时会话已建立），之后成功；用于验证「重试接续同一会话」
  if (mode === 'fail-once') {
    const stateFile = process.env.FAKE_DSH_STATE ?? '/tmp/fake-dsh-state';
    if (!existsSync(stateFile)) {
      writeFileSync(stateFile, 'failed');
      process.stderr.write('FAKE_DSH fail-once: first attempt fails\n');
      send({ type: 'error', message: 'FAKE_DSH: 首次尝试失败' });
      process.exit(1);
    }
    process.stderr.write('FAKE_DSH fail-once: resumed attempt succeeds\n');
  }

  if (mode === 'network-error') {
    send({
      type: 'status',
      phase: 'turn_end',
      turn: 1,
      reason: { kind: 'error', error: { message: 'upstream overloaded (503)', code: 'RATE_LIMIT', status: 429 } },
    });
    send({ type: 'final', text: '' });
    process.exit(1);
  }

  if (mode === 'auth-error') {
    send({
      type: 'status',
      phase: 'turn_end',
      turn: 1,
      reason: { kind: 'error', error: { message: 'Authentication Fails (401)', code: 'AUTH', status: 401 } },
    });
    send({ type: 'final', text: '' });
    process.exit(1);
  }

  if (mode === 'empty-final') {
    send({ type: 'status', phase: 'step_end', turn: 1, step: 1 });
    send({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
    send({ type: 'final', text: '' });
    process.exit(0);
  }

  // normal
  send({ type: 'thinking', text: '让我先看看当前任务。' });
  send({ type: 'text', text: '我先列出我的任务。' });
  send({ type: 'tool_call', name: 'mcp__openpms__task_list_my', callId: 'call_fake_1', input: { status: 'pending' } });
  send({ type: 'tool_result', name: 'mcp__openpms__task_list_my', callId: 'call_fake_1', output: '{"ok":true}', isError: false });
  send({ type: 'text', text: '任务已确认，处理完毕。' });
  send({ type: 'status', phase: 'step_end', turn: 1, step: 1 });
  send({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  send({ type: 'final', text: '任务已确认，处理完毕。\n\n## 记忆沉淀\n- dsh 档位的产出来自 final 事件\n- patch 必须写全被替换行的所有键' });
  process.exit(0);
}