// Types shared by the backend (server.ts) and the glasses app / web console (src/main.ts).

export type Side = 'Buy' | 'Sell';
export type Pair = 'ETHUSDT' | 'BTCUSDT' | 'SOLUSDT';
export type Verdict = 'RED' | 'AMBER' | 'GREEN';
export type Mode = 'paper' | 'testnet';

/** One swarm agent's vote: 1 long, -1 short, 0 flat. */
export interface AgentVote {
  name: string;
  vote: -1 | 0 | 1;
  why: string;
  atrPct?: number;
}

/** Swarm second opinion. */
export interface Proposal {
  symbol: Pair;
  side: Side | null;
  qty: number;
  price: number;
  series: number[];
  agents: AgentVote[];
  venues?: VenueRate[];
  agree: number;
  conf: number;
  ts: number;
  summary: string;
  tilt: string[];
  mode: Mode;
}

export type ChallengeKind = 'tilt' | 'history' | 'funding' | 'trend' | 'rsi' | 'vol' | 'bias' | 'plan' | 'nostop' | 'none';
export type ExitReason = 'stop' | 'target' | 'manual' | 'cut';

/** Funding rate of one venue, normalised to an 8-hour rate. */
export interface VenueRate {
  venue: string;
  rate8h: number;
}

/** A reason not to take the trade, with how strongly it argues against. */
export interface Challenge {
  kind: ChallengeKind;
  text: string;
  strength: number;
}

/** Evidence that agrees with the trade. */
export interface Support {
  kind: ChallengeKind;
  text: string;
}

export interface TagStat {
  tag: string;
  n: number;
  wins: number;
}

/** The pre-mortem result for one spoken trade. */
export interface PreMortem {
  thesis: string;
  symbol: Pair;
  side: Side | null;
  tags: string[];
  qty: number;
  price: number;
  challenges: Challenge[];
  support: Support[];
  verdict: Verdict;
  /** Exit plan parsed from the thesis ("stop 2% target 4%"). Prices, not percentages. */
  stop?: number;
  target?: number;
  stopPct?: number;
  rr?: number;
  venues: VenueRate[];
  history: TagStat;
  tilt: string[];
  series: number[];
  mode: Mode;
  ts: number;
  summary: string;
  error?: string;
}

export interface JournalEntry {
  id: string;
  ts: number;
  text: string;
  symbol: Pair;
  side: Side;
  qty?: number;
  tags: string[];
  entry: number;
  status: 'open' | 'closed';
  win?: boolean;
  pnlPct?: number;
  pnlUsd?: number;
  exit?: number;
  exitReason?: ExitReason;
  stop?: number;
  target?: number;
  seed?: boolean;
}

/** An open trade marked to the current price. */
export interface Position {
  id: string;
  symbol: Pair;
  side: Side;
  qty: number;
  entry: number;
  mark: number;
  pnlPct: number;
  pnlUsd: number;
  stop?: number;
  target?: number;
  thesis: string;
  tags: string[];
  ts: number;
}

export interface PositionsResponse {
  positions: Position[];
  totalPnlUsd: number;
}

/** "Where is my edge, where is my leak" summary built from the journal. */
export interface EdgeReport {
  trades: number;
  wins: number;
  winRate: number;
  totalPnlPct: number;
  totalPnlUsd: number;
  best?: TagStat;
  worst?: TagStat;
  byTag: TagStat[];
  realTrades: number;
  withStop: number;
}

export interface JournalResponse {
  entries: JournalEntry[];
  stats: TagStat[];
}

export interface OrderRequest {
  symbol: Pair;
  side: Side;
  qty: number;
  calm?: boolean;
  thesis?: string;
  tags?: string[];
  stop?: number;
  target?: number;
}

export interface OrderResult {
  ok: boolean;
  status?: number;
  error?: string;
  mode?: Mode;
  fillPrice?: number;
  msg?: string;
}
