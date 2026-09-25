# pi coding agent — harness 内核调研(2026-09-02,工作线报告整理)

版本 `@earendil-works/pi-coding-agent@0.84.2`,路径 `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent`;兄弟包 vendored 在其 `node_modules/@earendil-works/{pi-agent-core,pi-ai,pi-protocol,pi-client,pi-tui,pi-telemetry}`。

三层:
1. **pi-ai** — provider/model 抽象 + 流式协议,无 agent 逻辑。
2. **pi-agent-core** — agent loop(`agentLoop`)+ 有状态 `Agent`;另有较新的 `AgentHarness`(durable/lane,本版大多 stub)。
3. **pi-coding-agent** — `AgentSession`(重试、compaction、会话树)、编码工具、extensions、四种运行模式(TUI / print / json / rpc)。

对交易 agent:1+2 直接复用;3 只抄模式(session/compaction/RPC)。

## 1. Agent loop(pi-agent-core/dist/agent-loop.js)
- 入口 `agentLoop(prompts, context, config, signal, streamFn)` → `EventStream<AgentEvent, AgentMessage[]>`;`runAgentLoop(..., emit, ...)` 回调形式。
- 结构:外层 while(follow-up 排水点)套内层 while(`hasMoreToolCalls || pendingMessages.length>0`):turn_start → 注入 steering/follow-up → `streamAssistantResponse()` → error/aborted 即 turn_end+agent_end → 执行工具调用 → turn_end{message,toolResults} → `prepareNextTurn()`(可换上下文/模型/thinking)→ `shouldStopAfterTurn()` → 取 steering;内层退出后取 follow-up,非空则继续外层。
- 一个 **turn** = 一次 LLM 响应 + 它请求的所有工具调用 + 结果。
- `streamAssistantResponse()` 是 AgentMessage→provider Message 的唯一转换点:`transformContext`(裁剪/注入)→ `convertToLlm`(必须过滤 UI 消息,不得抛)→ `getApiKey(provider)` 每次调用解析(应对 OAuth token 过期)→ `streamFn`。partial assistant message 在 `start` 时推入 `context.messages`,每个 delta 原地替换。
- **没有 maxTurns/step 预算**(全文 grep 零命中)。终止条件只有:stopReason error|aborted;无工具调用且无 steering/follow-up;`shouldStopAfterTurn` 返回 true;或整批工具结果都 `terminate:true`(一致才停,用于"最终答案"工具)。**交易 agent 必须自己在 `shouldStopAfterTurn` 里加轮数上限。**
- Abort:`Agent.abort()`;signal 贯穿 streamFn/beforeToolCall/execute/afterToolCall;provider 把 abort 编码成 `stopReason:"aborted"` 的最终消息而不是抛错(StreamFn 合同:不得抛)。
- **steer / followUp** 两个 `PendingMessageQueue`,模式 `"all"` | `"one-at-a-time"`(默认后者)。steering 在每个 turn_end 后取(不打断进行中的工具);follow-up 只在 agent 本要停时取,重新进入内层循环。API:`steer/followUp/clearSteeringQueue/clearFollowUpQueue/hasQueuedMessages`。
- 事件:`agent_start / agent_end{messages} / turn_start / turn_end{message,toolResults} / message_start|update|end / tool_execution_start{toolCallId,toolName,args} |update{partialResult} |end{result,isError}`。AgentSession 再加 `agent_settled`(真正空闲信号)、`queue_update`、`compaction_start/end`、`auto_retry_start/end`。
- **toolCall/toolResult 配对是结构性保证**:每个调用恰好一个 ToolResultMessage——未知工具/schema 失败/beforeToolCall 拦截/execute 抛错/abort 全部变成 error result;`stopReason==="length"` 时整批工具**不执行**(截断参数可能"看起来合法"),每个给 error result 让模型重发;parallel 模式顺序 prepare、并发执行,结果按 assistant 源顺序落 transcript;任一工具声明 `executionMode:"sequential"` 则整批串行。
- loop 钩子(`AgentLoopConfig`):`convertToLlm`(必填)、`transformContext`、`getApiKey`、`shouldStopAfterTurn`、`prepareNextTurn`、`getSteeringMessages`、`getFollowUpMessages`、`beforeToolCall`、`afterToolCall`、`toolExecution`(默认 parallel)。全部"不得抛,返回安全回退"。

