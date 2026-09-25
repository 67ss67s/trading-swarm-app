/**
 * 游戏式交互(追加 3),每条都连到真实功能;原型里走 mock + toast,真实入口写在注释里。
 *   1 NPC 对话菜单(npc.ts,这里只接动作)  2 拖币派活  3 拖策略给 EXEC  4 待批订单 = 信箱金信封
 *   5 agent 看你 / 挥手 / 击掌(engine)    6 紧急停止大红按钮(按住 2 秒)  7 天气即状态(weather.ts)
 *   8 键盘 + ~ 命令行                        彩蛋:宠物翻身、雕像撒金币(engine)
 */
import type { MockSource } from './mock';
import { ROLES, ROLE_ORDER, TASKS } from './roles';
import { THEMES, THEME_ORDER } from './themes';
import type { FloorHandle, Role, Snapshot, TaskDef, ThemeId } from './types';

interface Deps {
  floor: FloorHandle;
  mock: MockSource;
  snap: () => Snapshot;
  setTheme: (id: ThemeId) => void;
  theme: () => ThemeId;
}

const COINS: { sym: string; px: number; ch: number }[] = [
  { sym: 'BTC', px: 84120.5, ch: 1.2 },
  { sym: 'ETH', px: 3241.9, ch: -0.4 },
  { sym: 'SOL', px: 158.42, ch: 5.1 },
  { sym: 'DOGE', px: 0.162, ch: -1.2 },
];

/** 拖币给谁 → 干什么(真实入口) */
function coinTask(role: Role, sym: string): { task: TaskDef; line: string } | null {
  if (role === 'radar') return { line: `${sym} 加入观察列表!`, task: { id: `watch_${sym}`, label: `盯住 ${sym}`, result: `${sym} 已进观察列表,急动阈值 0.8%`, real: 'POST /api/watchlist {symbol}' } };
  if (role === 'thread_manager') return { line: `马上判断 ${sym}`, task: { id: `judge_${sym}`, label: `现在判断一次 ${sym}`, result: `${sym}:偏多,等回踩确认再进`, real: 'POST /api/judgments/run {symbol}' } };
  if (role === 'strategy_lab') return { line: `用当前策略回测 ${sym}`, task: { id: `bt_${sym}`, label: `回测当前策略 · ${sym}`, result: `${sym} 上 90 天胜率 55%,回撤 5.8%`, real: 'POST /api/backtests {strategy_id, symbol}' } };
  return null;
}

const NAME: Record<string, Role> = {
  radar: 'radar', 雷达: 'radar', thread: 'thread_manager', 论点: 'thread_manager', lab: 'strategy_lab', 实验室: 'strategy_lab', 实验: 'strategy_lab',
  book: 'portfolio_manager', 组合: 'portfolio_manager', sentinel: 'risk_sentinel', 风控: 'risk_sentinel', 哨兵: 'risk_sentinel', exec: 'executor', 执行: 'executor',
  market: 'asp_agent', 市场: 'asp_agent', audit: 'reviewer', 复盘: 'reviewer', helm: 'gate_captain', 指挥: 'gate_captain', 船长: 'gate_captain',
};

