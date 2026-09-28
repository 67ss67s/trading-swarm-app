// 硬闸:TG_NO_REAL_MODELS=1(浸泡验证实例自动打开)时,任何真实模型调用 —— CLI 子进程、HTTP 大脑、Jev 决策 —— 在出站前直接失败。
// 角色绑定存在库里(可能绑着 pi/OpenRouter),只改 workflow.brain=stub 挡不住,所以闸门放在最底层的出站点。
export function assertRealModelsAllowed(what: string): void {
  if (process.env['TG_NO_REAL_MODELS'] === '1') throw new Error(`real_models_disabled: TG_NO_REAL_MODELS=1,拒绝真实模型调用(${what})`);
}