## 2. 工具定义
```ts
interface AgentTool<P extends TSchema, D> extends Tool<P> {
  label: string; prepareArguments?: (args: unknown) => Static<P>;
  execute: (toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult<D>>;
  executionMode?: "sequential" | "parallel";
}
interface AgentToolResult<T> { content: (TextContent|ImageContent)[]; details: T; usage?: Usage; addedToolNames?: string[]; terminate?: boolean; }
```
- schema 用 **TypeBox**(字符串枚举用 pi-ai 的 `StringEnum`,Type.Union/Literal 在 Google API 上会坏)。
- `content` 给模型;`details` 结构化数据落 transcript 给 UI/日志,**不进模型**——交易场景:content=摘要,details=原始订单/成交对象。
- 报错靠 throw;返回值永不置 isError。
- 截断纪律(`harness/utils/truncate`):`DEFAULT_MAX_LINES=2000`、`DEFAULT_MAX_BYTES=50KB`,`truncateHead/truncateTail/truncateLine(500)`,永不返回半行,告诉模型截断了、全量在哪。
- coding 层 `ToolDefinition` 再加 `promptSnippet`(system prompt 里一行)、`promptGuidelines`、渲染器;`defineTool()` 只为保留类型推断。

## 3. pi-ai provider 抽象
- `Models.stream/complete/streamSimple/completeSimple`,`streamSimple` 直接满足 loop 的 `StreamFn`。`Context={systemPrompt?, messages, tools?}`。事件 `start → text_*|thinking_*|toolcall_* → done|error`,每个事件带累计 `partial`。
- 注册:`createProvider({id,name?,baseUrl?,headers?,auth,models,fetchModels?,api})` + `models.setProvider`;或 `models.json`;或扩展 `pi.registerProvider(name,{name,baseUrl,apiKey:"$ENV",api,models[]})`。OpenAI-compatible 端点约 6 行。
- `Api` 含 `openai-completions | openai-responses | openai-codex-responses | anthropic-messages | google-generative-ai | bedrock-converse-stream | ...`,~37 内置 provider(含 DeepSeek、z.ai 等)。
- `Model{id,api,provider,baseUrl,reasoning,thinkingLevelMap,contextWindow,maxTokens,cost:ModelCost(分层定价),samplingParams,headers}`;`calculateCost(model,usage)`。
- `Usage{input,output,cacheRead,cacheWrite,cacheWrite1h?,reasoning?,totalTokens,cost{...}}` 挂在每条 AssistantMessage;工具内嵌套 LLM 用量经 `AgentToolResult.usage` 上报。
- 缓存:`cacheRetention:"none"|"short"|"long"`,`sessionId` 做会话亲和;compaction 请求用新 sessionId 且关缓存写。
- thinking:`ThinkingLevel minimal..max`,`thinkingBudgets`,`clampThinkingLevel`;`samplingParams` 原样透传(OpenAI-compat 适配器)——**GLM 关 thinking 就走这里**;`transport: sse|websocket|auto`;`deferred` 批处理。

## 4. 会话持久化
- JSONL 树(v2 `id/parentId`),路径 `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`;条目 `message | model_change | thinking_level_change | active_tools_change | compaction | branch_summary | custom`;另有操作记录 `operation_started(intent) / abort_requested / operation_finished / step_attempt` 使运行可崩溃恢复(`SuspendedOperation{reason:"crash"|"deferred", missing:{tools,models}}`)。
- Compaction:触发 `contextTokens > contextWindow - reserveTokens(16384)`;倒序累计到 `keepRecentTokens(20k)` 找切点 → LLM 摘要(带上次摘要迭代)→ 追加 `CompactionEntry{summary,firstKeptEntryId,tokensBefore}`;**切点绝不落在 tool result**;超大 turn 拆两段摘要合并;`CompactionSettings{enabled,reserveTokens,keepRecentTokens}`。
- `SessionManager.continueRecent/open/create/inMemory/list`,树 API `branch/branchWithSummary/getTree/getPath`。会话替换后 `runtime.session` 是新对象,订阅要重挂。

