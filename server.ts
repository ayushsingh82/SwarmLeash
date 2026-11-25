// Swarmleash backend: Bybit testnet market data, a four-agent swarm, Tilt Guard, a trading journal, the pre-mortem, cross-venue funding, exit plans, positions with P&L and guarded orders over a small JSON API.
// Keys live here (env), never in the glasses app. Testnet/paper only.
// Run with: node server.ts  (Node 22.18+ strips the types natively)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AgentVote, Challenge, EdgeReport, ExitReason, JournalEntry, JournalResponse, Mode, OrderRequest, OrderResult, Pair, Position, PositionsResponse, PreMortem, Proposal, Side, Support, TagStat, Verdict, VenueRate } from './src/types.ts';

// ---------- env ----------
try {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2] ?? '';
  }
} catch { /* no .env is fine */ }

const PORT = Number(process.env.PORT) || 8787;
const BYBIT = 'https://api-testnet.bybit.com';
const KEY = process.env.BYBIT_TESTNET_KEY;
const SECRET = process.env.BYBIT_TESTNET_SECRET;
const LIVE_ORDERS = Boolean(KEY && SECRET);
const MODE: Mode = LIVE_ORDERS ? 'testnet' : 'paper';
const MAX_QTY: Record<Pair, number> = { ETHUSDT: 0.5, BTCUSDT: 0.01, SOLUSDT: 5 }; // hard size cap
const PAIRS = Object.keys(MAX_QTY) as Pair[];
const isPair = (s: unknown): s is Pair => typeof s === 'string' && (PAIRS as string[]).includes(s);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await fetch(url, init)).json() as Promise<T>;
}

interface Candle { h: number; l: number; c: number }
interface Market { closes: number[]; candles: Candle[]; price: number; funding: number; venues: VenueRate[] }

