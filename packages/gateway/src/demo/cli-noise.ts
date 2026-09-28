// 外部 Node CLI(okx-trade-cli、onchainos)在正常输出之外夹带的提示:版本更新提醒、Node 实验特性警告。
// 18811 实测:okx CLI 的 "Update available ... Run: npm install -g" 让入场单查询每天 1200+ 次被当成失败(reconcile warn),
// "[UNDICI-EHPA] EnvHttpProxyAgent is experimental" 让成交读取报错。解析前先剥掉,子进程也尽量不产生。

const NOISE_LINE = [
  /^Update available for \S+/i,
  /^Run:\s*npm (?:install|i) -g /i,
  /^npm (?:notice|warn)\b/i,
  /^\(node:\d+\) \[?[A-Z_-]*\]? ?Warning:/,
  /^\(node:\d+\) (?:Experimental|Deprecation)Warning:/,
  /^\(Use `node --trace-warnings/,
  /^[│╭╰─┌└┐┘\s]*$/, // update-notifier 的框线
];

export function stripCliNoise(text: string): string {
  if (!text) return text;
  const lines = text.split('\n');
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true;
    return !NOISE_LINE.some((re) => re.test(t.replace(/^[│|]\s*/, '').replace(/\s*[│|]$/, '')));
  });
  return kept.join('\n').trim();
}

/** 子进程环境:关掉更新提醒与 Node 警告输出。 */
export function quietCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, NO_UPDATE_NOTIFIER: '1', NPM_CONFIG_UPDATE_NOTIFIER: 'false', NODE_NO_WARNINGS: '1' };
}
