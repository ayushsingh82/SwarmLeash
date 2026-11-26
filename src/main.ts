import {
  waitForEvenAppBridge, StartUpPageCreateResult, OsEventTypeList, AudioInputSource,
  TextContainerProperty, TextContainerUpgrade, CreateStartUpPageContainer,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';

import type {
  Challenge, EdgeReport, JournalResponse, OrderResult, Pair, Position, PositionsResponse, PreMortem, Proposal, Side,
} from './types.ts';

/** What the glasses currently show a decision about: a pre-mortem or a swarm idea. */
interface Active {
  symbol: Pair; side: Side | null; qty: number; summary: string; tilt: string[];
  thesis?: string; tags?: string[]; stop?: number; target?: number;
}
type Mode = 'idle' | 'challenge' | 'idea' | 'tilt' | 'undo' | 'position' | 'info';

const SYMBOL: Pair = 'ETHUSDT';
const UNDO_SECONDS = 3;
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''; // e.g. https://your-backend.example.com for the packed app
const api = async <T = unknown>(p: string, init?: RequestInit): Promise<T> => (await fetch(BASE + '/api' + p, init)).json() as Promise<T>;
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const mark = (v: number) => (v > 0 ? '+' : v < 0 ? '-' : '0');
const $ = (id: string) => document.getElementById(id)!;
const sgn = (v: number): string => (v >= 0 ? '+' : '-') + Math.abs(v);
const usd = (v: number): string => (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2);

let bridge: EvenAppBridge | null = null;
let prop: Active | null = null;
let mode: Mode = 'idle';
let tiltSince = 0;
let undoTimer: number | undefined;
let positions: Position[] = [];
let totalPnl = 0;
const knownIds = new Set<string>();
const userClosed = new Set<string>();

// ---------- web panel ----------
type Kind = 'good' | 'bad' | 'warn' | '';
const ICON: Record<string, string> = { good: '<svg class="i"><use href="#i-check"/></svg>', bad: '<svg class="i"><use href="#i-x"/></svg>', warn: '<svg class="i"><use href="#i-warn"/></svg>', '': '<svg class="i"><use href="#i-chat"/></svg>' };
const ic = (n: string) => `<svg class="i"><use href="#i-${n}"/></svg>`;
const AGENT_META: Record<string, [string, string]> = { Trend: ['trend', 'follows the moving averages'], Momentum: ['bolt', 'reads RSI strength'],
  Funding: ['coin', 'compares funding across venues'], Risk: ['shield', 'sizes down in wild markets'] };
// who speaks in the pre-mortem debate
const VOICE: Record<string, [string, string]> = { history: ['book', 'Journal'], trend: ['trend', 'Chart'], rsi: ['trend', 'Chart'], funding: ['users', 'Crowd'],
  vol: ['shield', 'Risk'], tilt: ['eye', 'Discipline'], bias: ['eye', 'Discipline'], plan: ['flag', 'Plan'], nostop: ['flag', 'Plan'], none: ['shield', 'Risk'] };
let firstPx = 0, proposalAt = 0;
function setStep(n: number) { document.querySelectorAll<HTMLElement>('#flow .fs').forEach(el => { const i = +el.dataset.s!; el.classList.toggle('on', i === n); el.classList.toggle('done', i < n); }); }

function log(msg: string, kind: Kind = '') {
  const d = document.createElement('div'); d.className = 'ev ' + kind;
  d.innerHTML = `<time>${new Date().toLocaleTimeString([], { hour12: false })}</time><span>${ICON[kind]}</span><span class="m"></span>`;
  (d.querySelector('.m') as HTMLElement).textContent = msg; $('log').prepend(d);
}
let toastT: number;
function toast(msg: string, kind: Kind = '') {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show ' + kind;
  clearTimeout(toastT); toastT = window.setTimeout(() => (t.className = 'toast'), 2600);
}
function chart(series: number[], entry: number, side: string | null) {
  const W = 600, H = 120, lo = Math.min(...series), hi = Math.max(...series), pad = (hi - lo) * 0.12 || 1;
  const x = (i: number) => (i / (series.length - 1)) * W, y = (v: number) => H - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * H;
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const col = side === 'Sell' ? '#cf202f' : '#05b169';
  $('chart').innerHTML = `<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".22"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
   <polygon points="0,${H} ${pts} ${W},${H}" fill="url(#ag)"/><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>
   <line x1="0" x2="${W}" y1="${y(entry)}" y2="${y(entry)}" stroke="${col}" stroke-dasharray="4 5" opacity=".5" vector-effect="non-scaling-stroke"/>
   <circle cx="${W}" cy="${y(entry)}" r="4.5" fill="${col}"/>`;
}
let jdata: JournalResponse = { entries: [], stats: [] };
const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const EXIT_LABEL = { stop: 'stopped', target: 'target', manual: 'closed', cut: 'cut half' } as const;

async function loadJournal() {
  try { jdata = await api<JournalResponse>('/journal'); } catch { return; }
  $('jstats').innerHTML = jdata.stats.map(x => { const r = x.wins / x.n; return `<span class="${r <= 0.34 ? 'bad' : r >= 0.66 ? 'good' : ''}">${x.tag} · ${x.wins}/${x.n} won</span>`; }).join('') || '<span>no closed trades yet</span>';
  const rows = jdata.entries.slice(0, 8);
  if (!rows.length) { $('orders').className = 'empty'; $('orders').textContent = 'No trades yet. Your first one starts the record.'; }
  else {
    $('orders').className = '';
    $('orders').innerHTML = `<table><tr><th>When</th><th>Thesis</th><th>Tag</th><th>Result</th></tr>` + rows.map(e => {
      const res = e.status === 'open' ? '<span class="res open">OPEN</span>'
        : `<span class="res ${e.win ? 'win' : 'loss'}">${e.win ? 'WIN' : 'LOSS'} ${sgn(e.pnlPct ?? 0)}%${e.exitReason ? ' · ' + EXIT_LABEL[e.exitReason] : ''}</span>`;
      return `<tr><td class="mono">${new Date(e.ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}</td><td class="thx">${esc(e.text)}</td><td>${e.tags[0]}</td><td>${res}</td></tr>`;
    }).join('') + `</table>`;
  }
  try { renderEdge(await api<EdgeReport>('/edge')); } catch { /* optional */ }
}
function renderEdge(r: EdgeReport) {
  const el = $('edge');
  if (!r.trades) { el.innerHTML = ''; return; }
  const fmt = (s?: { tag: string; wins: number; n: number }) => (s ? `${s.tag} ${s.wins}/${s.n}` : 'not enough data');
  el.innerHTML = `<div class="ed good"><small>EDGE</small><b>${fmt(r.best)}</b></div><div class="ed bad"><small>LEAK</small><b>${fmt(r.worst)}</b></div>
   <div class="ed"><small>WIN RATE</small><b>${r.winRate}%</b></div><div class="ed ${r.totalPnlPct >= 0 ? 'good' : 'bad'}"><small>P&amp;L</small><b>${sgn(r.totalPnlPct)}%</b></div>
   <div class="ed"><small>WITH A STOP</small><b>${r.withStop}/${r.realTrades}</b></div>`;
}

function renderPre(pm: PreMortem) {
  const h = pm.history, tag = pm.tags[0] ?? 'hunch', top = pm.challenges[0]?.strength ?? 0, pct = Math.round(top * 100);
  const col = pm.verdict === 'RED' ? '#cf202f' : pm.verdict === 'AMBER' ? '#d98a00' : '#05b169';
  const dots = jdata.entries.filter(e => e.status === 'closed' && e.tags.includes(tag)).slice(0, 12).reverse().map(e => `<span class="d ${e.win ? 'w' : 'l'}"></span>`).join('');
  const rec = h.n ? `Your record on <b>“${tag}”</b> trades: ${h.wins} of ${h.n} won` : `No history on “${tag}” yet. This trade starts your record.`;
  const msg = (kind: 'against' | 'for', c: Challenge | { kind: Challenge['kind']; text: string }, i: number) => { const [icon, who] = VOICE[c.kind] ?? ['shield', 'Risk'];
    return `<div class="msg" style="animation-delay:${i * 420}ms"><div class="av ${kind}">${ic(icon)}</div><div class="bub ${kind}"><div class="who">${who}<em class="${kind}">${kind === 'against' ? 'AGAINST' : 'FOR'}</em></div><p>${esc(c.text)}</p>` +
      (kind === 'against' && 'strength' in c ? `<div class="bar"><i style="width:${Math.round(c.strength * 100)}%"></i></div>` : '') + `</div></div>`; };
  const real = pm.challenges.filter(c => c.kind !== 'none');
  const msgs = [...real.map((c, i) => msg('against', c, i)), ...pm.support.map((c, i) => msg('for', c, real.length + i))];
  const cut = pm.verdict === 'RED' ? ' Size cut to 30% of the cap because the verdict is RED.' : pm.verdict === 'AMBER' ? ' Size is 60% of the cap.' : '';
  const plan = pm.stop !== undefined
    ? `<span class="chip stop">${ic('flag')} stop ${pm.stop} (-${pm.stopPct}%)</span>${pm.target !== undefined ? `<span class="chip tgt">${ic('flag')} target ${pm.target}${pm.rr ? ` · ${pm.rr}R` : ''}</span>` : ''}`
    : `<span class="chip warnchip">${ic('warn')} no stop set</span>`;
  const venues = pm.venues.length ? `<div class="venues"><b>FUNDING / 8H</b>${pm.venues.map(v => `<span>${v.venue} <i class="${v.rate8h > 0.0001 ? 'dn' : v.rate8h < -0.0001 ? 'up' : ''}">${v.rate8h >= 0 ? '+' : ''}${(v.rate8h * 100).toFixed(3)}%</i></span>`).join('')}</div>` : '';
  $('pmres').innerHTML = `<div class="summary"><div class="meter ${pm.verdict}"><svg viewBox="0 0 200 112"><path class="bg" d="M12 102A88 88 0 0 1 188 102" pathLength="100"/><path class="fg" id="mfg" d="M12 102A88 88 0 0 1 188 102" pathLength="100" stroke="${col}" stroke-dasharray="0 100"/></svg><div><b>${pm.verdict}</b><small>RISK ${pct}</small></div></div>
    <div><div class="thesis">“${esc(pm.thesis)}”</div><div class="sub">${pm.side ? pm.summary + ' @ ' + pm.price.toFixed(2) : 'Say long or short'}</div>
    <div class="chips"><span class="chip">${ic('book')} ${pm.tags.join(', ')}</span>${plan}<span class="chip t">${pm.mode === 'testnet' ? 'Bybit testnet' : 'Paper'}</span></div></div></div>
   <div class="record"><span>${ic('book')}</span><b>${rec}</b>${dots ? `<div class="dots">${dots}</div>` : ''}</div>
   ${venues}
   <div class="debate">${msgs.join('')}</div>
   ${pm.side ? `<div class="decide" id="decide"><button class="btn big" data-k="click">${ic('check')} Trade anyway</button><button class="btn big red" data-k="dbl">${ic('x')} Drop it</button><div class="note">${esc(pm.summary)}.${cut} The order is held ${UNDO_SECONDS}s so you can undo it.</div></div>` : ''}`;
  requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('mfg')?.setAttribute('stroke-dasharray', `${Math.max(6, pct)} 100`)));
}
const typingHtml = () => `<div class="debate">${['Journal', 'Chart', 'Crowd'].map(w => `<div class="msg"><div class="av">${ic('eye')}</div><div class="bub"><div class="who">${w} is thinking</div><div class="typing"><i></i><i></i><i></i></div></div></div>`).join('')}</div>`;

