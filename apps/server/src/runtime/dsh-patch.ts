/**
 * runtime/dsh-patch.ts — 生成 dsh 的 --patch 覆盖层（YAML）
 *
 * dsh 的 patch 语义是**替换目标行的完整 config**（不是深合并），因此每个被覆盖的行
 * 都必须写全所有需要保留的键，否则未写的键会退回 schema 默认值（甚至丢失 profile 的显式设置）。
 *
 * 两处已验证的关键事实（实测 dsh 0.1.7-rc.2 得出）：
 *   1. system-prompt 行的 headless 默认显式设了 personaPrefix 与 personaSuffix 两个键，
 *      其中 personaSuffix 是 dsh 侧唯一提示工作目录的机制，替换时必须原样保留；
 *      toolOrder 无默认值且写错会导致加载失败，必须不写。
 *   2. agent-default-model 行的显式配置是 provider + model 两个键，替换时必须都写。
 *
 * 文本值一律用双引号 + JSON 风格转义输出：比 YAML 块标量更稳，
 * 因为我们注入的 System Prompt 含 Markdown 代码块（缩进内容），块标量的缩进探测容易出错。
 */

export interface DshMcpConfig {
  /** 我们的 MCP 工具服务脚本路径 */
  mcpServerPath: string;
  /** 运行该脚本的 Node 可执行文件 */
  nodeBin: string;
  /** OpenPMS API 基址（非敏感，直接内联） */
  apiUrl: string;
  /** 任务 id（非敏感，直接内联） */
  taskId: string;
  /** 智能体 id（非敏感，直接内联） */
  agentId: string;
}

export interface DshPatchOptions {
  /** assembleSystemPrompt 的产物（智能体人设 + 经验记忆） */
  systemPrompt: string;
  /** 解析后的模型；null 表示不打模型行，回退 dsh 默认 */
  model: string | null;
  /** null 表示不打 MCP 行 */
  mcp: DshMcpConfig | null;
}

/** dsh-base 里 agent-default-model 的 provider，替换 config 时必须保留 */
const DSH_MODEL_PROVIDER = 'deepseek-official';

/** headless profile 原本下发的工作目录提示，替换 system-prompt 行时必须保留 */
const DSH_PERSONA_SUFFIX = 'Your working directory is {{cwd}}.';

/** headless profile 原本下发的模型自述，追加到我们的人设之后以免信息丢失 */
const DSH_MODEL_SELF_DESCRIPTION = 'You are a coding agent powered by the {{model}} model.';

/**
 * 输出一个双引号 YAML 标量。
 * 转义反斜杠、双引号与控制字符；非 ASCII（中文）保持字面量（文件按 UTF-8 写入）。
 */
export function yamlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** 规范化换行，避免 CRLF 混入注入内容 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * 生成 patch YAML 文本。
 *
 * 注意：这里**不写入任何密钥或令牌** —— MCP 行的敏感环境变量一律写成
 * `!!js process.env.XXX` 引用（真值由 spawn 环境注入），因此本文件内容可以安全
 * 落进执行日志，也可以在执行结束后直接删除而不丢失审计线索。
 */
export function buildDshPatchYaml(o: DshPatchOptions): string {
  const blocks: string[] = [
    '# OpenPMS 生成的 dsh 覆盖层（每次执行一份，执行结束后删除）',
    '# 语义：patch 会替换目标行的完整 config，故每个被覆盖的行都写全需要保留的键。',
  ];

  if (o.model !== null && o.model !== '') {
    blocks.push(
      '',
      '- id: agent-default-model',
      '  config:',
      `    provider: ${yamlString(DSH_MODEL_PROVIDER)}`,
      `    model: ${yamlString(o.model)}`,
    );
  }

  const personaPrefix = [
    normalizeNewlines(o.systemPrompt).replace(/\n+$/, ''),
    DSH_MODEL_SELF_DESCRIPTION,
  ].join('\n\n');

  blocks.push(
    '',
    '- id: system-prompt',
    '  config:',
    '    includeHarnessIdentity: true',
    '    includeRuntimeContext: true',
    `    personaPrefix: ${yamlString(personaPrefix)}`,
    `    personaSuffix: ${yamlString(DSH_PERSONA_SUFFIX)}`,
  );

  if (o.mcp) {
    blocks.push(
      '',
      '- insert:',
      '    - id: mcp-openpms',
      `      name: ${yamlString('@deepseek-ai/dsh-mcp-client')}`,
      '      config:',
      `        serverName: ${yamlString('openpms')}`,
      `        transport: ${yamlString('stdio')}`,
      `        command: ${yamlString(o.mcp.nodeBin)}`,
      '        args:',
      `          - ${yamlString(o.mcp.mcpServerPath)}`,
      '        env:',
      `          OPENPMS_API_URL: ${yamlString(o.mcp.apiUrl)}`,
      `          OPENPMS_TASK_ID: ${yamlString(o.mcp.taskId)}`,
      `          OPENPMS_AGENT_ID: ${yamlString(o.mcp.agentId)}`,
      // 与执行令牌同值，属敏感信息：只引用环境变量，不写进文件
      '          OPENPMS_EXECUTION_ID: !!js process.env.OPENPMS_EXECUTION_ID',
      '          OPENPMS_TOOL_TOKEN: !!js process.env.OPENPMS_TOOL_TOKEN',
      '        toolCallTimeoutMs: 60000',
      // MCP 连接失败不阻断执行（与 opencode 侧行为一致），失败原因会在 dsh 的 stderr 中出现
      '        failOnStartupError: false',
    );
  }

  return `${blocks.join('\n')}\n`;
}