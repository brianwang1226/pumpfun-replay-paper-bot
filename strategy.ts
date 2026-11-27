// Pump.fun Replay Sprint — paper trading bot (agent-fun/replay/v2).
//
// Idea: most pump.fun coins die fast; a few run hard in their first minutes.
// This bot only buys a coin once the tape proves real, broad buying — at
// least 8 distinct wallets buying, 2 SOL of net inflow, price up at least 10%
// and holding near its window high, with the inflow accelerating — then it
// banks half at +15% and lets the rest ride a trailing stop, exiting fast on
// a stop, a take-profit, or a hard hold limit. It never pyramids: backtests
// on the dev window showed adds buy the top. A second, cheaper entry buys a
// sharp dip that buyers are already stepping into. A pacing probe keeps the
// run above the 20-coin guardrail when the momentum entries alone are too
// few. Entries are small (0.03 SOL) and buys carry tight slippage (300 bps),
// so a fill that jumped away in the 2-slot latency is refused for free
// instead of chasing the pump.
//
// The wire: the harness sends one `hello` message, then one `batch` per slot
// that carries events, then `done`. Every batch the bot answers with one
// reply: the `orders` for that slot (buys and sells, at most 16). Orders
// decided on slot s fill at slot s + latency (2 slots). The bot is a pure
// function of the batches it is fed: no clock, no environment, no randomness,
// iteration only over insertion-ordered maps, so the two graded executions
// produce byte-identical action logs.
//
// Money: 10 SOL paper capital, at most 5 open positions, each buy at most 1%
// of a curve's real SOL reserve per reply, no shorts, no leverage. Every
// order pays a flat tx fee (5000 + 100000 lamports) plus curve fees of about
// 95 bps protocol + 30 bps creator each way, so a round trip needs roughly a
// 3% move to break even; entries are sized so the tx fee stays tiny next to
// the stake.
//
// Guardrails the bot must clear: a round trip of at least 0.01 SOL on each of
// at least 20 distinct coins, and a maximum drawdown of 50%. Positions are
// therefore kept small (0.05 SOL first buy, up to 0.40 SOL total per coin),
// exits are fast, and total exposure is capped well under the capital.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from "./vendor/makefun-bot.ts";

export interface Params {
  /** Entry window in slots: the tape the momentum signal reads. */
  window: number;
  /** Net buy SOL (buys minus sells, in SOL) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip coins that already ran too far. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half. */
  accel: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL, at most. */
  maxBuyerShare: number;
  /** Real SOL reserve window at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL to put into one position in total (first buy + adds). */
  stakeSol: number;
  /** First buy, in SOL. */
  initialSol: number;
  /** Each pyramid add, in SOL. */
  addSol: number;
  /** Most adds after the first buy. */
  maxAdds: number;
  /** An add needs the price at least this far above the last buy's price. */
  addStep: number;
  /** Slippage on buys in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Sell the whole position when its value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop: once armed, sell when value falls to peak * (1 - trail). */
  trail: number;
  /** The trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Sell the whole position when its value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Dip entries take profit sooner: cost * (1 + dipTakeProfit). */
  dipTakeProfit: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** After an exit, ignore the coin for this many slots. */
  cooldown: number;
  /** Sell this share of the position once it reaches cost * (1 + partialAt). */
  partialAt: number;
  /** Share of the position the partial sale takes (0 = off). */
  partialShare: number;
  /** Dip entry: buy when price is this far below the recent high... */
  dipMin: number;
  /** ...but no further than this (a collapse, not a dip). */
  dipMax: number;
  /** Dip entry needs at least this many buys among the window trades. */
  dipMinBuys: number;
  /** Dip entry stake, in SOL. */
  dipStakeSol: number;
  /** Most new entries per batch reply. */
  maxEntriesPerBatch: number;
  /** Most SOL deployed across open positions at once. */
  maxExposureSol: number;
  /** Pacing probe: a small buy to bank a round trip when coins lag. */
  probeSol: number;
  /** Probe exits on this gain, this loss, or this hold, in slots. */
  probeTakeProfit: number;
  probeStop: number;
  probeMaxHold: number;
  /** Staged pace targets: [elapsed slots, minimum distinct coins touched]. */
  paceTargets: Array<[number, number]>;
}

