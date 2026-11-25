// Second-wind dip-recovery bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// Why this shape: a fresh curve usually either rugs within minutes or
// never moves at all, so chasing launches is mostly paying fees to
// insiders. This bot waits until a curve has already shown it can run —
// its price doubled from where it started — and only then looks for the
// first sane pullback: price 12% to 30% under its peak while buyers are
// coming back in (positive net flow over the last few slots, at least
// three different buyers, the newest trade a buy). The creator is
// allowed small take-profits, but once their total sells reach half a
// SOL the coin is dead to us, for entry and for holding.
//
// Size starts as a 0.05 SOL probe. Exactly one add of 0.10 SOL follows,
// and only when the price has climbed back over the first buy's price
// with inflow still positive — losers stay small, real second winds get
// a little more. Exits are staged on purpose: half the tokens go at
// +15%, the rest follows a tight 10% trail off its best value (or leaves
// whole at +50%); a hard stop at -12% of cost, an outflow exit, a
// creator-dump exit, and a time cap cover the rest. When the main signal
// is quiet, tiny 0.01 SOL probe round trips on liquid curves keep the
// run over the 20-coin / round-trip minimum.
//
// Nothing here depends on the wall clock, on randomness, or on anything
// outside the batches the harness sends, so running it twice gives
// byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Peak price must have reached this multiple of the create price. */
  minRunup: number;
  /** Slots after the CreateEvent before a first buy is allowed. */
  minAge: number;
  /** Lookback (slots) for the buyer-resumption check. */
  flowWindow: number;
  /** Smallest net SOL (buys minus sells) over the flow window. */
  minFlowSol: number;
  /** Smallest count of distinct buyers over the flow window. */
  minFlowBuyers: number;
  /** Require the newest recorded trade to be a buy. */
  lastMustBeBuy: boolean;
  /** No single buyer may own more than this share of window buy SOL. */
  maxBuyerShare: number;
  /** Buy only while price is at most this fraction of the peak price... */
  dipMax: number;
  /** ...and at least this fraction of it (a collapse is not a dip). */
  dipMin: number;
  /** Smallest real SOL a curve must hold right now. */
  minRealSol: number;
  /** Smallest real SOL a curve must have held at its peak. */
  minPeakRealSol: number;
  /** SOL of the opening probe buy. */
  firstSol: number;
  /** SOL of the one follow-on buy. */
  addSol: number;
  /** Largest total SOL in a single position. */
  maxPositionSol: number;
  /** The add needs price this far above the first buy's price. */
  addStep: number;
  /** Smallest buy worth paying a transaction fee for. */
  minBuySol: number;
  /** Slippage allowed on buys, in bps (sells always use 10000). */
  buySlipBps: number;
  /** Sell half the tokens once value reaches cost times (1 + tp1). */
  tp1: number;
  /** Sell the remainder once value reaches cost times (1 + tp2). */
  tp2: number;
  /** Trail on the remainder: sell when value drops this far under its best. */
  trail: number;
  /** Sell everything when value drops to cost times (1 - stopLoss). */
  stopLoss: number;
  /** Lookback (slots) for the outflow exit. */
  fadeWindow: number;
  /** Exit when net SOL over the fade window drops under minus this. */
  fadeNetSol: number;
  /** Longest hold in slots (doubled while the trade is up holdIfUp). */
  maxHold: number;
  /** The hold doubles while the position is up at least this much. */
  holdIfUp: number;
  /** Slots to sit out after an exit before the same curve can re-enter. */
  cooldown: number;
  /** Most entries allowed per curve over the whole run. */
  maxEntries: number;
  /** Most main positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /** Creator sells totalling this much SOL veto the coin. */
  creatorSellVetoSol: number;
  /** Largest total SOL at cost across every open position. */
  maxExposureSol: number;
  /** Pacing targets: coins / fills to reach by the share of paceSecs gone. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minRunup: 2.0,
  minAge: 200,
  flowWindow: 20,
  minFlowSol: 0.02,
  minFlowBuyers: 3,
  lastMustBeBuy: true,
  maxBuyerShare: 0.5,
  dipMax: 0.88,
  dipMin: 0.7,
  minRealSol: 3,
  minPeakRealSol: 5,
  firstSol: 0.05,
  addSol: 0.1,
  maxPositionSol: 0.3,
  addStep: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  tp1: 0.15,
  tp2: 0.5,
  trail: 0.1,
  stopLoss: 0.12,
  fadeWindow: 15,
  fadeNetSol: 0.05,
  maxHold: 800,
  holdIfUp: 0.2,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  creatorSellVetoSol: 0.5,
  maxExposureSol: 3.5,
  targetCoins: 22,
  targetFills: 100,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAM = 1_000_000_000;
const FEE = 0.0125;

interface Rec {
  s: number;
  b: boolean;
  v: number;
  w: string;
  p: number;
}

interface Book {
  born: number | null;
  maker: string | null;
  startPx: number;
  topPx: number;
  topRq: number;
  makerSold: number;
  recs: Rec[];
  tries: number;
  lastOut: number;
}

interface Open {
  since: number;
  best: number;
  spent: number;
  topped: boolean;
  halfOut: boolean;
  leaving: boolean;
  landed: boolean;
  buyPx: number;
  now: number;
}

function pxOf(vq: bigint, vt: bigint): number {
  return vt === 0n ? 0 : Number(vq) / Number(vt);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, Book>();
  const open = new Map<Pubkey, Open>();
  // Probe round trips in flight: false = buy leg outstanding, true = sell leg.
  const sweeps = new Map<Pubkey, boolean>();
  let landed = 0;
  const seenCoins = new Set<Pubkey>();
  let t0: number | null = null;
  let t1: number | null = null;
  const horizon = Math.max(p.flowWindow, p.fadeWindow) + 40;

  const bookFor = (mint: Pubkey): Book => {
    const got = books.get(mint);
    if (got !== undefined) return got;
    const fresh: Book = {
      born: null,
      maker: null,
      startPx: 0,
      topPx: 0,
      topRq: 0,
      makerSold: 0,
      recs: [],
      tries: 0,
      lastOut: -1e12,
    };
    books.set(mint, fresh);
    return fresh;
  };

  // Net SOL over the last `w` slots, walking the tape backwards.
  const netFlow = (bk: Book, now: number, w: number): number => {
    let sum = 0;
    for (let i = bk.recs.length - 1; i >= 0; i--) {
      const r = bk.recs[i]!;
      if (r.s <= now - w) break;
      sum += r.b ? r.v : -r.v;
    }
    return sum;
  };

  // Is this a proven runner sitting in a buyable dip with buyers returning?
  const dipReady = (bk: Book, now: number, px: number, rq: number): boolean => {
    if (bk.makerSold >= p.creatorSellVetoSol) return false;
    if (bk.born === null || now - bk.born < p.minAge) return false;
    if (bk.startPx <= 0 || bk.topPx < bk.startPx * p.minRunup) return false;
    if (bk.topRq < p.minPeakRealSol || rq < p.minRealSol) return false;
    const ratio = px / bk.topPx;
    if (ratio > p.dipMax || ratio < p.dipMin) return false;
    const edge = now - p.flowWindow;
    let bought = 0;
    let net = 0;
    let n = 0;
    let freshBuy = false;
    const wallets = new Map<string, number>();
    for (const r of bk.recs) {
      if (r.s <= edge) continue;
      if (r.b) {
        bought += r.v;
        n++;
        wallets.set(r.w, (wallets.get(r.w) ?? 0) + r.v);
      }
      net += r.b ? r.v : -r.v;
      freshBuy = r.b;
    }
    if (n < p.minFlowBuyers || wallets.size < p.minFlowBuyers) return false;
    if (net < p.minFlowSol) return false;
    if (p.lastMustBeBuy && !freshBuy) return false;
    let biggest = 0;
    for (const v of wallets.values()) if (v > biggest) biggest = v;
    if (bought > 0 && biggest > p.maxBuyerShare * bought) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched = new Set<Pubkey>();
      for (const fill of batch.fills) {
        if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
          landed++;
          seenCoins.add(fill.mint);
        }
      }
      for (const ev of batch.events) {
        if (ev.block_time !== null) {
          if (t0 === null) t0 = ev.block_time;
          if (t1 === null || ev.block_time > t1) t1 = ev.block_time;
        }
        if (ev.event === 'CreateEvent') {
          const bk = bookFor(ev.mint);
          bk.born = ev.slot;
          bk.maker = ev.creator;
          bk.startPx = pxOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
          bk.topPx = bk.startPx;
        } else if (ev.event === 'TradeEvent') {
          const bk = bookFor(ev.mint);
          const sol = Number(ev.sol_amount) / LAM;
          const px = pxOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
          if (bk.startPx <= 0) bk.startPx = px;
          if (px > bk.topPx) bk.topPx = px;
          const rq = Number(ev.real_quote_reserves) / LAM;
          if (rq > bk.topRq) bk.topRq = rq;
          if (bk.maker !== null && ev.user === bk.maker && !ev.is_buy) bk.makerSold += sol;
          bk.recs.push({ s: ev.slot, b: ev.is_buy, v: sol, w: ev.user, p: px });
          touched.add(ev.mint);
        }
      }
      for (const mint of touched) {
        const bk = books.get(mint)!;
        let drop = 0;
        while (drop < bk.recs.length && bk.recs[drop]!.s <= now - horizon) drop++;
        if (drop > 0) bk.recs.splice(0, drop);
      }
      const byMint = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const inFlight = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        inFlight.set(po.order.mint, (inFlight.get(po.order.mint) ?? 0) + 1);
      }

      const out: OrderInput[] = [];
      const room = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAM;

      const worth = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return 0;
        const mk = byMint.get(mint);
        const vq = mk === undefined ? Number(curve.virtual_quote_reserves) : Number(mk.virtual_quote_reserves);
        const vt = mk === undefined ? Number(curve.virtual_token_reserves) : Number(mk.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        return ((tokens * vq) / (vt + tokens) / LAM) * (1 - FEE) - tx;
      };

      // Exits before entries, so a batch never buys a coin it is leaving.
      for (const [mint, o] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!inFlight.has(mint)) {
            open.delete(mint);
            const bk = bookFor(mint);
            if (o.landed) bk.lastOut = now;
            else bk.tries--;
          }
          continue;
        }
        o.landed = true;
        if (curve === undefined || curve.complete) continue;
        const val = worth(mint);
        const cost = Number(pos.cost_lamports) / LAM;
        if (val > o.best) o.best = val;
        o.now = val;
        const bk = bookFor(mint);
        let leave = o.leaving;
        if (!leave && bk.makerSold >= p.creatorSellVetoSol) leave = true;
        if (!leave && val < cost * (1 - p.stopLoss)) leave = true;
        if (!leave && o.halfOut && val < o.best * (1 - p.trail)) leave = true;
        if (!leave && o.halfOut && val >= cost * (1 + p.tp2)) leave = true;
        if (!leave && netFlow(bk, now, p.fadeWindow) < -p.fadeNetSol) leave = true;
        const cap = val >= cost * (1 + p.holdIfUp) ? p.maxHold * 2 : p.maxHold;
        if (!leave && now - o.since > cap) leave = true;
        if (leave) {
          o.leaving = true;
          let selling = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') selling = true;
          }
          if (selling) continue;
          if (out.length >= room) break;
          out.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          continue;
        }
        // Staged profit: half the tokens go once the trade is up tp1.
        if (!o.halfOut && val >= cost * (1 + p.tp1) && !inFlight.has(mint)) {
          if (out.length >= room) break;
          const half = BigInt(pos.token_amount) / 2n;
          if (half > 0n) {
            out.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
            o.halfOut = true;
          }
        }
      }

      // Sweep legs: dump the whole probe the moment its buy lands.
      for (const [mint, selling] of sweeps) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!inFlight.has(mint)) sweeps.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || inFlight.has(mint)) continue;
        if (out.length >= room) break;
        out.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) sweeps.set(mint, true);
      }

      // Entries, then the one follow-on buy per position.
      let cash = Number(state.freeCashLamports()) / LAM;
      let openRoom = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainRoom = p.maxMain - open.size;
      let atRisk = 0;
      for (const [mint, o] of open) {
        const heldCost = Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAM;
        atRisk += Math.max(o.spent, heldCost);
      }
      for (const mint of touched) {
        if (out.length >= room) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (inFlight.has(mint) || sweeps.has(mint)) continue;
        const bk = books.get(mint)!;
        const o = open.get(mint);
        const px = pxOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const rq = Number(curve.real_quote_reserves) / LAM;
        let size: number;
        if (o === undefined) {
          if (openRoom <= 0 || mainRoom <= 0) continue;
          if (bk.tries >= p.maxEntries || now - bk.lastOut < p.cooldown) continue;
          if (!dipReady(bk, now, px, rq)) continue;
          size = p.firstSol;
        } else {
          // A single add, only while the price has climbed back over the
          // first buy's price and inflow is still positive.
          if (o.topped || o.leaving || !o.landed || o.spent >= p.maxPositionSol - p.minBuySol) continue;
          if (state.positions.get(mint) === undefined) continue;
          if (px < o.buyPx * (1 + p.addStep)) continue;
          if (netFlow(bk, now, p.flowWindow) < p.minFlowSol) continue;
          if (rq < p.minRealSol) continue;
          size = Math.min(p.addSol, p.maxPositionSol - o.spent);
        }
        const perOrder = Math.floor(Number(state.maxBuyLamports(mint))) / LAM;
        let amount = Math.min(perOrder, size, p.maxExposureSol - atRisk);
        if (amount > cash - tx) amount = cash - tx;
        if (amount < p.minBuySol) continue;
        out.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAM)), max_slippage_bps: p.buySlipBps });
        cash -= amount + tx;
        atRisk += amount;
        if (o === undefined) {
          open.set(mint, {
            since: now,
            best: 0,
            spent: amount,
            topped: false,
            halfOut: false,
            leaving: false,
            landed: false,
            buyPx: px,
            now: 0,
          });
          bk.tries++;
          openRoom--;
          mainRoom--;
        } else {
          o.spent += amount;
          o.topped = true;
        }
      }

      // Pacing: when fills or coins trail the block-time pace, open a tiny
      // probe round trip on a liquid curve until back on pace.
      if (sweeps.size < p.maxProbes && openRoom > 0 && t0 !== null && t1 !== null) {
        const done = Math.min(1, (t1 - t0) / p.paceSecs);
        const shortCoins = seenCoins.size < Math.ceil(p.targetCoins * done);
        const shortFills = landed < Math.ceil(p.targetFills * done);
        if (shortCoins || shortFills) {
          const floor = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (out.length >= room || sweeps.size >= p.maxProbes) break;
            if (open.has(mint) || sweeps.has(mint) || inFlight.has(mint) || state.positions.has(mint)) continue;
            if (shortCoins && !shortFills && seenCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAM < floor * 1.5) continue;
            if (cash < p.probeSol + 2 * tx) break;
            out.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAM)), max_slippage_bps: p.buySlipBps });
            sweeps.set(mint, false);
            cash -= p.probeSol + tx;
          }
        }
      }
      return out;
    },
  };
}