function renderPositions() {
  const el = $('positions'), tot = $('postotal');
  if (!positions.length) { el.className = 'empty'; el.textContent = 'No open position. Tap "Trade anyway" to open one.'; tot.textContent = ''; return; }
  el.className = '';
  tot.textContent = `Total ${usd(totalPnl)}`; tot.className = totalPnl >= 0 ? 'up' : 'dn';
  el.innerHTML = positions.map(p => {
    const vals = [p.entry, p.mark, ...(p.stop !== undefined ? [p.stop] : []), ...(p.target !== undefined ? [p.target] : [])];
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1, at = (v: number) => (((v - lo) / span) * 94 + 3).toFixed(1);
    const range = p.stop !== undefined || p.target !== undefined
      ? `<div class="range"><i class="seg"></i>${p.stop !== undefined ? `<u class="s" style="left:${at(p.stop)}%"><em>STOP ${p.stop}</em></u>` : ''}<u class="e" style="left:${at(p.entry)}%"><em>ENTRY</em></u>${p.target !== undefined ? `<u class="t" style="left:${at(p.target)}%"><em>TGT ${p.target}</em></u>` : ''}<u class="m ${p.pnlUsd >= 0 ? 'up' : 'dn'}" style="left:${at(p.mark)}%"></u></div>` : '<div class="nostop">No stop set on this trade</div>';
    return `<div class="pos"><div class="pt"><div><b>${p.side === 'Buy' ? 'LONG' : 'SHORT'} ${p.symbol.replace('USDT', '')}</b> <span class="mono">${p.qty}</span><div class="sub">${p.entry.toFixed(2)} → ${p.mark.toFixed(2)}</div></div>
      <div class="pnl ${p.pnlUsd >= 0 ? 'up' : 'dn'}"><b>${sgn(p.pnlPct)}%</b><small>${usd(p.pnlUsd)}</small></div></div>${range}
      <div class="pb"><button class="btn sm" data-k="cut" data-id="${p.id}">${ic('x')} Cut half</button><button class="btn sm red" data-k="closepos" data-id="${p.id}">${ic('check')} Close all</button></div></div>`;
  }).join('');
}

