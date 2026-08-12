// Aggregation of all scenario definitions. The ORDER of this array affects
// the EMISSION order of generated stories only — never trajectory randomness:
// each (scenario, variant) draws from a PRNG seeded by `seed + variant`
// (seed is scenario context, order-independent). `--scenarios <dir>` loads this
// file via `<dir>/index.mjs`.
import seedMining from "./seed-mining.mjs";
import ambiguous from "./ambiguous.mjs";
import misc from "./misc.mjs";

export const scenarios = [...seedMining, ...ambiguous, ...misc];