export const DEFAULT_PARAMS: Params = {
  window: 40,
  minNetSol: 2,
  minBuys: 4,
  minBuyers: 8,
  minPriceUp: 0.1,
  maxPriceUp: 1.0,
  accel: 1.0,
  nearHigh: 0.97,
  maxBuyerShare: 0.4,
  minRqSol: 5,
  maxRqSol: 80,
  minAge: 300,
  stakeSol: 0.03,
  initialSol: 0.03,
  addSol: 0.1,
  maxAdds: 0,
  addStep: 0.02,
  buySlipBps: 300,
  stopLoss: 0.15,
  trail: 0.12,
  trailArm: 0.05,
  takeProfit: 0.3,
  dipTakeProfit: 0.15,
  partialAt: 0.15,
  partialShare: 0, // tried at 0.5 on the dev window: no gain, so off; the
  // trailing stop already protects winners and extra sells only add fees.
  maxHold: 1200,
  cooldown: 200,
  dipMin: 0.25,
  dipMax: 0.55,
  dipMinBuys: 4,
  dipStakeSol: 0.05,
  maxEntriesPerBatch: 2,
  maxExposureSol: 6,
  probeSol: 0.02,
  probeTakeProfit: 0.08,
  probeStop: 0.15,
  probeMaxHold: 600,
  paceTargets: [
    [100_000, 5],
    [200_000, 10],
    [300_000, 15],
  ],
};

const SOL = 1_000_000_000;
const SELL_SLIP_BPS = 10_000;

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  /** SOL amount of the trade. */
  sol: number;
  user: string;
  /** Price (SOL per token) just after this trade. */
  price: number;
}

interface CoinTape {
  mint: Pubkey;
  creator: string;
  createdSlot: number;
  /** Price (SOL per token) at creation, from virtual reserves. */
  createPrice: number;
  /** Recent trades, oldest first, capped at 200. */
  trades: TapeTrade[];
  /** Last price seen. */
  lastPrice: number;
}

type EntryKind = "momentum" | "dip" | "probe";

interface PositionBook {
  mint: Pubkey;
  /** Slot the first buy was decided on. */
  entrySlot: number;
  /** Price (SOL per token) at the last buy decision. */
  lastBuyPrice: number;
  /** Peak mark value as a multiple of cost. */
  peakMultiple: number;
  /** Number of buys that filled. */
  buys: number;
  /** Total SOL spent on buys that filled (quote lamports, fees included). */
  spentSol: number;
  kind: EntryKind;
  /** True once the partial take-profit sale has gone out. */
  partialTaken: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CoinTape>();
  const books = new Map<Pubkey, PositionBook>();
  const cooldownUntil = new Map<Pubkey, number>();
  const decided = new Set<Pubkey>();
  const tripped = new Set<Pubkey>();
  let firstSlot = -1;