function renderPanel(p: Proposal & { series?: number[] }) {
  proposalAt = Date.now();
  $('modetxt').textContent = p.mode === 'testnet' ? 'Bybit testnet' : 'Paper mode'; $('mode').className = 'pill ' + p.mode; $('conn').className = 'dot on';
  if (!firstPx) firstPx = p.series?.[0] ?? p.price;
  const ch = ((p.price - (p.series?.[0] ?? p.price)) / (p.series?.[0] ?? p.price)) * 100;
  $('px').textContent = p.price.toFixed(2); $('chg').textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%'; $('chg').className = 'mono ' + (ch >= 0 ? 'up' : 'dn');
  const long = p.side === 'Buy', short = p.side === 'Sell';
  $('badge').className = 'badge ' + (long ? 'long' : short ? 'short' : 'flat');
  $('badge').innerHTML = p.side ? `${long ? ic('trend') + ' LONG' : ic('down') + ' SHORT'} ${p.symbol.replace('USDT', '')}` : 'NO TRADE';
  $('sub').textContent = p.side ? `${p.qty} @ ${p.price.toFixed(2)} · ${p.agree}/3 agents agree` : 'The swarm is split. Sitting this one out.';
  $('conf').textContent = p.conf + '%';
  const g = $('gauge'); g.setAttribute('stroke-dasharray', `${(p.conf / 100) * 264} 264`); g.setAttribute('stroke', p.conf >= 66 ? '#05b169' : p.conf >= 40 ? '#d98a00' : '#cf202f');
  if (p.series) chart(p.series, p.price, p.side);
  $('agents').innerHTML = p.agents.map((a, i) => {
    const c = a.vote > 0 ? 'p' : a.vote < 0 ? 'm' : 'z';
    const t = a.name === 'Risk' ? (a.vote ? 'OK' : 'HIGH VOL') : a.vote > 0 ? 'LONG' : a.vote < 0 ? 'SHORT' : 'FLAT';
    const [icn, role] = AGENT_META[a.name] ?? ['hive', ''];
    return `<div class="agent" style="animation-delay:${i * 90}ms"><div class="top2"><div class="a">${ic(icn)}</div><div><div class="n">${a.name}</div><div class="role">${role}</div></div><span class="cp ${c}">${t}</span></div><div class="w">${a.why}</div></div>`;
  }).join('');
  const t = p.tilt, has = (re: RegExp) => t.find(x => re.test(x));
  const rules: [string, string, RegExp][] = [['repeat', '3+ orders in 5 minutes', /orders in/], ['down', 'Last trade is red', /red/], ['flask', 'Manual flag (demo)', /demo|tilt guard on/]];
  $('rules').innerHTML = rules.map(([icn, name, re]) => { const hit = has(re); return `<div class="rule ${hit ? 'on' : ''}"><div class="ic">${ic(icn)}</div>${name}<em>${hit ? 'TRIGGERED' : 'clear'}</em></div>`; }).join('');
  $('tstatus').className = 'status ' + (t.length ? 'warn' : 'ok');
  $('tstatus').textContent = t.length ? 'Tilt detected. Say "I\'m calm" to continue.' : 'Calm. Orders flow normally.';
}
setInterval(() => { if (proposalAt) $('age').textContent = `updated ${Math.round((Date.now() - proposalAt) / 1000)}s ago`; }, 1000);

