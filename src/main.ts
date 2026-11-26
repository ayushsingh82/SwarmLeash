// Swarmleash glasses app (Even G2): shows the swarm's idea on the lens, tap to trade, double-tap to veto.
import {
  waitForEvenAppBridge, StartUpPageCreateResult, OsEventTypeList,
  TextContainerProperty, TextContainerUpgrade, CreateStartUpPageContainer,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import type { OrderResult, Pair, Proposal } from './types.ts';

const SYMBOL: Pair = 'ETHUSDT';
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''; // backend URL for the packed app
const api = async <T = unknown>(p: string, init?: RequestInit): Promise<T> => (await fetch(BASE + '/api' + p, init)).json() as Promise<T>;
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const mark = (v: number): string => (v > 0 ? '+' : v < 0 ? '-' : '0');

let bridge: EvenAppBridge | null = null;
let idea: Proposal | null = null;

async function show(text: string): Promise<void> {
  if (bridge) await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: text }));
}

function ideaScreen(p: Proposal): string {
  if (!p.side) return `SWARMLEASH\n${p.summary}\n\nTAP = new idea`;
  const a = Object.fromEntries(p.agents.map(x => [x.name, x.vote]));
  return `${p.summary}  @${p.price.toFixed(0)}\n` +
    `Trend ${mark(a.Trend ?? 0)}  Mom ${mark(a.Momentum ?? 0)}\n` +
    `Fund ${mark(a.Funding ?? 0)}  Risk ${a.Risk ? 'ok' : 'HIGH'}\n` +
    `${p.agree}/3 agree  conf ${p.conf}%  [${p.mode}]\n\n` +
    `TAP = GO    2xTAP = VETO`;
}

async function nextIdea(): Promise<void> {
  await show('Asking the swarm...');
  idea = await api<Proposal>('/proposal?symbol=' + SYMBOL + '&quiet=1');
  await show(ideaScreen(idea));
}

async function approve(): Promise<void> {
  if (!idea?.side) return nextIdea();
  const r = await api<OrderResult>('/order', post({ symbol: idea.symbol, side: idea.side, qty: idea.qty }));
  idea = null;
  await show(r.status === 409 ? 'TILT GUARD\n' + (r.error ?? 'Slow down') + '\n\nTAP = new idea'
    : r.ok ? `Sent ${r.mode}\nfill ${r.fillPrice}\n\nTAP = new idea` : `Failed\n${r.error ?? r.msg ?? ''}\n\nTAP = new idea`);
}

async function onInput(kind: 'click' | 'dbl'): Promise<void> {
  if (idea?.side) return kind === 'click' ? approve() : (idea = null, show('Vetoed.\n\nTAP = new idea'));
  return nextIdea();
}

async function init(): Promise<void> {
  try { bridge = await Promise.race([waitForEvenAppBridge(), new Promise<null>(r => setTimeout(() => r(null), 2500))]); }
  catch { bridge = null; }
  if (!bridge || !('flutter_inappwebview' in window)) { bridge = null; console.log('No Even bridge: browser preview'); return; }
  const res = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height: 288, containerID: 1,
      containerName: 'main', content: 'SWARMLEASH\n\nTAP = swarm idea', isEventCapture: 1 })],
  }));
  if (res !== StartUpPageCreateResult.success) console.warn('startup page failed', res);
  bridge.onEvenHubEvent(ev => {
    if (!(ev.textEvent || ev.sysEvent)) return;
    const t = ev.textEvent?.eventType ?? ev.sysEvent?.eventType;
    // protobuf omits 0, so an event with no type is a CLICK.
    if (t === undefined || t === OsEventTypeList.CLICK_EVENT) void onInput('click');
    else if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) void onInput('dbl');
  });
}
void init();
