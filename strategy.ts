// DipRider — a pullback rider for pump.fun bonding curves (agent-fun/replay/v2).
//
// Idea, from studying the dev tape: a fresh coin usually spikes within its first
// couple of slots, so chasing the open buys the top and then mean-reverts. The
// coins that keep going are the ones that already proved demand (price at least
// doubled from create, at least 5 unrelated wallets bought in, creator has not
// sold) and then give some of the spike back. This bot waits for that 20%
// give-back off the peak and rides the next leg, with a tight stop and a
// trailing exit. Buys use a tight slippage cap: a fill whose price ran away in
// the 2-slot latency is refused rather than bought at the top.
//
// The whole strategy is a pure function of the hello and batch messages the
// harness sends: no clock, no randomness, no network, no environment reads.
// Prices are compared with integer cross-multiplication on the virtual
// reserves, so the two grading runs agree byte for byte.

import {
  BPS,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

/** Tuning knobs, all in lamports / basis points / slots. */
export const PARAMS = {
  /** Buy only once a coin has run up this far from its create price (bps, 10000 = 1x). */
  minPeakRunupBps: 20000,
  /** Buy only after the price has fallen this far below its peak (bps of the peak). */
  pullbackBps: 2000,
  /** ...but only while it still holds at least this much of the create price. */
  minCurrentRunupBps: 10000,
  /** Enter only when the price is no longer falling vs the previous batch. */
  requireStabilised: false,
  /** Distinct non-creator buyers that must have bought before entry. */
  minBuyers: 5,
  /** Lamports aimed for per coin (capped by the 1% of real reserve order cap). */
  stakeLamports: 100_000_000,
  /** Smallest single buy worth a transaction fee (also the round-trip floor). */
  minBuyLamports: 10_000_000,
  /** Take profit: exit once the position is worth this much over its cost. */
  tpBps: 2500,
  /** Stop loss: exit once the position is worth this much under its cost. */
  slBps: 1200,
  /** Trailing stop arms once the position is up this much over cost... */
  trailArmBps: 1500,
  /** ...and then exits on a fall of this much from the best value seen. */
  trailBps: 1000,
  /** Never hold longer than this many slots. */
  maxHoldSlots: 120,
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: 60,
  /** A coin must still be trading recently to be entered. */
  maxQuietSlots: 30,
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAgeSlots: 2000,
  /** Real SOL reserve window at decision time (lamports). */
  minRealSolLamports: 50_000_000,
  maxRealSolLamports: 500_000_000_000,
  /** Slippage allowed on buys / sells (bps). A tight buy slippage refuses fills
      whose price ran away in the 2-slot latency — buying the top is the leak. */
  buySlippageBps: 500,
  sellSlippageBps: 10000,
} as const;

/** Curve fee taken on a sell (protocol 95 bps + creator 30 bps fallback). */
const SELL_FEE_BPS = 125n;

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time virtual reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  buyers: Set<Pubkey>;
  devSold: boolean;
  lastTradeSlot: number;
  /** Highest run-up (bps vs create price) seen so far. */
  peakRunupBps: bigint;
  /** Run-up as of the latest batch. */
  lastRunupBps: bigint;
  /** Run-up as of the previous batch (for the stabilisation check). */
  prevRunupBps: bigint;
  /** A buy was already sent for this coin; never buy it twice. */
  bought: boolean;
  /** Never consider this coin again (exited, completed, filtered out for good). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Best sell value (lamports, net of the sell tx fee) seen while holding. */
  bestValue: bigint;
}

/**
 * What selling `tokens` against virtual reserves (vq, vt) would pay after the
 * curve fee, before the transaction fee.
 */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const out = (tokens * vq) / (vt + tokens);
  return out - (out * SELL_FEE_BPS + BPS - 1n) / BPS;
}

/** Current price vs create price, in bps (10000 = same price as at create). */
function runupBps(vq: bigint, vt: bigint, vq0: bigint, vt0: bigint): bigint {
  if (vt <= 0n || vq0 <= 0n) return 0n;
  return (vq * vt0 * BPS) / (vt * vq0);
}