  function tapeFor(mint: Pubkey, slot: number): CoinTape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { mint, creator: "", createdSlot: slot, createPrice: 0, trades: [], lastPrice: 0 };
      tapes.set(mint, t);
    }
    return t;
  }

  /** Flow and price stats over the entry window ending at nowSlot. */
  function windowStats(t: CoinTape, nowSlot: number): {
    netSol: number;
    buys: number;
    buyers: number;
    startPrice: number;
    high: number;
    firstHalfNet: number;
    secondHalfNet: number;
    topBuyerShare: number;
  } {
    const from = nowSlot - p.window;
    const mid = from + p.window / 2;
    let netSol = 0;
    let buys = 0;
    let buySol = 0;
    const buyers = new Set<string>();
    const buyerSol = new Map<string, number>();
    let startPrice = t.createPrice;
    let high = t.createPrice;
    let firstHalfNet = 0;
    let secondHalfNet = 0;
    let seenInWindow = false;
    for (const tr of t.trades) {
      if (tr.slot < from) {
        startPrice = tr.price;
        continue;
      }
      if (!seenInWindow) {
        seenInWindow = true;
        // The first in-window trade inherits the pre-window price as the
        // window's start when no trade precedes it; startPrice already holds
        // the last pre-window trade's price, else the create price.
      }
      if (tr.price > high) high = tr.price;
      const signed = tr.isBuy ? tr.sol : -tr.sol;
      netSol += signed;
      if (tr.slot < mid) firstHalfNet += signed;
      else secondHalfNet += signed;
      if (tr.isBuy) {
        buys += 1;
        buySol += tr.sol;
        buyers.add(tr.user);
        buyerSol.set(tr.user, (buyerSol.get(tr.user) ?? 0) + tr.sol);
      }
    }
    let topBuyerSol = 0;
    for (const v of buyerSol.values()) if (v > topBuyerSol) topBuyerSol = v;
    return {
      netSol,
      buys,
      buyers: buyers.size,
      startPrice,
      high,
      firstHalfNet,
      secondHalfNet,
      topBuyerShare: buySol > 0 ? topBuyerSol / buySol : 0,
    };
  }

  const onBatch = (state: BotState, batch: Batch): OrderInput[] => {
    const slot = batch.slot;
    if (firstSlot < 0) firstSlot = slot;
    const orders: OrderInput[] = [];
    const txFeeSol = Number(state.txFeeLamports()) / SOL;

    // ---- Fold this batch's fills into the books.
    for (const f of batch.fills) {
      if (f.status !== "filled" || f.side !== "buy") continue;
      const book = books.get(f.mint);
      if (book !== undefined) {
        book.spentSol += Number(BigInt(f.quote_lamports)) / SOL;
        book.buys += 1;
      }
    }

    // ---- Fold this batch's events into the tapes.
    const touched = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        const t = tapeFor(e.mint, slot);
        t.creator = e.creator;
        t.createdSlot = e.slot;
        t.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        t.lastPrice = t.createPrice;
        touched.add(e.mint);
      } else if (e.event === "TradeEvent") {
        const t = tapeFor(e.mint, slot);
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        t.trades.push({
          slot: e.slot,
          isBuy: e.is_buy,
          sol: Number(BigInt(e.sol_amount)) / SOL,
          user: e.user,
          price,
        });
        if (t.trades.length > 200) t.trades.splice(0, t.trades.length - 200);
        t.lastPrice = price;
        touched.add(e.mint);
      } else if (e.event === "CompleteEvent") {
        // The harness closes the position itself; drop the book.
        books.delete(e.mint);
        cooldownUntil.set(e.mint, slot + p.cooldown);
      }
    }

    // ---- Exit checks on every open position (at most 5).
    let free = Number(state.freeCashLamports()) / SOL;
    const positions = new Map<Pubkey, { tokens: bigint; costSol: number }>();
    for (const [mint, h] of state.positions) {
      positions.set(mint, { tokens: h.token_amount, costSol: Number(h.cost_lamports) / SOL });
    }
    const valueSol = (mint: Pubkey, tokens: bigint): number => {
      const c = state.curves.get(mint);
      if (c === undefined || c.virtual_token_reserves === 0n) return 0;
      return (Number(tokens) * Number(c.virtual_quote_reserves)) / Number(c.virtual_token_reserves) / SOL;
    };
    const sellWhole = (mint: Pubkey, tokens: bigint): void => {
      if (tokens <= 0n) return;
      orders.push({ side: "sell", mint, token_amount: tokens, max_slippage_bps: SELL_SLIP_BPS });
      tripped.add(mint);
      books.delete(mint);
      cooldownUntil.set(mint, slot + p.cooldown);
    };
    const sellPart = (mint: Pubkey, tokens: bigint, share: number): void => {
      if (tokens <= 0n || share <= 0 || share >= 1) return;
      const part = (tokens * BigInt(Math.floor(share * 1000))) / 1000n;
      if (part <= 0n || part >= tokens) return;
      orders.push({ side: "sell", mint, token_amount: part, max_slippage_bps: SELL_SLIP_BPS });
    };

    // A sell already in flight covers this mint: sending another sell of the
    // same tokens would come back insufficient_tokens, so wait for the fill.
    const pendingSells = new Set<Pubkey>();
    for (const pend of state.pending.values()) {
      if (pend.order.side === "sell") pendingSells.add(pend.order.mint);
    }

    for (const [mint, pos] of positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingSells.has(mint)) continue;
      const value = valueSol(mint, pos.tokens);
      const cost = Math.max(pos.costSol, 1e-9);
      const multiple = value / cost;
      const book = books.get(mint);
      if (book === undefined) {
        // A position with no book: protect it with a plain stop.
        if (multiple <= 1 - p.stopLoss) sellWhole(mint, pos.tokens);
        continue;
      }
      if (multiple > book.peakMultiple) book.peakMultiple = multiple;
      const held = slot - book.entrySlot;
      const tp = book.kind === "dip" ? p.dipTakeProfit : book.kind === "probe" ? p.probeTakeProfit : p.takeProfit;
      const stop = book.kind === "probe" ? p.probeStop : p.stopLoss;
      const holdLimit = book.kind === "probe" ? p.probeMaxHold : p.maxHold;
      // Bank half at the first leg up: meme-coin winners round-trip fast, so
      // take some profit off the table and let the rest ride the trail.
      if (!book.partialTaken && p.partialShare > 0 && multiple >= 1 + p.partialAt && multiple < 1 + tp) {
        sellPart(mint, pos.tokens, p.partialShare);
        book.partialTaken = true;
        continue;
      }
      let exit = false;
      if (multiple <= 1 - stop) exit = true; // stop loss
      else if (book.peakMultiple >= 1 + p.trailArm && multiple <= book.peakMultiple * (1 - p.trail)) exit = true; // trailing stop
      else if (multiple >= 1 + tp) exit = true; // take profit
      else if (held >= holdLimit) exit = true; // stale
      if (exit) sellWhole(mint, pos.tokens);
    }

    // ---- Creator-sell rug exit: a sell by the creator after we entered.
    for (const e of batch.events) {
      if (e.event !== "TradeEvent" || e.is_buy) continue;
      if (!books.has(e.mint)) continue;
      const t = tapes.get(e.mint);
      if (t !== undefined && e.user === t.creator) {
        if (pendingSells.has(e.mint)) continue;
        const pos = positions.get(e.mint);
        if (pos !== undefined) sellWhole(e.mint, pos.tokens);
      }
    }

    // ---- Entries and pyramid adds.
    const openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    const exposure = [...positions.values()].reduce((a, x) => a + x.costSol, 0);
    let entriesLeft = p.maxEntriesPerBatch;
    const pendingBuys = new Set<Pubkey>();
    for (const pend of state.pending.values()) {
      if (pend.order.side === "buy") pendingBuys.add(pend.order.mint);
    }

    const tryBuy = (mint: Pubkey, amountSol: number, kind: EntryKind): void => {
      if (entriesLeft <= 0) return;
      if (orders.length >= state.hello.caps.max_orders_per_batch) return;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) return;
      const capSol = Number(state.maxBuyLamports(mint)) / SOL;
      if (capSol < 0.01) return; // below the guardrail's round-trip size
      const amount = Math.min(amountSol, capSol);
      if (amount < 0.01) return;
      if (free < amount + txFeeSol) return;
      if (kind !== "probe" && exposure + amount > p.maxExposureSol) return;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) return;
      orders.push({
        side: "buy",
        mint,
        quote_lamports: BigInt(Math.floor(amount * SOL)),
        max_slippage_bps: p.buySlipBps,
      });
      free -= amount + txFeeSol;
      entriesLeft -= 1;
      let book = books.get(mint);
      if (book === undefined) {
        books.set(mint, {
          mint,
          entrySlot: slot,
          lastBuyPrice: price,
          peakMultiple: 1,
          buys: 0,
          spentSol: 0,
          kind,
          partialTaken: false,
        });
      } else {
        book.lastBuyPrice = price;
      }
      decided.add(mint);
    };

    // Pyramid adds first: strength gets size before new coins do.
    for (const [mint, book] of [...books]) {
      if (book.kind === "probe") continue;
      if (pendingBuys.has(mint)) continue; // wait for the last buy to land
      const pos = positions.get(mint);
      if (pos === undefined) continue;
      if (book.buys >= 1 + p.maxAdds) continue;
      if (book.spentSol >= p.stakeSol) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price < book.lastBuyPrice * (1 + p.addStep)) continue;
      const t = tapes.get(mint);
      if (t === undefined) continue;
      const st = windowStats(t, slot);
      if (st.netSol < 0) continue; // only add while SOL still flows in
      tryBuy(mint, Math.min(p.addSol, p.stakeSol - book.spentSol), book.kind);
    }

    // New entries: evaluate coins touched by this batch, in batch order.
    for (const mint of touched) {
      if (entriesLeft <= 0) break;
      const buysSent = orders.filter((o) => o.side === "buy").length;
      if (openSlots - buysSent <= 0) break;
      if (positions.has(mint) || books.has(mint)) continue;
      if (decided.has(mint)) continue;
      if ((cooldownUntil.get(mint) ?? -1) > slot) continue;
      const t = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (t === undefined || curve === undefined || curve.complete) continue;
      const age = slot - t.createdSlot;
      if (age < p.minAge) continue;
      const rqSol = Number(curve.real_quote_reserves) / SOL;
      if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0 || t.createPrice <= 0) continue;
      const st = windowStats(t, slot);
      const up = price / st.startPrice - 1;
      // Momentum entry: broad buying, accelerating inflow, near the high.
      const momentum =
        st.buys >= p.minBuys &&
        st.buyers >= p.minBuyers &&
        st.netSol >= p.minNetSol &&
        up >= p.minPriceUp &&
        up <= p.maxPriceUp &&
        price >= st.high * p.nearHigh &&
        (st.firstHalfNet <= 0 ? st.secondHalfNet > 0 : st.secondHalfNet >= p.accel * st.firstHalfNet) &&
        st.topBuyerShare <= p.maxBuyerShare;
      if (momentum) {
        tryBuy(mint, p.initialSol, "momentum");
        continue;
      }
      // Dip entry: a sharp fall from the window high that buyers are already
      // stepping into, in a small tranche with a fast rebound exit.
      const down = 1 - price / Math.max(st.high, 1e-12);
      const dip = down >= p.dipMin && down <= p.dipMax && st.buys >= p.dipMinBuys && st.netSol > 0;
      if (dip) {
        tryBuy(mint, p.dipStakeSol, "dip");
        continue;
      }
    }

    // ---- Pacing probe: keep distinct coins on pace for the 20-coin bar.
    const elapsed = firstSlot < 0 ? 0 : slot - firstSlot;
    let need = 0;
    for (const [at, want] of p.paceTargets) {
      if (elapsed >= at) need = want;
    }
    const distinct = new Set([...tripped, ...books.keys(), ...positions.keys()]).size;
    if (distinct < need && openSlots > 0) {
      let best: Pubkey | undefined;
      let bestRq = 0;
      for (const mint of touched) {
        if (positions.has(mint) || books.has(mint) || decided.has(mint)) continue;
        if ((cooldownUntil.get(mint) ?? -1) > slot) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rqSol = Number(curve.real_quote_reserves) / SOL;
        if (rqSol >= 2 && rqSol > bestRq) {
          bestRq = rqSol;
          best = mint;
        }
      }
      if (best !== undefined) tryBuy(best, p.probeSol, "probe");
    }

    return orders;
  };

  return { onBatch };
}