## 5. SDK 嵌入(docs/sdk.md,examples/sdk/01-13)
```ts
const { session } = await createAgentSession({
  modelRuntime: await ModelRuntime.create(),
  resourceLoader: loader,               // DefaultResourceLoader({systemPromptOverride}) 或自写 ResourceLoader 全空
  sessionManager: SessionManager.inMemory(),
  noTools: "all",                       // "all" | "builtin";或 tools:[allowlist](自定义工具也要列)、excludeTools:[]
  customTools: [priceTool], tools: ["get_price"],
});
session.subscribe(e => ...); await session.prompt("..."); session.dispose();
```
- 全封闭方案见 `examples/sdk/12-full-control.ts`:自写 ResourceLoader(extensions/skills/prompts 全空)+ `SettingsManager.inMemory({compaction,retry})` + `ModelRuntime.create({authPath,modelsPath})`。
- `AgentSession`:`prompt(text,{streamingBehavior:"steer"|"followUp", preflightResult})`(流中调用不带 streamingBehavior 会抛)、`steer/followUp/subscribe/setModel/setThinkingLevel/compact/abort/navigateTree/dispose`、`agent/messages/isStreaming/sessionId`。
- 运行模式:`runPrintMode`、`--mode json`(JSONL 事件流)、`runRpcMode`、`InteractiveMode`,都吃 `AgentSessionRuntime`。
- 导出:`createAgentSession/createAgentSessionRuntime/createAgentSessionServices`、`ModelRuntime/ModelRegistry/DefaultResourceLoader/SessionManager/SettingsManager/defineTool/createReadOnlyTools/truncate*`。

## 6. RPC 模式(docs/rpc.md)
- `pi --mode rpc [--provider] [--model] [--no-session] [--session-dir]`;严格 JSONL(LF),**别用 Node readline**(会按 U+2028/2029 切)。
- 命令:`prompt(+images,+streamingBehavior) / steer / follow_up / abort / new_session / get_state / get_messages / set_model / cycle_model / get_available_models / set_thinking_level / set_steering_mode / set_follow_up_mode / compact / set_auto_compaction / set_auto_retry / bash / abort_bash / get_session_stats / export_html / switch_session / fork / clone / get_entries / get_tree / get_last_assistant_text / set_session_name / get_commands`;`prompt` 的 success=**接受**不是完成。
- 事件 = AgentEvent 超集 + `agent_settled`(真正空闲)、`queue_update`、`compaction_*`、`auto_retry_*`、`extension_error`;`extension_ui_request/response` 复用同通道(headless 可自动拒绝)。
- 现成子进程驱动 `RpcClient({cliPath,cwd,env,provider,model,args})`(`dist/modes/rpc/rpc-client.d.ts`)。

## 7. Extensions(docs/extensions.md)
- 模块导出 `default (pi: ExtensionAPI) => void`,jiti 加载 TS;33 个事件:project_trust / resources_discover / session_* / before_agent_start / agent_start|end|settled / turn_start|end / context / message_* / before_provider_headers|request / after_provider_response / model_select / tool_execution_start / **tool_call**(可原地改 input、`{block:true,reason}` 拦截,改后不再校验)/ tool_result(可改 content/details/isError,字段级替换)/ tool_execution_end / input / user_bash。
- `before_agent_start` 可注入消息、重写 system prompt(`systemPromptOptions{customPrompt,selectedTools,toolSnippets,promptGuidelines,appendSystemPrompt,contextFiles,skills}`)。
- `pi.registerTool` 运行时可注册立即可用;`setActiveTools`;`registerCommand`(扩展命令绕过队列,流中立即执行);`registerProvider`;`events` 跨扩展总线。
- Skills = Agent Skills 标准(SKILL.md frontmatter),启动只把 name+description 放进 system prompt,模型用 `read` 按需读全文;`/skill:name` 强制加载;位置 `~/.pi/agent/skills`、`~/.agents/skills`、项目 `.pi/skills`、`--skill`;可指向 `~/.claude/skills`。**noTools:"all" 会失去渐进披露,需自供 reader。**

## 8. Heartbeat / cron / 后台任务
- **完全没有**(grep 零命中)。pi 纯响应式,只从 prompt/steer/followUp/RPC prompt 起跑。
- 集成点:外部调度器调 `session.prompt`(配 `waitForIdle()`)或直接 `followUp()` 当工作队列(默认 one-at-a-time,tick 不会合并);`prepareNextTurn` 换新鲜行情上下文;`shouldStopAfterTurn` 加轮数上限;RPC 子进程模式以 `agent_settled` 为空闲信号。

## 复用建议
整体拿 `pi-agent-core` 的 agentLoop/Agent + `pi-ai` 的 Models/Provider(领域无关;配对不变量正是下单需要的;details/content 对应原始成交/模型摘要);`noTools:"all"` 丢掉编码工具;抄 compaction 切点规则、JSONL 树会话、`agent_settled`、截断纪律;自加轮数上限与调度器。