// ---------- glasses ----------
async function show(text: string, warn = false) {
  const hud = $('hud'); const changed = hud.textContent !== text; hud.textContent = text; hud.classList.toggle('tilt', warn);
  if (changed) { hud.classList.remove('flash'); void hud.offsetWidth; hud.classList.add('flash'); }
  if (bridge) await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: text }));
}

function ideaScreen(p: Proposal) {
  if (!p.side) return `SWARMLEASH\n${p.summary}\n\nTAP = new idea`;
  const a = Object.fromEntries(p.agents.map(x => [x.name, x.vote]));
  return `${p.summary}  @${p.price.toFixed(0)}\n` +
    `Trend ${mark(a.Trend ?? 0)}  Mom ${mark(a.Momentum ?? 0)}\n` +
    `Fund ${mark(a.Funding ?? 0)}  Risk ${a.Risk ? 'ok' : 'HIGH'}\n` +
    `${p.agree}/3 agree  conf ${p.conf}%  [${p.mode}]\n\n` +
    `TAP = GO    2xTAP = VETO`;
}
const cut = (t: string, n = 32) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const idleScreen = () => `SWARMLEASH\nSay your trade + why\n"long ETH, ETF news"\n${positions.length ? `${positions.length} OPEN  2xTAP = view` : ''}\nHOLD = speak\nTAP = swarm idea`;
function challengeScreen(pm: PreMortem) {
  if (!pm.side) return `SWARMLEASH\nI need a side.\nSay "long ETH, why"\n\nHOLD = speak`;
  const h = pm.history, ch = pm.challenges.filter(c => c.kind !== 'history' && c.kind !== 'none' && c.kind !== 'nostop').slice(0, 2);
  const plan = pm.stop !== undefined ? `STOP ${pm.stop} (-${pm.stopPct}%)${pm.rr ? ' R:' + pm.rr : ''}` : 'NO STOP: hold, say "stop 2%"';
  return `${pm.summary}?  [${pm.verdict}]\n` + (h.n ? `YOU: ${h.n} ${pm.tags[0]}, ${h.wins} won\n` : 'YOU: no record yet\n') +
    (ch.length ? ch.map(c => '! ' + cut(c.text, 29)).join('\n') : '! no red flags found') + `\n${plan}\nTAP = GO   2xTAP = DROP`;
}
function tiltScreen(p: Active) {
  const wait = Math.max(0, 3 - Math.floor((Date.now() - tiltSince) / 1000));
  return `TILT GUARD\n${p.tilt.join(', ')}\n\nAre you calm?\n` +
    (wait ? `(breathe ${wait}s)` : `SAY "I'm calm" or TAP\n2xTAP = skip`);
}
const undoScreen = (p: Active, n: number) => `SENDING IN ${n}s\n${p.summary}\n${p.stop !== undefined ? `STOP ${p.stop}` : 'NO STOP SET'}\n\nTAP = UNDO`;
function positionScreen(): string {
  const p = positions[0];
  if (!p) return idleScreen();
  const plan = p.stop !== undefined ? `STOP ${p.stop}${p.target !== undefined ? '  TGT ' + p.target : ''}` : 'NO STOP SET';
  return `${p.side === 'Buy' ? 'LONG' : 'SHORT'} ${p.symbol.replace('USDT', '')} ${p.qty} @${p.entry.toFixed(0)}\n` +
    `P&L ${sgn(p.pnlPct)}%  ${usd(p.pnlUsd)}\n${plan}\nmark ${p.mark.toFixed(2)}${positions.length > 1 ? `  (+${positions.length - 1} more)` : ''}\nTAP = cut half  2xTAP = close`;
}