export function installInteractions(d: Deps) {
  const scene = document.getElementById('scene')!;

  // ---------- toast ----------
  const toastEl = document.createElement('div');
  toastEl.className = 'toast';
  scene.appendChild(toastEl);
  let toastTimer = 0;
  function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('on'), 2800);
  }

  function dispatch(role: Role, task: TaskDef): void {
    // 真实入口:task.real(派活 API),完成后由 /api/activity 回推动态
    d.mock.dispatch(role, task);
  }

  // ---------- 1. NPC 动作 ----------
  function agentAction(role: Role, action: 'chat' | 'task' | 'workbench', task?: TaskDef): void {
    const info = ROLES[role];
    if (action === 'chat') toast(`打开 Agent 对话,已预选 ${info.callsign}(真实入口 #agent?role=${role})`);
    else if (action === 'task' && task) { dispatch(role, task); toast(`已派给 ${info.callsign}:${task.label}(${task.real})`); }
    else if (action === 'workbench') { toast(`打开工作台 · ${info.pageLabel}(#${info.page})`); }
  }

  // ---------- 拖拽通用 ----------
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  document.body.appendChild(ghost);
  function drag(e: PointerEvent, html: string, accept: (r: Role) => boolean, drop: (r: Role | null) => void): void {
    e.preventDefault();
    ghost.innerHTML = html;
    ghost.style.display = 'block';
    let target: Role | null = null;
    const move = (ev: PointerEvent) => {
      ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 8}px) rotate(-4deg)`;
      const r = d.floor.pick(ev.clientX, ev.clientY);
      const ok = r && accept(r) ? r : null;
      if (ok !== target) { target = ok; d.floor.setDropTarget(ok); }
      ghost.classList.toggle('ok', !!ok);
      ghost.classList.toggle('no', !!r && !ok);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost.style.display = 'none';
      d.floor.setDropTarget(null);
      drop(target);
    };
    move(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------- 2. 顶栏行情:拖币派活 ----------
  const coinsEl = document.getElementById('coins')!;
  function renderCoins(): void {
    coinsEl.innerHTML = COINS.map((c) => `<div class="coin" data-s="${c.sym}"><b>${c.sym}</b><span class="${c.ch >= 0 ? 'up' : 'down'}">${c.ch >= 0 ? '+' : ''}${c.ch.toFixed(1)}%</span></div>`).join('');
  }
  renderCoins();
  setInterval(() => { COINS.forEach((c) => { c.ch += (Math.random() - 0.5) * 0.3; }); renderCoins(); }, 4000);
  coinsEl.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.coin');
    const sym = el?.dataset['s'];
    if (!sym) return;
    drag(e, `<b>${sym}</b><small>拖给 RADAR / THREAD / LAB</small>`, (r) => !!coinTask(r, sym), (r) => {
      if (!r) { toast(`把 ${sym} 拖到 RADAR(观察)/ THREAD(判断)/ LAB(回测)`); return; }
      const ct = coinTask(r, sym)!;
      d.floor.catchDrop(r, ct.line);
      dispatch(r, ct.task);
      toast(`${ROLES[r].callsign} 接住了 ${sym}:${ct.task.label}(${ct.task.real})`);
    });
  });

  // ---------- 3. 当前策略卡:拖给 EXEC 运行 ----------
  const stratEl = document.getElementById('strat')!;
  function renderStrat(): void {
    const st = d.snap().strategy;
    if (!st) { stratEl.style.display = 'none'; return; }
    stratEl.innerHTML = `<span class="grip">⠿</span><div><b>当前策略 · ${esc(st.name)}</b><small>${st.symbol} · ${st.stage} · 拖到 EXEC 工位运行</small></div>`;
  }
  const runCard = document.createElement('div');
  runCard.className = 'pcard run';
  runCard.style.display = 'none';
  scene.appendChild(runCard);
  function openRun(): void {
    const st = d.snap().strategy;
    if (!st) return;
    runCard.innerHTML = `<h4>运行策略 · ${esc(st.name)}</h4>
      <label>标的 <select id="run-sym">${['ETHUSDT', 'BTCUSDT', 'SOLUSDT'].map((x) => `<option ${x === st.symbol ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>模式 <select id="run-mode"><option value="paper">paper(模拟)</option><option value="live" disabled>live(需金丝雀额度)</option></select></label>
      <p class="hint">真实入口 §9.51 Strategy Run:POST /api/strategy-runs</p>
      <div class="btns"><button class="ok" data-a="run">运行</button><button data-a="cancel">取消</button></div>`;
    runCard.style.display = 'block';
    runCard.onclick = (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset['a'];
      if (a === 'cancel') runCard.style.display = 'none';
      if (a === 'run') {
        const sym = (runCard.querySelector('#run-sym') as HTMLSelectElement).value;
        d.mock.runStrategy(sym, 'paper');
        d.floor.catchDrop('executor', `开跑 ${st.name}!`);
        runCard.style.display = 'none';
        toast(`EXEC 开始运行「${st.name}」· ${sym} · paper`);
      }
    };
  }
  stratEl.addEventListener('pointerdown', (e) => {
    const st = d.snap().strategy;
    if (!st) return;
    drag(e, `<b>▶ ${esc(st.name)}</b><small>拖给 EXEC 运行</small>`, (r) => r === 'executor', (r) => {
      if (r === 'executor') { d.floor.catchDrop('executor', '策略收到,等你确认参数'); openRun(); }
      else toast('把策略卡拖到底楼 EXEC 的交易台上');
    });
  });

  // ---------- 4. 待批订单 = 信箱里的金信封 ----------
  const apCard = document.createElement('div');
  apCard.className = 'pcard approve';
  apCard.style.display = 'none';
  scene.appendChild(apCard);
  function openApproval(): void {
    const it = d.snap().inbox.items.find((x) => x.kind === 'approval') ?? d.snap().inbox.items[0];
    if (!it) { toast('信箱是空的,没有待批订单'); return; }
    apCard.innerHTML = `<div class="env">✉</div><h4>${esc(it.title)}</h4><p>${esc(it.detail ?? '')}</p>
      <p class="hint">真实入口 POST /api/approvals/${it.id} {decision};批准绑定 plan_hash,只能拒不能改经济字段</p>
      <div class="btns"><button class="ok" data-a="yes">批准</button><button class="no" data-a="no">拒绝</button><button data-a="later">稍后</button></div>`;
    apCard.style.display = 'block';
    apCard.onclick = (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset['a'];
      if (!a) return;
      apCard.style.display = 'none';
      if (a === 'later') return;
      const ok = a === 'yes';
      d.floor.approval(ok);
      d.mock.approve(it.id, ok);
      toast(ok ? '已批准:金信封飞向 EXEC' : '已拒绝:信封揉成了纸团');
    };
  }

  // ---------- 6. 紧急停止:防误触罩 + 按住 2 秒 ----------
  const es = document.getElementById('estop')!;
  es.innerHTML = `<div class="lid" title="先掀开保护罩">紧急停止</div><button class="btn" title="按住 2 秒"><svg viewBox="0 0 36 36"><circle class="trk" cx="18" cy="18" r="15"/><circle class="prog" cx="18" cy="18" r="15"/></svg><span>STOP</span></button>`;
  const lid = es.querySelector<HTMLElement>('.lid')!;
  const btn = es.querySelector<HTMLButtonElement>('.btn')!;
  const prog = es.querySelector<SVGCircleElement>('.prog')!;
  const C = 2 * Math.PI * 15;
  prog.style.strokeDasharray = `${C}`;
  prog.style.strokeDashoffset = `${C}`;
  let holdRaf = 0, holdStart = 0, lidTimer = 0;
  lid.addEventListener('click', () => {
    es.classList.add('open');
    clearTimeout(lidTimer);
    lidTimer = window.setTimeout(() => es.classList.remove('open'), 6000);
  });
  const stopHold = () => { cancelAnimationFrame(holdRaf); prog.style.strokeDashoffset = `${C}`; btn.classList.remove('hold'); };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    holdStart = performance.now();
    btn.classList.add('hold');
    const tick = () => {
      const k = Math.min(1, (performance.now() - holdStart) / 2000);
      prog.style.strokeDashoffset = `${C * (1 - k)}`;
      if (k >= 1) {
        stopHold();
        es.classList.remove('open');
        // 真实入口:POST /api/emergency-stop(停新开仓、撤挂单、保留保护腿)
        d.floor.emergency();
        d.mock.emergency();
        toast('紧急停止已触发:停新开仓、撤挂单,只保留保护腿');
        return;
      }
      holdRaf = requestAnimationFrame(tick);
    };
    holdRaf = requestAnimationFrame(tick);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stopHold));

  // ---------- 8. 键盘 + 命令行 ----------
  const con = document.createElement('div');
  con.className = 'console';
  con.style.display = 'none';
  con.innerHTML = `<div class="log"></div><div class="in"><span>&gt;</span><input spellcheck="false" placeholder="让 radar 盯 SOL / 回测 当前策略 ETH / 判断 BTC / 天气 雨 / help"></div>`;
  scene.appendChild(con);
  const input = con.querySelector('input')!;
  const log = con.querySelector('.log')!;
  const say = (t: string, cls = '') => {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = t;
    log.appendChild(div);
    while (log.children.length > 7) log.firstChild?.remove();
  };
  say('像素命令行 · 输入 help 看可用指令', 'dim');
  function toggleConsole(on?: boolean): void {
    const show = on ?? con.style.display === 'none';
    con.style.display = show ? 'block' : 'none';
    if (show) setTimeout(() => input.focus(), 0);
  }
  function findRole(text: string): Role | null {
    const low = text.toLowerCase();
    for (const [k, r] of Object.entries(NAME)) if (low.includes(k)) return r;
    return null;
  }
  function runCmd(raw: string): void {
    const t = raw.trim();
    if (!t) return;
    say(`> ${t}`);
    const coin = (t.match(/\b([A-Za-z]{2,6})\b(?!.*\b[A-Za-z]{2,6}\b)/)?.[1] ?? '').toUpperCase();
    const isCoin = coin && !['RADAR', 'THREAD', 'LAB', 'BOOK', 'SENTINEL', 'EXEC', 'MARKET', 'AUDIT', 'HELM', 'HELP', 'MEME'].includes(coin);
    if (/^(help|帮助|\?)$/i.test(t)) {
      say('让 radar 盯 SOL · 判断 BTC · 回测 当前策略 ETH · 查风险 · 看持仓 · 复盘 昨天', 'dim');
      say('让 <agent> <任务> · 主题 书房/指挥/meme · 天气 雨/晴/夜/昼/自动 · 暂停 · 去 <agent>', 'dim');
      return;
    }
    if (/^主题/.test(t)) {
      const id: ThemeId = /指挥|command/i.test(t) ? 'command' : /meme|霓虹/i.test(t) ? 'meme' : 'study';
      d.setTheme(id);
      say(`主题 → ${THEMES[id].name}`, 'ok');
      return;
    }
    if (/^天气/.test(t)) {
      const w = /雨/.test(t) ? 'rain' : /晴/.test(t) ? 'clear' : /夜/.test(t) ? 'night' : /昼|白天/.test(t) ? 'day' : null;
      d.floor.setWeatherOverride(w);
      say(w ? `天气覆盖 → ${t.replace('天气', '').trim()}(演示用)` : '天气 → 跟随真实状态', 'ok');
      return;
    }
    if (/^暂停|^继续/.test(t)) { say(d.floor.togglePause() ? '动画已暂停' : '动画继续', 'ok'); return; }
    if (/^去|^看看? ?(radar|thread|lab|book|sentinel|exec|market|audit|helm)/i.test(t)) {
      const r = findRole(t);
      if (r) { d.floor.focus(r); say(`镜头 → ${ROLES[r].callsign}`, 'ok'); return; }
    }
    let role: Role | null = null;
    let task: TaskDef | null = null;
    if (/盯|观察|watch/i.test(t) && isCoin) { role = 'radar'; task = coinTask('radar', coin)!.task; }
    else if (/回测|backtest/i.test(t)) { role = 'strategy_lab'; task = isCoin ? coinTask('strategy_lab', coin)!.task : TASKS.strategy_lab[0]!; }
    else if (/判断|judge/i.test(t)) { role = 'thread_manager'; task = coinTask('thread_manager', isCoin ? coin : 'BTC')!.task; }
    else if (/风险|risk/i.test(t)) { role = 'risk_sentinel'; task = TASKS.risk_sentinel[0]!; }
    else if (/持仓|position/i.test(t)) { role = 'executor'; task = TASKS.executor[0]!; }
    else if (/复盘|retro/i.test(t)) { role = 'reviewer'; task = TASKS.reviewer[0]!; }
    else if (/扫|scan/i.test(t)) { role = 'radar'; task = TASKS.radar[0]!; }
    else if (/订阅|信号/.test(t)) { role = 'asp_agent'; task = TASKS.asp_agent[0]!; }
    else if (/敞口|组合/.test(t)) { role = 'portfolio_manager'; task = TASKS.portfolio_manager[0]!; }
    else {
      role = findRole(t);
      if (role) task = TASKS[role].find((x) => t.includes(x.label.slice(0, 2))) ?? TASKS[role][0] ?? null;
    }
    if (role && task) {
      dispatch(role, task);
      d.floor.catchDrop(role, `收到:${task.label}`);
      say(`→ ${ROLES[role].callsign}:${task.label}(${task.real})`, 'ok');
    } else say('没听懂。试试 help', 'err');
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { runCmd(input.value); input.value = ''; }
    else if (e.key === 'Escape' || e.key === '`' || e.key === '~') { e.preventDefault(); toggleConsole(false); }
  });

  window.addEventListener('keydown', (e) => {
    const tgt = e.target as HTMLElement;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA')) return;
    if (e.key === '`' || e.key === '~') { e.preventDefault(); toggleConsole(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[1-9]$/.test(e.key)) { const r = ROLE_ORDER[Number(e.key) - 1]; if (r) d.floor.focus(r); return; }
    if (e.key === 't' || e.key === 'T') { const i = THEME_ORDER.indexOf(d.theme()); d.setTheme(THEME_ORDER[(i + 1) % THEME_ORDER.length]!); return; }
    if (e.key === 'l' || e.key === 'L') { toast('布局 A(开放办公室)是另一个原型页 a.html;合进楼层后 L 在同页切换'); return; }
    if (e.key === ' ') { e.preventDefault(); toast(d.floor.togglePause() ? '动画已暂停(空格继续)' : '动画继续'); }
  });

  function refresh(): void {
    renderStrat();
  }
  refresh();

  return { agentAction, openApproval, toast, refresh };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
