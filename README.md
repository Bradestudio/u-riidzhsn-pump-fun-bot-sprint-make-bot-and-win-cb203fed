# DipRider — Pump.fun Bot Sprint

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?ref=qjs4e9sj)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Bradestudio/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?ref=qjs4e9sj)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Bradestudio/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?ref=qjs4e9sj)

Entry for [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?ref=qjs4e9sj) on make.fun.

## Strategy: DipRider

Fresh pump.fun coins usually spike within their first couple of slots, so
chasing the open buys the top and then mean-reverts. DipRider waits instead:

1. **Proof of demand** — price at least doubled from create, at least 5
   unrelated wallets bought in, creator has not sold.
2. **Pullback** — price falls at least 20% off its peak run-up, while still
   holding above the create price.
3. **Ride** — one buy per coin (0.1 SOL, capped at 1% of real reserve),
   take profit +25%, stop loss −12%, trailing stop once up 15%, max hold
   120 slots, exit at once if the creator sells or the coin goes stale.

Deterministic: a pure function of the replay batches, no clock, no randomness,
no network. Runs as `node main.ts` under the agent-fun/replay/v2 harness
(`vendor/makefun-bot.ts` is the kit's SDK shim).

## Files

- `main.ts` — entrypoint, hands the strategy to the harness shim.
- `strategy.ts` — the DipRider strategy.
- `vendor/makefun-bot.ts` — the kit's SDK shim (vendored, unchanged).
- `LICENSE` — MIT.