// ---------- positions ----------
async function refreshPositions() {
  let r: PositionsResponse;
  try { r = await api<PositionsResponse>('/positions'); } catch { return; }
  const now = new Set(r.positions.map(p => p.id));
  const vanished = [...knownIds].filter(id => !now.has(id) && !userClosed.has(id));
  knownIds.clear(); now.forEach(id => knownIds.add(id));
  positions = r.positions; totalPnl = r.totalPnlUsd;
  renderPositions();
  if (vanished.length) { // the backend closed it for us: a stop or a target was hit
    await loadJournal();
    const e = jdata.entries.find(x => vanished.includes(x.id));
    if (e && e.exitReason) {
      const hit = e.exitReason === 'stop' ? 'STOP HIT' : 'TARGET HIT', k: Kind = e.win ? 'good' : 'bad';
      log(`${hit}: ${e.text} ${sgn(e.pnlPct ?? 0)}%`, k); toast(`${hit} ${sgn(e.pnlPct ?? 0)}%`, k);
      if (mode === 'position' || mode === 'idle') { mode = 'info'; await show(`${hit}\n${e.win ? 'WIN' : 'LOSS'} ${sgn(e.pnlPct ?? 0)}%  ${usd(e.pnlUsd ?? 0)}\n\nTAP = continue`, !e.win); }
    }
  }
  if (mode === 'position') { if (positions.length) await show(positionScreen()); else await goIdle(); }
  else if (mode === 'idle') await show(idleScreen());
}
async function closeById(id: string, fraction: number): Promise<boolean> {
  if (fraction >= 1) userClosed.add(id);
  const r = await api<{ ok: boolean; closed?: { win?: boolean; pnlPct?: number; pnlUsd?: number; qty?: number } }>('/position/close', post({ id, fraction }));
  if (!r.ok || !r.closed) { log('Could not close that position', 'bad'); return false; }
  const c = r.closed, k: Kind = c.win ? 'good' : 'bad', what = fraction >= 1 ? 'Closed' : 'Cut half';
  log(`${what}: ${sgn(c.pnlPct ?? 0)}% (${usd(c.pnlUsd ?? 0)})`, k); toast(`${what} ${sgn(c.pnlPct ?? 0)}%`, k);
  await Promise.all([refreshPositions(), loadJournal()]);
  if (mode === 'position' || mode === 'info') { mode = 'info'; await show(`${what.toUpperCase()}\n${c.win ? 'WIN' : 'LOSS'} ${sgn(c.pnlPct ?? 0)}%  ${usd(c.pnlUsd ?? 0)}\n\nTAP = continue`, !c.win); }
  return true;
}

