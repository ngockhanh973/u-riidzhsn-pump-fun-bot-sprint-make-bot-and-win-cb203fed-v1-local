// Second-Wind Dip-Recovery bot — entrypoint for agent-fun/replay/v2.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts
// and the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for
// byte under vendor/ (it is not authored code).

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot({
  ...createStrategy(DEFAULT_PARAMS),
  onDone(state) {
    // Diagnostics only (stderr never carries replies): final cash after
    // the replay flattens every position.
    console.error(
      `done: cash ${(state.cash * 1000000n) / LAMPORTS_PER_SOL} micro-SOL, ` +
        `positions ${state.positions.size}, curves seen ${state.curves.size}`,
    );
  },
});
