// Swarmleash backend: Bybit testnet market data, a four-agent swarm, Tilt Guard, a trading journal and guarded orders over a small JSON API.
// Keys live here (env), never in the glasses app. Testnet/paper only.
// Run with: node server.ts  (Node 22.18+ strips the types natively)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AgentVote, JournalEntry, JournalResponse, Mode, OrderRequest, OrderResult, Pair, Proposal, Side, TagStat } from './src/types.ts';

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

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await fetch(url, init)).json() as Promise<T>;
}

interface Candle { h: number; l: number; c: number }
interface Market { closes: number[]; candles: Candle[]; price: number; funding: number }

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
  return { closes: candles.map(x => x.c), candles, price: Number(tk.lastPrice), funding: Number(tk.fundingRate) };
}

// ---------- swarm second opinion ----------
function runAgents(m: Market): AgentVote[] {
  const { fast, slow, rsi: r, atrPct } = indicators(m);
  const { funding } = m;
  return [
    { name: 'Trend', vote: fast > slow ? 1 : -1, why: `EMA9 ${fast > slow ? 'above' : 'below'} EMA21` },
    { name: 'Momentum', vote: r > 58 ? 1 : r < 42 ? -1 : 0, why: `RSI ${r.toFixed(0)}` },
    { name: 'Funding', vote: funding > 0.0003 ? -1 : funding < -0.0003 ? 1 : 0, why: `funding ${(funding * 100).toFixed(3)}% (contrarian)` },
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
  return { symbol, side, qty, price: m.price, series: m.closes.slice(-60), agents, agree, conf, ts: Date.now(),
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

function journalStats(): TagStat[] {
  const by: Record<string, TagStat> = {};
  for (const e of journal.filter(x => x.status === 'closed')) {
    for (const t of e.tags) { const s = (by[t] ??= { tag: t, n: 0, wins: 0 }); s.n++; if (e.win) s.wins++; }
  }
  return Object.values(by).sort((a, b) => b.n - a.n);
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

// ---------- guarded orders ----------
interface Entry { side: Side; price: number; ts: number }
const state: { orders: (OrderRequest & { ts: number })[]; lastEntry: Entry | null; tiltForced: boolean } = { orders: [], lastEntry: null, tiltForced: false };

async function bybitOrder(o: Pick<OrderRequest, 'symbol' | 'side' | 'qty'>): Promise<{ retCode: number; retMsg: string }> {
  if (!KEY || !SECRET) throw new Error('Bybit keys not set');
  const body = JSON.stringify({ category: 'linear', symbol: o.symbol, side: o.side, orderType: 'Market', qty: String(o.qty) });
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
  journal.push({ id: 'j' + Date.now(), ts: Date.now(), text: o.thesis || 'swarm idea', symbol: o.symbol, side: o.side, qty: o.qty, tags: o.tags?.length ? o.tags : ['swarm'], entry: m.price, status: 'open' });
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
    if (url.pathname === '/api/journal') return send(res, 200, { entries: journal.slice(-30).reverse(), stats: journalStats() } satisfies JournalResponse);
    if (url.pathname === '/api/journal/seed' && req.method === 'POST') { seedJournal(); return send(res, 200, { ok: true, stats: journalStats() }); }
    if (url.pathname === '/api/tilt') { state.tiltForced = true; return send(res, 200, { ok: true }); } // demo helper
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: errMsg(e) }); }
}).listen(PORT, () => console.log(`swarmleash backend :${PORT} (${LIVE_ORDERS ? 'Bybit testnet orders' : 'paper orders'})`));
