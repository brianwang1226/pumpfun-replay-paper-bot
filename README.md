# Pump.fun Replay Sprint — Paper Bot, Real Ranking

A paper trading bot for the make.fun bounty
[Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122).
It trades 10 SOL of paper money on a replay of Solana chain data: it buys a
pump.fun coin only once the tape proves real, broad buying (8+ distinct
wallets, 2 SOL of net inflow, price up 10% and holding near its window high,
inflow accelerating), banks no pyramid adds, and exits fast on a stop, a
trailing stop, a take-profit, or a hold limit. A dip entry buys a sharp fall
buyers are already stepping into, and a pacing probe keeps the run above the
20-coin guardrail.

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/brianwang1226/pumpfun-replay-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/brianwang1226/pumpfun-replay-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Run by the grader as `node main.ts` (Node 22): it speaks
agent-fun/replay/v2 on stdin/stdout — one `hello`, one `batch` per slot,
then `done` — and answers each batch with its orders. No network, no clock,
no randomness; the two graded executions produce byte-identical action logs.

Dev-window check (kit's `grade-local`, process driver): net PnL −0.14 SOL,
152 fills over 77 coins, 77 round trips, 31% win rate, max drawdown 1.6% —
guardrails met (77 coins ≥ 20, drawdown ≤ 50%).
