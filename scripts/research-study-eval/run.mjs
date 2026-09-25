#!/usr/bin/env node
// 仓库根离线入口；实现随 gateway 包维护。缺省 network deny。
await import('../../packages/gateway/scripts/research-study-eval/run.mjs');