// ---------- flow ----------
async function goIdle() { setStep(0); mode = 'idle'; await show(idleScreen()); }
async function submitThesis(text: string) {
  mode = 'info'; (document.getElementById('pmin') as HTMLInputElement).value = text;
  setStep(1); $('pmres').innerHTML = typingHtml();
  await show('Swarm is arguing\nwith you…');
  const [pm] = await Promise.all([api<PreMortem>('/premortem', post({ text })), new Promise<void>(r => setTimeout(r, 900))]);
  if (pm.error) { log(pm.error, 'bad'); return goIdle(); }
  prop = pm; await loadJournal(); renderPre(pm);
  log(`Pre-mortem [${pm.verdict}]: ${pm.challenges[0]?.text ?? ''}`, pm.verdict === 'RED' ? 'bad' : pm.verdict === 'AMBER' ? 'warn' : 'good');
  mode = pm.side ? 'challenge' : 'idle'; setStep(pm.side ? 2 : 0); await show(challengeScreen(pm), pm.verdict === 'RED');
}
async function nextIdea() {
  mode = 'info'; await show('Swarm debating…');
  const idea = await api<Proposal>(`/proposal?symbol=${SYMBOL}`); prop = idea;
  renderPanel(idea);
  if (idea.side && idea.tilt.length) { mode = 'tilt'; tiltSince = Date.now(); log('Tilt Guard raised: ' + idea.tilt.join(', '), 'warn'); toast('Tilt Guard: are you calm?', 'warn'); await show(tiltScreen(idea), true); }
  else { mode = 'idea'; log('Idea: ' + idea.summary); await show(ideaScreen(idea)); }
}

