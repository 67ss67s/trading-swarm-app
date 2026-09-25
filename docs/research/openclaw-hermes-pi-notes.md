# OpenClaw / Hermes / pi — 可借用的机制(2026-09-02 调研)

## OpenClaw(TypeScript;agent 内核 = pi 的 createAgentSession)
- **Gateway** 单长驻进程,WS 控制面 18789,JSON-RPC 风格:`{type:"req",id,method,params}` / `{type:"res",id,ok,payload|error}` / `{type:"event",event,payload,seq,stateVersion}`;connect 握手带 role(operator|node)、scopes(operator.read/write/admin)、auth(token|password|tailscale|trusted-proxy)、device 签名身份 → **设备配对**(回环自动批)。
- 方法族:`chat.send/history/abort/inject`、`sessions.list/create/patch/send/dispatch`、`agents.*`、`config.get/set/patch/schema`、`cron.list/add/remove/run`、`wake`、`tasks.*`、`approval.get/resolve`、`exec.approval.request`、`tools.catalog/effective/invoke`、`audit.run.inspect`、`logs.tail`、`status/health/models.list`、`wizard.start/next/cancel/status`。事件:`agent`(runId+delta+toolCalls)、`chat.*`、`session.message/tool`、`presence`、`health`、`heartbeat`、`tick`(15s keepalive)、`config.changed`、`*.approval.*`。副作用方法要 `idempotencyKey`。
- **Control UI**:Vite+Lit SPA 由 gateway 同端口托管;面板:Chat/Sessions、Config 编辑器(JSON5+schema 表单)、Model Providers、Secrets、MCP servers、Automations(cron+运行史)、Tasks、Devices、Exec approvals、Plugins/Skills、Activity(run inspector)、Logs、Debug(RPC tester)、Usage(token/账单)、Operator terminal、Side chat。
- **Onboarding**(11 步经典流):模式选择 → 风险确认(`wizard.securityAcknowledgedAt`)→ workspace(种 bootstrap 文件)→ 模型+鉴权(**必须跑一次真实 completion**)→ gateway(port/bind/auth/tailscale)→ 渠道 → 搜索 → skills → daemon(launchd/systemd)→ health → 完成;`--flow quickstart` 复用已检测到的 AI 访问;重跑不清配置除非 `--reset`;非交互要 `--accept-risk`;secret 可用 SecretRef(env 引用)。
- **Workspace bootstrap 文件**:AGENTS.md(操作规则)、SOUL.md(语气)、USER.md、TOOLS.md、MEMORY.md、IDENTITY.md、HEARTBEAT.md、BOOTSTRAP.md,会话开始注入。
- **Heartbeat**:系统持有的 cron 作业,默认 30m,`target: owner|last|<channel>|none`,`isolatedSession`(~100K→2-5K token)、`lightContext`、`activeHours`、`model` 覆盖;回复 `NO_REPLY` 静默;`heartbeat_respond{notify, notificationText, scratch}`;事件驱动唤醒 `openclaw system event --text ... --mode now`;monitor scratch 是私有清单(≤256KiB)。
- 配置 `~/.openclaw/openclaw.json`,agent 状态 `~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite`。

## Hermes(Python;一个 AIAgent 类服务 CLI/gateway/cron/ACP/API)
- **runtime resolver**:`(provider, model) → (api_mode, api_key, base_url)`,三种 api_mode:chat_completions / codex_responses / anthropic_messages;所有入口共用。
- **cron**:gateway 每 60s tick,每个到期作业开**全新隔离会话**;`~/.hermes/cron/jobs.json`;作业字段:schedule(in 30m / every 2h / cron 表达式 / ISO)、prompt、deliver(origin/local/telegram:id/all)、skills[](先注入)、continuity(注入自己上次输出)、context_from(其他作业输出当上下文)、no_agent+script(纯脚本零 token,空 stdout=静默)、enabled_toolsets、reasoning_effort、model pin;**model_drift_guard**(全局模型变了未钉住的作业 fail-closed);预派发校验(key/skill/deliver)不通过 → `blocked_config` 不调模型;`failure_streak` + incidents(detected→alerted→closed);cron 会话内禁止再建 cron;`.tick.lock` 防重叠。
- **skills**:`~/.hermes/skills/<cat>/<name>/SKILL.md`(frontmatter name/description/version/platforms/metadata.hermes.requires_toolsets…)+ references/ scripts/ templates/;渐进披露三层:`skills_list`(索引 ~3k tok 进 system prompt)→ `skill_view`(整文)→ `skill_view(path)`(引用文件);**自创技能**:复杂任务/纠错后 system prompt 提示用 `skill_manage(create|patch|edit|delete|write_file)` 记录;`skills.write_approval` 开时写入先进 `~/.hermes/pending/skills/`,`/skills diff|approve`;安装扫描注入/外泄/破坏命令。memory(小而常驻的事实)与 skills(长而按需的流程)分开。
- prompt 分层 stable → context → volatile(身份/工具指导/skills 索引 → 上下文文件 → memory/profile/时间戳),配 Anthropic 缓存断点。会话 SQLite+FTS5 可搜。

## pi(TypeScript;见 pi-agent-internals.md 工作线报告)
- 四种模式:interactive / print(`-p`)/ RPC(子进程 JSON 协议)/ SDK(`createAgentSession`)。默认四工具 read/write/edit/bash,可整体替换。
- 借用点:agent loop 的 toolCall/toolResult 配对不变量、steer/followUp 队列、会话树+分支+compaction、extensions 钩子(tool_call before/after)、provider 抽象(pi-ai:OpenAI-compat/Anthropic/…,usage 计费)。
