// 在加载任何 adapter 前安装；工具命令默认拒绝网络和子进程旁路。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const deny=()=>{throw Error('research_eval_network_denied');};
globalThis.fetch=deny;
http.request=http.get=https.request=https.get=deny;
net.connect=net.createConnection=tls.connect=dgram.createSocket=deny;
net.Socket.prototype.connect=deny;
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])child[key]=deny;
syncBuiltinESMExports();