// ---------- indicators ----------
const ema = (a: number[], n: number): number => { const k = 2 / (n + 1); return a.reduce((p, v, i) => (i ? v * k + p * (1 - k) : v)); };
function rsi(c: number[], n = 14): number {
  let g = 0, l = 0;
  for (let i = c.length - n; i < c.length; i++) { const d = (c[i] ?? 0) - (c[i - 1] ?? 0); if (d >= 0) g += d; else l -= d; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function indicators(m: Market) {
  const { closes, candles, price } = m;
  return { fast: ema(closes.slice(-30), 9), slow: ema(closes, 21), rsi: rsi(closes),
    atrPct: candles.slice(-14).reduce((s, c) => s + (c.h - c.l), 0) / 14 / price * 100 };
}

// ---------- Bybit testnet market data ----------
async function market(symbol: Pair): Promise<Market> {
  const [k, t] = await Promise.all([
    getJson<{ result: { list: string[][] } }>(`${BYBIT}/v5/market/kline?category=linear&symbol=${symbol}&interval=5&limit=60`),
    getJson<{ result: { list: { lastPrice: string; fundingRate: string }[] } }>(`${BYBIT}/v5/market/tickers?category=linear&symbol=${symbol}`),
  ]);
  const candles: Candle[] = k.result.list.map(x => ({ h: Number(x[2]), l: Number(x[3]), c: Number(x[4]) })).reverse();
  const tk = t.result.list[0];
  if (!tk) throw new Error('no ticker for ' + symbol);
  const funding = Number(tk.fundingRate);
  return { closes: candles.map(x => x.c), candles, price: Number(tk.lastPrice), funding, venues: await venueFunding(symbol, funding) };
}

// ---------- cross-venue funding (public data, no keys) ----------
const HL_COIN: Record<Pair, string> = { ETHUSDT: 'ETH', BTCUSDT: 'BTC', SOLUSDT: 'SOL' };
const venueCache = new Map<string, { ts: number; value: number | null }>();
async function cached(key: string, ttl: number, load: () => Promise<number | null>): Promise<number | null> {
  const hit = venueCache.get(key);
  if (hit && Date.now() - hit.ts < ttl) return hit.value;
  let value: number | null = null;
  try { value = await load(); } catch { value = null; } // a venue being down never breaks a pre-mortem
  venueCache.set(key, { ts: Date.now(), value });
  return value;
}
const hyperliquidRate = (symbol: Pair): Promise<number | null> => cached('hl:' + symbol, 30e3, async () => {
  const [meta, ctxs] = await getJson<[{ universe: { name: string }[] }, { funding: string }[]]>('https://api.hyperliquid.xyz/info', {
    method: 'POST', signal: AbortSignal.timeout(3000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) });
  const i = meta.universe.findIndex(u => u.name === HL_COIN[symbol]);
  const f = i >= 0 ? ctxs[i]?.funding : undefined;
  return f === undefined ? null : Number(f) * 8; // Hyperliquid pays funding hourly
});
const binanceRate = (symbol: Pair): Promise<number | null> => cached('bn:' + symbol, 30e3, async () => {
  const j = await getJson<{ lastFundingRate?: string }>(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, { signal: AbortSignal.timeout(3000) });
  return j.lastFundingRate === undefined ? null : Number(j.lastFundingRate);
});
async function venueFunding(symbol: Pair, bybit: number): Promise<VenueRate[]> {
  const [hl, bn] = await Promise.all([hyperliquidRate(symbol), binanceRate(symbol)]);
  const out: VenueRate[] = [{ venue: 'Bybit', rate8h: bybit }];
  if (hl !== null) out.push({ venue: 'Hyperliquid', rate8h: hl });
  if (bn !== null) out.push({ venue: 'Binance', rate8h: bn });
  return out;
}
const pct3 = (r: number): string => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(3)}%`;
const CROWDED = 0.0001; // above the usual 0.01% per 8h baseline premium

// ---------- swarm second opinion ----------
function runAgents(m: Market): AgentVote[] {
  const { fast, slow, rsi: r, atrPct } = indicators(m);
  const funding = m.venues.reduce((a, v) => a + v.rate8h, 0) / m.venues.length;
  return [
    { name: 'Trend', vote: fast > slow ? 1 : -1, why: `EMA9 ${fast > slow ? 'above' : 'below'} EMA21` },
    { name: 'Momentum', vote: r > 58 ? 1 : r < 42 ? -1 : 0, why: `RSI ${r.toFixed(0)}` },
    { name: 'Funding', vote: funding > CROWDED ? -1 : funding < -CROWDED ? 1 : 0, why: m.venues.map(v => `${v.venue} ${pct3(v.rate8h)}`).join(' · ') },
    { name: 'Risk', vote: atrPct > 0.35 ? 0 : 1, why: `vol ${atrPct.toFixed(2)}%`, atrPct },
  ];
}

function propose(symbol: Pair, m: Market): Omit<Proposal, 'tilt' | 'mode'> {
  const agents = runAgents(m);
  const voters = agents.slice(0, 3);
  const dir = voters.reduce((s, a) => s + a.vote, 0);
  const side: Side | null = dir > 0 ? 'Buy' : dir < 0 ? 'Sell' : null;
  const risk = agents[3] as AgentVote;
  const agree = side ? voters.filter(a => a.vote === (dir > 0 ? 1 : -1)).length : 0;
  const conf = Math.round((agree / 3) * 100 * (risk.vote ? 1 : 0.6));
  const cap = MAX_QTY[symbol];
  const qty = +(cap * (risk.vote ? 0.6 : 0.3)).toFixed(4); // risk agent sizes down
  return { symbol, side, qty, price: m.price, series: m.closes.slice(-60), agents, venues: m.venues, agree, conf, ts: Date.now(),
    summary: side ? `${side === 'Buy' ? 'LONG' : 'SHORT'} ${symbol.replace('USDT', '')} ${qty}` : 'No trade: swarm split' };
}

// ---------- Tilt Guard ----------
function tilt(m: Market): string[] {
  const recent = state.orders.filter(o => Date.now() - o.ts < 5 * 60e3);
  const e = state.lastEntry;
  const lostLast = e !== null && ((e.side === 'Buy' && m.price < e.price) || (e.side === 'Sell' && m.price > e.price));
  const reasons: string[] = [];
  if (recent.length >= 3) reasons.push(`${recent.length} orders in 5 min`);
  if (e && lostLast && Date.now() - e.ts < 3 * 60e3) reasons.push('last trade is red');
  if (state.tiltForced) reasons.push('demo tilt');
  return reasons;
}

// ---------- journal ----------
const JOURNAL_FILE = 'journal.json';
let journal: JournalEntry[] = [];
try { journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')) as JournalEntry[]; } catch { /* first run */ }
const saveJournal = (): void => { try { fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 1)); } catch { /* read-only fs */ } };

function record(tag: string, side?: Side | null): TagStat {
  const rows = journal.filter(e => e.status === 'closed' && e.tags.includes(tag) && (!side || e.side === side));
  return { tag, n: rows.length, wins: rows.filter(e => e.win).length };
}
function journalStats(): TagStat[] {
  const by: Record<string, TagStat> = {};
  for (const e of journal.filter(x => x.status === 'closed')) {
    for (const t of e.tags) { const s = (by[t] ??= { tag: t, n: 0, wins: 0 }); s.n++; if (e.win) s.wins++; }
  }
  return Object.values(by).sort((a, b) => b.n - a.n);
}
// ---------- positions: open trades marked to market, closed for real P&L ----------
const priceCache = new Map<Pair, { ts: number; px: number }>();
async function markPrice(symbol: Pair): Promise<number> {
  const hit = priceCache.get(symbol);
  if (hit && Date.now() - hit.ts < 1500) return hit.px;
  const t = await getJson<{ result: { list: { lastPrice: string }[] } }>(`${BYBIT}/v5/market/tickers?category=linear&symbol=${symbol}`);
  const px = Number(t.result.list[0]?.lastPrice);
  priceCache.set(symbol, { ts: Date.now(), px });
  return px;
}
function pnlOf(e: JournalEntry, exit: number): { pct: number; usd: number } {
  const dir = e.side === 'Buy' ? 1 : -1;
  return { pct: +(dir * (exit - e.entry) / e.entry * 100).toFixed(2), usd: +(dir * (exit - e.entry) * (e.qty ?? 0)).toFixed(2) };
}
async function closePosition(e: JournalEntry, exit: number, reason: ExitReason, fraction = 1): Promise<JournalEntry> {
  const full = fraction >= 0.999;
  const qty = full ? (e.qty ?? 0) : +((e.qty ?? 0) * fraction).toFixed(6);
  if (LIVE_ORDERS && qty > 0) await bybitOrder({ symbol: e.symbol, side: e.side === 'Buy' ? 'Sell' : 'Buy', qty }, true); // reduce-only exit on the testnet
  const { pct, usd } = pnlOf(e, exit);
  const done: Partial<JournalEntry> = { status: 'closed', exit, pnlPct: pct, pnlUsd: usd, win: pct > 0, exitReason: reason };
  let closed: JournalEntry;
  if (full) { Object.assign(e, done); closed = e; }
  else { closed = { ...e, ...done, id: `${e.id}c${Date.now()}`, qty, status: 'closed' }; e.qty = +((e.qty ?? 0) - qty).toFixed(6); journal.push(closed); }
  saveJournal();
  return closed;
}
async function settleAuto(): Promise<void> { // an open trade that hits its stop or target closes itself
  for (const e of journal.filter(x => x.status === 'open')) {
    const px = await markPrice(e.symbol), buy = e.side === 'Buy';
    if (e.stop !== undefined && (buy ? px <= e.stop : px >= e.stop)) await closePosition(e, e.stop, 'stop');
    else if (e.target !== undefined && (buy ? px >= e.target : px <= e.target)) await closePosition(e, e.target, 'target');
  }
}
async function listPositions(): Promise<PositionsResponse> {
  await settleAuto();
  const positions: Position[] = [];
  for (const e of journal.filter(x => x.status === 'open' && (x.qty ?? 0) > 0)) {
    const mark = await markPrice(e.symbol), { pct, usd } = pnlOf(e, mark);
    positions.push({ id: e.id, symbol: e.symbol, side: e.side, qty: e.qty ?? 0, entry: e.entry, mark, pnlPct: pct, pnlUsd: usd, stop: e.stop, target: e.target, thesis: e.text, tags: e.tags, ts: e.ts });
  }
  return { positions, totalPnlUsd: +positions.reduce((a, p) => a + p.pnlUsd, 0).toFixed(2) };
}
function edgeReport(): EdgeReport {
  const closed = journal.filter(e => e.status === 'closed');
  const wins = closed.filter(e => e.win).length;
  const byTag = journalStats(), rated = byTag.filter(x => x.n >= 2);
  const rate = (x: TagStat): number => x.wins / x.n;
  const best = [...rated].sort((a, b) => rate(b) - rate(a) || b.n - a.n)[0];
  const worst = [...rated].sort((a, b) => rate(a) - rate(b) || b.n - a.n)[0];
  const real = journal.filter(e => !e.seed);
  return { trades: closed.length, wins, winRate: closed.length ? Math.round(wins / closed.length * 100) : 0,
    totalPnlPct: +closed.reduce((a, e) => a + (e.pnlPct ?? 0), 0).toFixed(2), totalPnlUsd: +closed.reduce((a, e) => a + (e.pnlUsd ?? 0), 0).toFixed(2),
    best, worst: worst && worst !== best ? worst : undefined, byTag, realTrades: real.length, withStop: real.filter(e => e.stop !== undefined).length };
}
function edgeText(r: EdgeReport): string {
  if (!r.trades) return 'No closed trades yet. Close a position to start your edge report.';
  const line = (x?: TagStat): string => (x ? `${x.tag} ${x.wins}/${x.n} (${Math.round(x.wins / x.n * 100)}%)` : 'not enough data');
  return `📊 Your edge report\nWin rate ${r.winRate}% (${r.wins}/${r.trades}) · P&L ${r.totalPnlPct >= 0 ? '+' : ''}${r.totalPnlPct}%\n✅ Edge: ${line(r.best)}\n⚠️ Leak: ${line(r.worst)}\n🛡 Trades with a stop: ${r.withStop} of ${r.realTrades}`;
}

function seedJournal(): void { // demo history so the pre-mortem has something to push back with
  const base = Date.now() - 86400e3;
  const mk = (i: number, text: string, side: Side, tags: string[], win: boolean, pnl: number): JournalEntry =>
    ({ id: 'seed' + i, ts: base + i * 3600e3, text, symbol: 'ETHUSDT', side, tags, entry: 0, status: 'closed', win, pnlPct: pnl, seed: true });
  journal = journal.filter(e => !e.seed).concat([
    mk(1, 'long ETH, ETF headline', 'Buy', ['news'], false, -1.4), mk(2, 'long ETH, Fed news', 'Buy', ['news'], false, -0.9),
    mk(3, 'long ETH on the announcement', 'Buy', ['news'], false, -2.1), mk(4, 'long ETH, rumor of listing', 'Buy', ['news'], false, -1.1),
    mk(5, 'long ETH, breakout above resistance', 'Buy', ['breakout'], true, 1.8), mk(6, 'long ETH, clean breakout', 'Buy', ['breakout'], true, 2.2),
    mk(7, 'short ETH, overextended', 'Sell', ['overextended'], true, 1.2), mk(8, 'long ETH, buying the dip', 'Buy', ['dip'], true, 0.8),
    mk(9, 'long ETH, buying the dip', 'Buy', ['dip'], false, -1.0)]);
  saveJournal();
}

// ---------- thesis parsing ----------
interface Level { value: number; pct: boolean }
interface Thesis { side: Side | null; symbol: Pair; tags: string[]; stop?: Level; target?: Level }
const NUM = String.raw`\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(%|percent|k)?`;
const STOP_RE = new RegExp(String.raw`\b(?:stop(?:\s*loss)?|sl|wrong\s+(?:below|above|under|over)|invalidat\w*(?:\s+(?:below|above|under|over))?|out\s+(?:at|below|above))\s*(?:at|is|of|@|:|=)?\s*` + NUM, 'i');
const TARGET_RE = new RegExp(String.raw`\b(?:target|tp|take\s+profit|goal)\s*(?:at|is|of|@|:|=)?\s*` + NUM, 'i');
function level(text: string, re: RegExp): Level | undefined {
  const m = text.match(re);
  if (!m || !m[1]) return undefined;
  let value = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === 'k') value *= 1000;
  return { value, pct: unit === '%' || unit === 'percent' };
}
const TAGS: [string, RegExp][] = [['news', /news|etf|fed|headline|announce|rumou?r|cpi|report|tweet/], ['breakout', /breakout|break out|resistance|ath|all.time/],
  ['dip', /dip|bounce|oversold|cheap|discount/], ['momentum', /momentum|trend|running|pumping|ripping/], ['fomo', /fomo|everyone|missing|can'?t miss|moon/],
  ['revenge', /revenge|win it back|make it back|recover|get back/], ['overextended', /overextended|too high|top|exhausted|overbought/]];

function parseThesis(text: string): Thesis {
  const t = text.toLowerCase();
  const sell = /\b(short|sell|bear|dump|fade|drop)\b/.test(t), buy = /\b(long|buy|bull|pump|ape)\b/.test(t);
  const side: Side | null = sell && !buy ? 'Sell' : buy && !sell ? 'Buy' : sell ? 'Sell' : null;
  const symbol: Pair = /\bbtc|bitcoin\b/.test(t) ? 'BTCUSDT' : /\bsol/.test(t) ? 'SOLUSDT' : 'ETHUSDT';
  const tags = TAGS.filter(([, re]) => re.test(t)).map(([n]) => n);
  if (!tags.length) tags.push('hunch');
  return { side, symbol, tags, stop: level(text, STOP_RE), target: level(text, TARGET_RE) };
}

// ---------- pre-mortem: the devil's advocate ----------
function premortem(text: string, m: Market, tiltReasons: string[], parsed?: Thesis): PreMortem {
  const th = parsed ?? parseThesis(text), ind = indicators(m), cap = MAX_QTY[th.symbol];
  const side = th.side, tag = th.tags[0] ?? 'hunch', hist = record(tag, side);
  const ch: Challenge[] = []; // candidate counter-arguments, strongest wins
  // exit plan: "stop 2% target 4%" or absolute prices
  const price = m.price, dir = side === 'Buy' ? 1 : -1;
  const priceOf = (l: Level | undefined, kind: 'stop' | 'target'): number | undefined =>
    !l ? undefined : l.pct ? +(price * (1 + dir * (kind === 'stop' ? -1 : 1) * l.value / 100)).toFixed(2) : l.value;
  let stop = priceOf(th.stop, 'stop'), target = priceOf(th.target, 'target');
  let wrongSide = false;
  if (side && stop !== undefined && (side === 'Buy' ? stop >= price : stop <= price)) { wrongSide = true; stop = undefined; }
  if (side && target !== undefined && (side === 'Buy' ? target <= price : target >= price)) target = undefined;
  const stopPct = stop !== undefined ? +(Math.abs(price - stop) / price * 100).toFixed(2) : undefined;
  const rr = stop !== undefined && target !== undefined ? +(Math.abs(target - price) / Math.abs(price - stop)).toFixed(1) : undefined;
  if (tiltReasons.length) ch.push({ kind: 'tilt', text: `You are tilting: ${tiltReasons[0]}`, strength: 0.95 });
  if (hist.n >= 2) { const rate = hist.wins / hist.n; ch.push({ kind: 'history', text: `Your ${hist.n} ${tag} trades: ${hist.wins} won`, strength: hist.n >= 3 ? Math.min(1, 0.35 + (1 - rate) * 0.65) : 0.3 * (1 - rate) }); }
  const crowdedLong = m.venues.filter(v => v.rate8h > CROWDED).length, crowdedShort = m.venues.filter(v => v.rate8h < -CROWDED).length, nv = m.venues.length;
  if (side === 'Buy' && crowdedLong) ch.push({ kind: 'funding', text: `Crowded long on ${crowdedLong} of ${nv} venues`, strength: Math.min(0.85, 0.6 + 0.1 * (crowdedLong - 1)) });
  if (side === 'Sell' && crowdedShort) ch.push({ kind: 'funding', text: `Crowded short on ${crowdedShort} of ${nv} venues`, strength: Math.min(0.85, 0.6 + 0.1 * (crowdedShort - 1)) });
  if (side === 'Buy' && ind.fast < ind.slow) ch.push({ kind: 'trend', text: 'Trend is down (EMA9 < EMA21)', strength: 0.6 });
  if (side === 'Sell' && ind.fast > ind.slow) ch.push({ kind: 'trend', text: 'Trend is up (EMA9 > EMA21)', strength: 0.6 });
  if (side === 'Buy' && ind.rsi > 70) ch.push({ kind: 'rsi', text: `Overbought, RSI ${ind.rsi.toFixed(0)}`, strength: 0.65 });
  if (side === 'Sell' && ind.rsi < 30) ch.push({ kind: 'rsi', text: `Oversold, RSI ${ind.rsi.toFixed(0)}`, strength: 0.65 });
  if (ind.atrPct > 0.35) ch.push({ kind: 'vol', text: `Wild market, vol ${ind.atrPct.toFixed(2)}%`, strength: 0.5 });
  if (['fomo', 'revenge'].includes(tag)) ch.push({ kind: 'bias', text: `"${tag}" is a bias, not a reason`, strength: 0.75 });
  if (side) {
    if (wrongSide) ch.push({ kind: 'plan', text: 'Your stop is on the wrong side of entry', strength: 0.8 });
    else if (stop === undefined) ch.push({ kind: 'nostop', text: 'No stop: where are you wrong?', strength: 0.5 });
    if (stopPct !== undefined && stopPct < ind.atrPct * 3) ch.push({ kind: 'plan', text: `Stop is inside the noise (${stopPct}% vs vol ${ind.atrPct.toFixed(2)}%)`, strength: 0.55 });
    if (stopPct !== undefined && stopPct > 5) ch.push({ kind: 'plan', text: `Stop is wide (${stopPct}%): one loss hurts`, strength: 0.45 });
    if (rr !== undefined && rr < 1) ch.push({ kind: 'plan', text: `Reward is ${rr}R: smaller than the risk`, strength: 0.55 });
  }
  const pro: Support[] = []; // evidence that agrees with the trade, so the debate is two-sided
  if (rr !== undefined && rr >= 2) pro.push({ kind: 'plan', text: `Good plan: ${rr}R reward for 1R risk` });
  else if (stop !== undefined && stopPct !== undefined && stopPct >= ind.atrPct * 3) pro.push({ kind: 'plan', text: `You know where you are wrong (stop ${stop})` });
  if (side === 'Buy' && ind.fast > ind.slow) pro.push({ kind: 'trend', text: 'Trend agrees (EMA9 > EMA21)' });
  if (side === 'Sell' && ind.fast < ind.slow) pro.push({ kind: 'trend', text: 'Trend agrees (EMA9 < EMA21)' });
  if (hist.n >= 2 && hist.wins / hist.n >= 0.66) pro.push({ kind: 'history', text: `Your ${hist.n} ${tag} trades: ${hist.wins} won` });
  if (side === 'Buy' && crowdedShort) pro.push({ kind: 'funding', text: `Shorts are crowded on ${crowdedShort} of ${nv} venues` });
  if (side === 'Sell' && crowdedLong) pro.push({ kind: 'funding', text: `Longs are crowded on ${crowdedLong} of ${nv} venues` });
  if (ind.atrPct <= 0.2) pro.push({ kind: 'vol', text: `Calm market, vol ${ind.atrPct.toFixed(2)}%` });
  ch.sort((a, b) => b.strength - a.strength);
  if (!ch.length) ch.push({ kind: 'none', text: 'No red flags found', strength: 0 });
  const top = ch[0]?.strength ?? 0;
  const verdict: Verdict = top >= 0.7 ? 'RED' : top >= 0.4 ? 'AMBER' : 'GREEN';
  const qty = +(cap * (verdict === 'RED' ? 0.3 : 0.6)).toFixed(4);
  return { thesis: text, symbol: th.symbol, side, tags: th.tags, qty, price: m.price, challenges: ch.slice(0, 3), support: pro.slice(0, 2), verdict, stop, target, stopPct, rr,
    venues: m.venues, history: hist, tilt: tiltReasons, series: m.closes.slice(-60), mode: MODE, ts: Date.now(),
    summary: side ? `${side === 'Buy' ? 'LONG' : 'SHORT'} ${th.symbol.replace('USDT', '')} ${qty}` : 'Say long or short' };
}

// ---------- guarded orders ----------
interface Entry { side: Side; price: number; ts: number }
const state: { orders: (OrderRequest & { ts: number })[]; lastEntry: Entry | null; tiltForced: boolean } = { orders: [], lastEntry: null, tiltForced: false };

async function bybitOrder(o: Pick<OrderRequest, 'symbol' | 'side' | 'qty'>, reduceOnly = false): Promise<{ retCode: number; retMsg: string }> {
  if (!KEY || !SECRET) throw new Error('Bybit keys not set');
  const body = JSON.stringify({ category: 'linear', symbol: o.symbol, side: o.side, orderType: 'Market', qty: String(o.qty), ...(reduceOnly ? { reduceOnly: true } : {}) });
  const ts = String(Date.now()), rw = '5000';
  const sig = crypto.createHmac('sha256', SECRET).update(ts + KEY + rw + body).digest('hex');
  return getJson(`${BYBIT}/v5/order/create`, { method: 'POST', body, headers: {
    'Content-Type': 'application/json', 'X-BAPI-API-KEY': KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw, 'X-BAPI-SIGN': sig } });
}

async function executeOrder(o: OrderRequest): Promise<OrderResult> {
  if (!isPair(o.symbol)) return { ok: false, status: 400, error: 'unknown symbol' };
  const cap = MAX_QTY[o.symbol];
  if (!['Buy', 'Sell'].includes(o.side) || !(o.qty > 0) || o.qty > cap) return { ok: false, status: 400, error: `size cap ${cap}` };
  const m = await market(o.symbol);
  if (tilt(m).length && !o.calm) return { ok: false, status: 409, error: 'tilt guard: confirm calm' };
  const r = LIVE_ORDERS ? await bybitOrder(o) : { retCode: 0, retMsg: 'paper fill' };
  state.orders.push({ ts: Date.now(), ...o }); state.lastEntry = { side: o.side, price: m.price, ts: Date.now() };
  state.tiltForced = false;
  const sl = num(o.stop), tp = num(o.target);
  const stop = sl !== undefined && (o.side === 'Buy' ? sl < m.price : sl > m.price) ? sl : undefined;
  const target = tp !== undefined && (o.side === 'Buy' ? tp > m.price : tp < m.price) ? tp : undefined;
  journal.push({ id: 'j' + Date.now(), ts: Date.now(), text: o.thesis || 'swarm idea', symbol: o.symbol, side: o.side, qty: o.qty, tags: o.tags?.length ? o.tags : ['swarm'], entry: m.price, status: 'open', stop, target });
  saveJournal();
  return { ok: r.retCode === 0, mode: MODE, fillPrice: m.price, msg: r.retMsg };
}

// ---------- HTTP API ----------
async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  let s = '';
  for await (const c of req) s += c;
  return (s ? JSON.parse(s) : {}) as T;
}
const send = (res: http.ServerResponse, code: number, obj: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' });
  res.end(JSON.stringify(obj));
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/api/proposal') { // the swarm's second opinion on the market right now
      const q = url.searchParams.get('symbol');
      const symbol: Pair = isPair(q) ? q : 'ETHUSDT';
      const m = await market(symbol);
      return send(res, 200, { ...propose(symbol, m), tilt: tilt(m), mode: MODE } satisfies Proposal);
    }
    if (url.pathname === '/api/order' && req.method === 'POST') {
      const r = await executeOrder(await readJson<OrderRequest>(req));
      return send(res, r.status || 200, r);
    }
    if (url.pathname === '/api/premortem' && req.method === 'POST') {
      const { text } = await readJson<{ text?: string }>(req);
      if (!text || text.length > 300) return send(res, 400, { error: 'say your trade' });
      const th = parseThesis(text), m = await market(th.symbol); await settleAuto();
      return send(res, 200, premortem(text, m, tilt(m), th));
    }
    if (url.pathname === '/api/positions') return send(res, 200, await listPositions());
    if (url.pathname === '/api/position/close' && req.method === 'POST') {
      const { id, fraction } = await readJson<{ id?: string; fraction?: number }>(req);
      const e = journal.find(j => j.id === id && j.status === 'open');
      if (!e) return send(res, 404, { ok: false, error: 'no such open position' });
      const f = typeof fraction === 'number' && fraction > 0 && fraction <= 1 ? fraction : 1;
      const closed = await closePosition(e, await markPrice(e.symbol), f < 0.999 ? 'cut' : 'manual', f);
      return send(res, 200, { ok: true, closed });
    }
    if (url.pathname === '/api/edge') return send(res, 200, edgeReport());
    if (url.pathname === '/api/status') return send(res, 200, { bybit: LIVE_ORDERS, orders5m: state.orders.filter(o => Date.now() - o.ts < 3e5).length });
    if (url.pathname === '/api/journal') {
      await settleAuto();
      return send(res, 200, { entries: journal.slice(-30).reverse(), stats: journalStats() } satisfies JournalResponse);
    }
    if (url.pathname === '/api/journal/seed' && req.method === 'POST') { seedJournal(); return send(res, 200, { ok: true, stats: journalStats() }); }
    if (url.pathname === '/api/tilt') { state.tiltForced = true; return send(res, 200, { ok: true }); } // demo helper
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: errMsg(e) }); }
}).listen(PORT, () => console.log(`swarmleash backend :${PORT} (${LIVE_ORDERS ? 'Bybit testnet orders' : 'paper orders'})`));
