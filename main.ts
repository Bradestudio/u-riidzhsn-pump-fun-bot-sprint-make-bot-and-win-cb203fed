// DipRider entrypoint: hands the strategy to the agent-fun/replay/v2 shim,
// which owns the wire (hello, batch, orders, slot by slot) on stdin/stdout.
import { runBot } from './vendor/makefun-bot.ts';
import { createDipRider } from './strategy.ts';

const strategy = createDipRider();

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