export function createDipRider() {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell already in flight. */
  const selling = new Set<Pubkey>();

  function noteTrade(e: Extract<Batch['events'][number], { event: 'TradeEvent' }>): void {
    const c = coins.get(e.mint);
    if (c === undefined) return;
    c.lastTradeSlot = e.slot;
    if (e.is_buy) {
      if (e.user !== c.creator) c.buyers.add(e.user);
    } else if (e.user === c.creator) {
      c.devSold = true;
    }
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      // Fold this batch's events into the per-coin tape.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            mint: e.mint,
            createSlot: e.slot,
            creator: e.creator,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            buyers: new Set(),
            devSold: false,
            lastTradeSlot: e.slot,
            peakRunupBps: 10000n,
            lastRunupBps: 10000n,
            prevRunupBps: 10000n,
            bought: false,
            done: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          noteTrade(e);
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      // Refresh each coin's peak run-up from the latest reserves.
      for (const c of coins.values()) {
        if (c.done || c.complete) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined) continue;
        const now = runupBps(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          c.vq0,
          c.vt0,
        );
        c.prevRunupBps = c.lastRunupBps;
        c.lastRunupBps = now;
        if (now > c.peakRunupBps) c.peakRunupBps = now;
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // Fills since the last batch: open / close the held book.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.side === 'buy' && f.status === 'filled' && !held.has(f.mint)) {
          held.set(f.mint, { openedSlot: f.slot, bestValue: 0n });
        }
      }
      for (const mint of [...selling]) {
        if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
          held.delete(mint);
        }
      }

      // Exits first: take profit, stop loss, trailing stop, max hold, dev sold, stale.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, bestValue: 0n };
          held.set(mint, h);
        }
        const value =
          sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - tx;
        const basis = pos.cost_lamports;
        if (value > h.bestValue) h.bestValue = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(PARAMS.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(PARAMS.slBps))) exit = true;
          if (
            h.bestValue * BPS >= basis * (BPS + BigInt(PARAMS.trailArmBps)) &&
            value * BPS <= h.bestValue * (BPS - BigInt(PARAMS.trailBps))
          ) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= PARAMS.maxHoldSlots) exit = true;
        if (c !== undefined) {
          if (c.devSold) exit = true;
          if (state.slot - c.lastTradeSlot >= PARAMS.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: PARAMS.sellSlippageBps,
        });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: one buy per coin, only on a qualifying pullback.
      let free = state.freeCashLamports();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.bought) continue;
        const age = state.slot - c.createSlot;
        if (age < 1 || age > PARAMS.maxAgeSlots) {
          if (age > PARAMS.maxAgeSlots) c.done = true;
          continue;
        }
        if (c.devSold) {
          c.done = true;
          continue;
        }
        if (c.buyers.size < PARAMS.minBuyers) continue;
        if (state.slot - c.lastTradeSlot > PARAMS.maxQuietSlots) continue;
        if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(PARAMS.minRealSolLamports) || rq > BigInt(PARAMS.maxRealSolLamports)) continue;
        if (c.peakRunupBps < BigInt(PARAMS.minPeakRunupBps)) continue;
        const now = runupBps(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          c.vq0,
          c.vt0,
        );
        if (now < BigInt(PARAMS.minCurrentRunupBps)) continue;
        // The pullback: price now at least 30% below its peak run-up.
        if (now * BPS > c.peakRunupBps * (BPS - BigInt(PARAMS.pullbackBps))) continue;
        // Stabilisation: do not catch a still-falling knife.
        if (PARAMS.requireStabilised && now < c.prevRunupBps) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const stake = BigInt(PARAMS.stakeLamports);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < BigInt(PARAMS.minBuyLamports)) continue;
        if (free < amount + tx) continue;
        orders.push({
          side: 'buy',
          mint: c.mint,
          quote_lamports: amount,
          max_slippage_bps: PARAMS.buySlippageBps,
        });
        free -= amount + tx;
        c.bought = true;
      }
      return orders;
    },
  };
}
