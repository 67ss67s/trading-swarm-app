/**
 * 手动单独起引擎(调试用):`npm start -w @trade-gate/pine-engine`。
 * 平时不用它——网关启动时自己托管拉起(packages/gateway/src/demo/research/pine/engine-host.ts)。
 * 这里按与托管器相同的规则拼权限参数:只读本包 + 依赖(pinets 及其传递依赖)的真实目录,其余全拒。
 * 端口默认 0(系统分配),就绪后 stdout 打一行 {"event":"ready","port":…}。
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const here = fs.realpathSync(__dirname);
const readable = new Set([here]);
const seen = new Set();
function walk(name, from) {
    if (seen.has(name)) return;
    seen.add(name);
    let dir;
    try { dir = fs.realpathSync(path.dirname(require.resolve(`${name}/package.json`, { paths: [from] }))); } catch {
        // exports 不导出 package.json 的包:从入口往上找
        try {
            let at = path.dirname(require.resolve(name, { paths: [from] }));
            while (!fs.existsSync(path.join(at, 'package.json'))) at = path.dirname(at);
            dir = fs.realpathSync(at);
        } catch { return; }
    }
    readable.add(dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies || {})) walk(dep, dir);
}
for (const dep of Object.keys(require('./package.json').dependencies || {})) walk(dep, here);
// 依赖解析会沿祖先目录试 <祖先>/node_modules/<dep>;只要那个 node_modules 存在,不放行就是 ERR_ACCESS_DENIED(见 gateway engine-host.ts 同名注释)
for (let at = here; ; at = path.dirname(at)) { for (const dep of seen) readable.add(path.join(at, 'node_modules', dep, 'package.json')); if (path.dirname(at) === at) break; }

const args = ['--permission', ...[...readable].map((d) => `--allow-fs-read=${d}`), path.join(here, 'server.js')];
const child = spawn(process.execPath, args, { stdio: 'inherit', env: { PINE_ENGINE_PORT: process.env.PINE_ENGINE_PORT || '0' } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 1));