// The undo window: the order is held for a few seconds, and one tap cancels it.
function startUndo() {
  const p = prop; if (!p?.side) return;
  let n = UNDO_SECONDS; mode = 'undo';
  const tick = async () => {
    if (mode !== 'undo') return; // cancelled
    if (n === 0) return sendOrder(false);
    await show(undoScreen(p, n), true);
    const d = document.getElementById('decide');
    if (d) d.innerHTML = `<button class="btn big red undo" data-k="dbl">${ic('x')} Undo · sending in ${n}s</button><div class="note">Tap, press Esc, or say "undo" to cancel. Nothing has been sent yet.</div><div class="hold"><i style="animation-duration:${UNDO_SECONDS}s"></i></div>`;
    n--; undoTimer = window.setTimeout(tick, 1000);
  };
  void tick();
}
function cancelUndo() {
  clearTimeout(undoTimer); mode = 'info'; setStep(3);
  log('Undone: nothing was sent', 'good'); toast('Undone. Nothing was sent.', 'good');
  const d = document.getElementById('decide'); if (d) d.innerHTML = `<div class="note">Undone. Nothing was sent.</div>`;
  void show('UNDONE\nNothing was sent.\n\nTAP = new trade');
}
async function sendOrder(calm: boolean) {
  const p = prop; if (!p?.side) return nextIdea();
  mode = 'info'; await show('Sending order…');
  const r = await api<OrderResult>('/order', post({ symbol: p.symbol, side: p.side, qty: p.qty, calm, thesis: p.thesis, tags: p.tags, stop: p.stop, target: p.target }));
  if (r.status === 409) { // server-side Tilt Guard fired after the idea was shown: ask for calm instead of dead-ending
    p.tilt = p.tilt?.length ? p.tilt : ['tilt guard on']; mode = 'tilt'; tiltSince = Date.now();
    log('Tilt Guard blocked the order', 'warn'); toast('Tilt Guard blocked the order', 'warn'); return show(tiltScreen(p), true);
  }
  setStep(3);
  log(r.ok ? `FILLED ${p.summary} @ ${r.fillPrice} (${r.mode})` : `BLOCKED: ${r.error}`, r.ok ? 'good' : 'bad');
  toast(r.ok ? `Filled ${p.summary}` : `Blocked: ${r.error}`, r.ok ? 'good' : 'bad');
  const d = document.getElementById('decide'); if (d) d.innerHTML = `<div class="note">${r.ok ? 'Filled' : 'Blocked'}: ${esc(r.ok ? p.summary : r.error ?? '')}. ${r.ok ? 'Watch it under Open position.' : ''}</div>`;
  if (!r.ok) return show(`BLOCKED\n${r.error}\n\nTAP = new trade`);
  await loadJournal(); await refreshPositions();
  mode = 'position'; await show(positionScreen());
}
async function approve(calm: boolean) {
  if (!prop?.side) return nextIdea();
  if (calm) return sendOrder(true); // already confirmed calm: no second countdown
  startUndo();
}
async function onInput(kind: 'click' | 'dbl') {
  if (mode === 'undo') return cancelUndo();
  if (mode === 'position') return closeById(positions[0]?.id ?? '', kind === 'click' ? 0.5 : 1).then(() => undefined);
  if (mode === 'challenge') return kind === 'click' ? approve(false) : (log('Dropped: ' + prop?.thesis, 'good'), toast('Dropped. Good discipline.', 'good'), mode = 'info', setStep(3), show('Dropped.\nGood discipline.\n\nTAP = new trade'));
  if (mode === 'idle') { if (kind === 'click') return nextIdea(); if (positions.length) { mode = 'position'; return show(positionScreen()); } return; }
  if (mode === 'idea') return kind === 'click' ? approve(false) : (log('Vetoed ' + prop?.summary, 'bad'), toast('Vetoed', 'bad'), mode = 'info', show('Vetoed.\n\nTAP = new trade'));
  if (mode === 'tilt') {
    if (kind === 'dbl') { log('Skipped trade under tilt', 'good'); toast('Good call, skipped', 'good'); mode = 'info'; return show('Skipped. Good call.\n\nTAP = new trade'); }
    if (Date.now() - tiltSince < 3000) return show(tiltScreen(prop!), true);
    return approve(true);
  }
  return goIdle();
}

// ---------- voice ----------
function intent(text: string): 'click' | 'dbl' | null {
  const t = text.toLowerCase();
  if (/\b(not calm|veto|skip|cancel|reject|drop it|drop|no|stop)\b/.test(t)) return 'dbl';
  if (/\b(calm|approve|yes|go|do it|confirm|ok|okay|trade it|trade anyway)\b/.test(t)) return 'click';
  return null;
}
async function heard(text: string) {
  log(`Heard: "${text}"`); toast(`Heard: ${text}`);
  if (mode === 'undo') { if (/\b(undo|cancel|stop|no|wait|abort)\b/i.test(text)) cancelUndo(); return; }
  if (mode === 'tilt') { const k = intent(text); if (k) onInput(k); return; }
  if (mode === 'position') {
    if (/\b(cut|half|reduce|trim)\b/i.test(text)) return onInput('click');
    if (/\b(close|exit|flat|sell it|get out)\b/i.test(text)) return onInput('dbl');
  }
  // "stop 1600" or "target 4%" while a challenge is on screen adds the exit plan and re-runs the pre-mortem
  if (mode === 'challenge' && prop?.thesis && /\b(stop|target|sl|tp)\b/i.test(text) && /\d/.test(text)) return submitThesis(`${prop.thesis}, ${text}`);
  if (mode === 'challenge' || mode === 'idea') { const k = intent(text); if (k && text.trim().split(/\s+/).length <= 4) return onInput(k); }
  submitThesis(text);
}
// Browser mic (preview) via Web Speech API
interface SpeechRec { lang: string; interimResults: boolean; start(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null }
type SpeechCtor = new () => SpeechRec;
function browserVoice() {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!SR) return log('Speech recognition not supported in this browser; use buttons.');
  const r = new SR(); r.lang = 'en-US'; r.interimResults = false;
  const btn = $('micbtn'), b2 = $('micbtn2'); btn.classList.add('on'); b2.classList.add('on'); btn.querySelector('span')!.textContent = 'Listening';
  r.onresult = e => heard(e.results[0]?.[0]?.transcript ?? '');
  r.onend = () => { btn.classList.remove('on'); b2.classList.remove('on'); btn.querySelector('span')!.textContent = 'Speak'; };
  r.start();
}
// Glasses mic: collect PCM for ~3s, send to backend STT
async function glassesVoice() {
  const chunks: Uint8Array[] = [];
  const off = bridge!.onEvenHubEvent(ev => { if (ev.audioEvent) chunks.push(ev.audioEvent.audioPcm); });
  await bridge!.audioControl(true, AudioInputSource.Glasses);
  await new Promise(r => setTimeout(r, 3000));
  await bridge!.audioControl(false); off();
  const total = chunks.reduce((n, c) => n + c.length, 0), buf = new Uint8Array(total);
  let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const r = await api<{ text?: string; error?: string }>('/stt', post({ pcm: btoa(bin) }));
  if (r.text) heard(r.text); else log('Voice not recognised' + (r.error ? ` (${r.error})` : ''));
}

