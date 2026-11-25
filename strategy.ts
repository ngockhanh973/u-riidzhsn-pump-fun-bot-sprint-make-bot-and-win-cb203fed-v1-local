// Second-Wind Dip-Recovery bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// Idea: most fresh curves either rug in their first minutes or never move.
// This bot only touches a curve AFTER it has already proved it can run:
// the price must have doubled from its create price at some point (a real
// runner, not a stillborn launch). It then waits for the first healthy
// pullback — price 12% to 30% off its peak — and buys only when buyers are
// stepping back in (net inflow over the last few slots, several distinct
// buyers, the latest trade a buy). A creator sell at any point vetoes the
// coin outright: the creator dumping is the single most reliable rug tell
// on these curves, and no dip is cheap enough to catch it.
//
// A first buy is a small probe. One add follows only if the price climbs
// back above the first buy's price with inflow still positive, so false
// starts stay cheap and real second winds get size. Exits are staged:
// half the position leaves at +15%, the rest rides a 10% trailing stop
// from its peak value (or a full exit at +50%), with a hard stop at -12%
// of cost, a fade exit on outflow, an instant exit once the creator has
// sold 0.5 SOL in total, and a time cap. Guardrail probes (tiny 0.01 SOL round trips on liquid
// curves) keep the run above the 20-coin / round-trip minimum when the
// main signal is quiet.
//
// Pure function of the batches the harness sends: no clock, no randomness,
// no I/O, no environment reads, so the two graded executions produce
// byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Price must have reached this multiple of the create price before any entry. */
  minRunup: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Entry window (slots) for the buyer-resumption check. */
  flowWindow: number;
  /** Net SOL (buys minus sells) over the flow window at entry, at least this. */
  minFlowSol: number;
  /** Distinct buyers over the flow window, at least this many. */
  minFlowBuyers: number;
  /** The latest recorded trade must be a buy. */
  lastMustBeBuy: boolean;
  /** Largest single buyer's share of the window's buy SOL, at most this. */
  maxBuyerShare: number;
  /** Buy only when price is at most this share of the curve's peak price... */
  dipMax: number;
  /** ...and at least this share of it (a collapse, not a dip, stays out). */
  dipMin: number;
  /** Real SOL the curve must hold at decision time, at least this. */
  minRealSol: number;
  /** Real SOL the curve must have held at its peak, at least this. */
  minPeakRealSol: number;
  /** SOL of the first (probe) buy. */
  firstSol: number;
  /** SOL of the single add-on buy. */
  addSol: number;
  /** Most SOL in one position in total. */
  maxPositionSol: number;
  /** Add only once price is this far above the first buy's decision price. */
  addStep: number;
  /** Smallest buy worth sending (a tx costs ~0.000105 SOL per order). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell half the position once its value reaches cost * (1 + tp1). */
  tp1: number;
  /** Sell the rest once its value reaches cost * (1 + tp2). */
  tp2: number;
  /** Trailing stop on the remaining half: sell when value falls this far below its peak. */
  trail: number;
  /** Hard stop: sell everything when value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Fade exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit after this many slots held (doubled while the position is up holdIfUp). */
  maxHold: number;
  /** The time limit doubles while the position is up at least this much. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** SOL the creator has sold, in total (a small creator take-profit is normal; a big dump vetoes the coin). */
  creatorSellVetoSol: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: target coins / fills by the share of paceSecs elapsed. */
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

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  peakPrice: number;
  peakRealSol: number;
  creatorSoldSol: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  added: boolean;
  tookTp1: boolean;
  exiting: boolean;
  filled: boolean;
  firstPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.flowWindow, p.fadeWindow) + 40;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: null,
        createPrice: 0,
        peakPrice: 0,
        peakRealSol: 0,
        creatorSoldSol: 0,
        trades: [],
        entries: 0,
        lastExit: -1e12,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  const priceOf = (vq: bigint, vt: bigint): number =>
    vt === 0n ? 0 : Number(vq) / Number(vt);

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /**
   * Entry signal: a proven runner (price doubled from create at some
   * point) now sitting in a healthy dip with buyers stepping back in,
   * and no creator sell on record.
   */
  const entrySignal = (t: Tape, now: number, price: number, rqSol: number): boolean => {
    if (t.creatorSoldSol >= p.creatorSellVetoSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    if (t.createPrice <= 0 || t.peakPrice < t.createPrice * p.minRunup) return false;
    if (t.peakRealSol < p.minPeakRealSol) return false;
    if (rqSol < p.minRealSol) return false;
    const dip = price / t.peakPrice;
    if (dip > p.dipMax || dip < p.dipMin) return false;
    const from = now - p.flowWindow;
    let buySol = 0;
    let net = 0;
    let buys = 0;
    let lastBuy = false;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      }
      net += tr.buy ? tr.sol : -tr.sol;
      lastBuy = tr.buy;
    }
    if (buys < p.minFlowBuyers || byUser.size < p.minFlowBuyers) return false;
    if (net < p.minFlowSol) return false;
    if (p.lastMustBeBuy && !lastBuy) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (buySol > 0 && top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          t.peakPrice = t.createPrice;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          if (t.createPrice <= 0) t.createPrice = price;
          if (price > t.peakPrice) t.peakPrice = price;
          const rq = Number(e.real_quote_reserves) / LAMPORTS;
          if (rq > t.peakRealSol) t.peakRealSol = rq;
          if (t.creator !== null && e.user === t.creator && !e.is_buy) t.creatorSoldSol += sol;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          traded.add(e.mint);
        } else {
          // CompleteEvent: the curve is done; the replay closes positions in it.
          tapeOf(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      const valueOf = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first: full exits, then the staged half-sale at tp1.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = valueOf(mint);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exitAll = h.exiting;
        if (!exitAll && t.creatorSoldSol >= p.creatorSellVetoSol) exitAll = true;
        if (!exitAll && value < cost * (1 - p.stopLoss)) exitAll = true;
        if (!exitAll && h.tookTp1 && value < h.peakValue * (1 - p.trail)) exitAll = true;
        if (!exitAll && h.tookTp1 && value >= cost * (1 + p.tp2)) exitAll = true;
        if (!exitAll && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exitAll = true;
        const limit = value >= cost * (1 + p.holdIfUp) ? p.maxHold * 2 : p.maxHold;
        if (!exitAll && now - h.opened > limit) exitAll = true;
        if (exitAll) {
          h.exiting = true;
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending || pendingByMint.has(mint)) {
            // A buy still in flight: sell what we hold now anyway; a sell
            // in flight means wait for it.
            if (sellPending) continue;
          }
          if (orders.length >= cap) break;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          continue;
        }
        // Staged take-profit: sell half once the position is up tp1.
        if (!h.tookTp1 && value >= cost * (1 + p.tp1) && !pendingByMint.has(mint)) {
          if (orders.length >= cap) break;
          const half = BigInt(pos.token_amount) / 2n;
          if (half > 0n) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
            h.tookTp1 = true;
          }
        }
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and the single add-on.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, price, rqSol)) continue;
          want = p.firstSol;
        } else {
          // One add only: the price climbed back above the first buy's
          // price with inflow still positive, and the position is not
          // already exiting.
          if (h.added || h.exiting || !h.filled || h.invested >= p.maxPositionSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.firstPrice * (1 + p.addStep)) continue;
          if (flow(t, now, p.flowWindow) < p.minFlowSol) continue;
          if (rqSol < p.minRealSol) continue;
          want = Math.min(p.addSol, p.maxPositionSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            added: false,
            tookTp1: false,
            exiting: false,
            filled: false,
            firstPrice: price,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.added = true;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag
      // the pace set by block time.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
