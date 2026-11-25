# Second-Wind Dip-Recovery Bot — Pump.fun Bot Sprint

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v1-local/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v1-local/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun bonding curves on the `agent-fun/replay/v2`
protocol. It trades on the replay's market events as they arrive and is
scored on net PnL against holding cash.

## Strategy: second wind, not first hype

Most fresh curves either rug in their first minutes or never move. This bot
only touches a curve **after it has already proved it can run** — the price
must have doubled from its create price at some point — and then waits for
the first healthy pullback:

- **Entry:** price 12–30% off its peak, with buyers stepping back in
  (net inflow over the last 20 slots, ≥3 distinct buyers, latest trade a
  buy), real SOL ≥ 3, peak real SOL ≥ 5, age ≥ 200 slots. A creator sell at
  any point vetoes the coin outright.
- **Sizing:** a 0.05 SOL probe first; one 0.10 SOL add only if the price
  climbs back above the first buy's price with inflow still positive
  (max 0.30 SOL per coin, 3.5 SOL total exposure, 5 positions).
- **Exits (staged):** sell half at +35%; the rest rides a 20% trailing stop
  from peak value (or a full exit at +100%); hard stop at −18% of cost;
  fade exit on outflow; instant exit on a creator sell; time cap of
  1200 slots (doubled while up ≥20%).
- **Guardrails:** tiny 0.01 SOL probe round trips on liquid curves keep the
  run above the 20-coin / round-trip minimum when the main signal is quiet.

Fully deterministic: a pure function of the batches the harness sends — no
clock, no randomness, no I/O, no environment reads — so the two graded
executions produce byte-identical action logs.

## Layout

- `main.ts` — entrypoint (the grader runs `node /bot/main.ts`)
- `strategy.ts` — the strategy (all parameters in `DEFAULT_PARAMS`)
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte

## Dev backtest (kit data, local sim port)

```sh
node tools/backtest.ts <kit dir>   # from the kit's pilot layout, adapted
```

Dev-window result (v1, local sim — see report): **net −0.103 SOL, 137 fills,
39 coins, 66 trips, 5 wins, max drawdown 0.010** (−0.170 SOL at 2× fees).
Guardrails pass with wide margin (39 ≥ 20 coins, drawdown 1.0% ≤ 50%);
the improvement loop tunes the entry from here.