// ---------- wiring ----------
window.addEventListener('keydown', e => {
  if ((e.target as HTMLElement).tagName === 'INPUT') { if (e.key === 'Enter') { const t = (e.target as HTMLInputElement).value.trim(); if (t) heard(t); } return; }
  if (e.code === 'Space') { e.preventDefault(); onInput('click'); }
  else if (e.key === 'Escape') onInput('dbl');
  else if (e.key.toLowerCase() === 'v') browserVoice();
  else if (e.key.toLowerCase() === 'n') nextIdea();
});
document.body.addEventListener('click', async e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-k]'), k = el?.dataset.k;
  if (k === 'click' || k === 'dbl') onInput(k);
  if (k === 'refresh') nextIdea();
  if (k === 'mic') browserVoice();
  if (k === 'voicecalm') { const t = prompt('Type what you would say', 'long ETH, ETF news, stop 2% target 4%'); if (t) heard(t); }
  if (k === 'challenge') { const t = (document.getElementById('pmin') as HTMLInputElement).value.trim(); if (t) heard(t); }
  if (k === 'seed') { await api('/journal/seed', post({})); await loadJournal(); toast('Demo history loaded', 'good'); }
  if ((k === 'cut' || k === 'closepos') && el?.dataset.id) await closeById(el.dataset.id, k === 'cut' ? 0.5 : 1);
  const sg = (e.target as HTMLElement).closest<HTMLElement>('[data-say]')?.dataset.say; if (sg) heard(sg);
  if (k === 'tilt') { await api('/tilt'); nextIdea(); }
});

async function init() {
  try { bridge = await Promise.race([waitForEvenAppBridge(), new Promise<null>(r => setTimeout(() => r(null), 2500))]); }
  catch { bridge = null; }
  const real = !!bridge && 'flutter_inappwebview' in window; if (!real) bridge = null;
  $('bridge').textContent = real ? 'Even bridge connected' : 'browser preview'; log(real ? 'Connected to Even bridge' : 'No Even bridge: browser preview mode');
  if (bridge) {
    const res = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [new TextContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height: 288, containerID: 1,
        containerName: 'main', content: 'SWARMLEASH', isEventCapture: 1 })],
    }));
    if (res !== StartUpPageCreateResult.success) console.warn('startup page failed', res);
    bridge.onEvenHubEvent(ev => {
      if (!(ev.textEvent || ev.sysEvent)) return;
      const t = ev.textEvent?.eventType ?? ev.sysEvent?.eventType;
      // protobuf omits 0, so an event with no type is a CLICK.
      if (t === undefined || t === OsEventTypeList.CLICK_EVENT) onInput('click');
      else if (t === OsEventTypeList.DOUBLE_CLICK_EVENT || t === OsEventTypeList.SCROLL_TOP_EVENT || t === OsEventTypeList.SCROLL_BOTTOM_EVENT) onInput('dbl');
      else if (t === OsEventTypeList.LONG_PRESS_EVENT) glassesVoice(); // long-press = speak
    });
  }
  await refreshPositions();
  await goIdle();
  api<Proposal>('/proposal?symbol=' + SYMBOL + '&quiet=1').then(renderPanel).catch(() => {});
  await loadJournal(); setInterval(loadJournal, 15000);
  setInterval(refreshPositions, 3000);
  const demo = new URLSearchParams(location.search).get('thesis'); if (demo) heard(demo); // handy for demos and tests
  setInterval(() => { if (mode === 'tilt' && prop) show(tiltScreen(prop), true); }, 1000);
}
init();
