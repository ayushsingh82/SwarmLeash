// Swarmleash backend: Bybit testnet market data, a four-agent swarm and guarded orders over a small JSON API.
// Keys live here (env), never in the glasses app. Testnet/paper only.
// Run with: node server.ts  (Node 22.18+ strips the types natively)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AgentVote, Mode, OrderRequest, OrderResult, Pair, Proposal, Side } from './src/types.ts';

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

// ---------- guarded orders ----------
const state: { orders: (OrderRequest & { ts: number })[] } = { orders: [] };

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
  const r = LIVE_ORDERS ? await bybitOrder(o) : { retCode: 0, retMsg: 'paper fill' };
  state.orders.push({ ts: Date.now(), ...o });
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
      return send(res, 200, { ...propose(symbol, m), tilt: [], mode: MODE } satisfies Proposal);
    }
    if (url.pathname === '/api/order' && req.method === 'POST') {
      const r = await executeOrder(await readJson<OrderRequest>(req));
      return send(res, r.status || 200, r);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: errMsg(e) }); }
}).listen(PORT, () => console.log(`swarmleash backend :${PORT} (${LIVE_ORDERS ? 'Bybit testnet orders' : 'paper orders'})`));
