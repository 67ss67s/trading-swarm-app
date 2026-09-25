// 驱动 headless Chrome(先起:Chrome --headless=new --remote-debugging-port=9378 --user-data-dir=/tmp/cdp-prof-9378;再 PUT /json/new?http://127.0.0.1:5191/%23my-strategies)。CDP_PORT=9378 TAB=5191 node cdp.mjs text|shot <png>|click <文本>|eval <js>。注意 Chrome 的 --screenshot 参数在 5191 上会被 SSE 挂住,用这个。
// 连到用户手动起的 Chrome(9555),对 horizon 标签页执行:text | shot <file> | click <文本> | eval <js> | scroll <y>
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const WebSocket = require('ws');
const [cmd, arg = '', arg2 = ''] = process.argv.slice(2);
const tabs = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT ?? '9555') + '/json/list')).json();
const tab = tabs.find((t) => t.type === 'page' && t.url.includes(process.env.TAB ?? 'horizon')) ?? tabs.find((t) => t.type === 'page');
if (cmd === 'list') { console.log(tabs.filter(t=>t.type==='page').map((t) => t.url + ' | ' + t.title).join('\n')); process.exit(0); }
const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => ws.on('open', r));
let id = 0; const pending = new Map();
ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (cmd === 'text') console.log(await ev(`(document.querySelector(${JSON.stringify(arg || 'body')})||document.body).innerText`));
else if (cmd === 'shot') { const s = await send('Page.captureScreenshot', { format: 'png', ...(arg2 === 'full' ? { captureBeyondViewport: true } : {}) }); writeFileSync(arg, Buffer.from(s.result.data, 'base64')); console.log('saved', arg); }
else if (cmd === 'click') { console.log(await ev(`(()=>{const els=[...document.querySelectorAll('button,a,[role=tab],[role=button],div,span')].filter(e=>e.children.length<4&&e.innerText&&e.innerText.trim()===${JSON.stringify(arg)});const el=els.at(-1);if(!el)return 'not found';el.scrollIntoView({block:'center'});for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,button:0}));return 'clicked '+el.tagName+' '+els.length})()`)); await sleep(Number(arg2 || 2500)); }
else if (cmd === 'eval') console.log(JSON.stringify(await ev(arg), null, 1));
else if (cmd === 'scroll') console.log(await ev(`(()=>{const s=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+50&&getComputedStyle(e).overflowY.match(/auto|scroll/));s.forEach(e=>e.scrollTop=${Number(arg)});window.scrollTo(0,${Number(arg)});return s.length+' scrollers'})()`));
ws.close(); process.exit(0);
