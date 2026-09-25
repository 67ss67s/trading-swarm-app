/**
 * 进程内加固(纵深防御的第二层)。
 *
 * 第一层是 Node 权限模型(托管器用 --permission 启动,只放行本包与依赖目录的读):
 * 写文件、起子进程、worker、原生插件、process.binding 在内核调用前就被 Node 拒掉(ERR_ACCESS_DENIED)。
 *
 * 但 Node 24 的权限模型不管网络(--allow-net 是 25 才有),而 PineTS 执行的脚本能摸到 `process`
 * 全局(2026-09-23 实测:`process.mainModule.require('fs')` 能走到 fs 那一步,只是被权限模型拦下)。
 * 一段恶意脚本如果能发 HTTP,就能打本机网关 127.0.0.1:188xx 的 API。所以在加载完自己要用的模块后:
 *   - 用 module.registerHooks 拦 require / import 的网络、进程、文件、调试类内置模块;
 *   - 关掉 process.getBuiltinModule(它绕过模块加载器)、process.mainModule、再注册 hooks 的入口;
 *   - 删掉全局 fetch / WebSocket / EventSource;
 *   - process.kill 只允许打自己(防止脚本拿 process.ppid 去杀网关)。
 * 这一层是进程内的、不是内核级的,残余风险写在 README「沙箱」一节。
 */
'use strict';
const Module = require('node:module');

const BLOCKED = new Set([
    'fs', 'fs/promises', 'net', 'http', 'https', 'http2', 'tls', 'dgram', 'dns', 'dns/promises',
    'child_process', 'cluster', 'worker_threads', 'inspector', 'inspector/promises', 'v8', 'module',
    'repl', 'wasi', 'trace_events', 'undici',
]);

function denied(name) {
    const error = new Error(`pine_sandbox_denied:${name}(Pine 引擎沙箱不允许脚本访问该模块)`);
    error.code = 'ERR_ACCESS_DENIED';
    return error;
}

let locked = false;
function lockdown() {
    if (locked) return;
    locked = true;
    if (typeof Module.registerHooks === 'function') {
        Module.registerHooks({
            resolve(specifier, context, next) {
                const bare = String(specifier).replace(/^node:/, '');
                if (BLOCKED.has(bare)) throw denied(bare);
                return next(specifier, context);
            },
        });
    }
    // 再注册 hooks 能排到我们前面短路掉拦截,入口一并封死
    for (const key of ['registerHooks', 'register']) {
        try { Object.defineProperty(Module, key, { value: undefined, writable: false, configurable: false }); } catch { /* 已不可配置 */ }
    }
    const lock = (target, key, value) => {
        try { Object.defineProperty(target, key, { value, writable: false, configurable: false }); } catch { /* ignore */ }
    };
    lock(process, 'getBuiltinModule', () => { throw denied('getBuiltinModule'); });
    lock(process, 'mainModule', undefined);
    for (const key of ['fetch', 'WebSocket', 'EventSource']) {
        try { delete globalThis[key]; } catch { /* ignore */ }
        lock(globalThis, key, undefined);
    }
    const kill = process.kill.bind(process);
    lock(process, 'kill', (pid, signal) => {
        if (pid !== process.pid) throw denied('process.kill');
        return kill(pid, signal);
    });
}

module.exports = { lockdown, BLOCKED };
