// Swarmleash backend: Bybit testnet market data over a small JSON API.
// Keys live here (env), never in the glasses app. Testnet/paper only.
// Run with: node server.ts  (Node 22.18+ strips the types natively)
import http from 'node:http';
import fs from 'node:fs';
import type { Pair } from './src/types.ts';

// ---------- env ----------
try {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2] ?? '';
  }
} catch { /* no .env is fine */ }

const PORT = Number(process.env.PORT) || 8787;
const BYBIT = 'https://api-testnet.bybit.com';
const PAIRS: Pair[] = ['ETHUSDT', 'BTCUSDT', 'SOLUSDT'];
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

// ---------- HTTP API ----------
const send = (res: http.ServerResponse, code: number, obj: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' });
  res.end(JSON.stringify(obj));
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/api/proposal') { // market snapshot; the swarm agents arrive in a later commit
      const q = url.searchParams.get('symbol');
      const symbol: Pair = isPair(q) ? q : 'ETHUSDT';
      const m = await market(symbol);
      return send(res, 200, { symbol, price: m.price, funding: m.funding, series: m.closes.slice(-60), indicators: indicators(m), ts: Date.now() });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: errMsg(e) }); }
}).listen(PORT, () => console.log(`swarmleash backend :${PORT} (Bybit testnet market data)`));
