# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kacky000/mend-patch/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kacky000/mend-patch/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` reads a unified diff (wrong line numbers and all), SEARCH/REPLACE
blocks, a V4A patch or JSON text-editor calls, finds the lines each edit names at the first of three matching tiers
(exact, trailing whitespace ignored, indentation ignored with re-indenting), and writes every change or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `main.ts`: the CLI (Node 22, standard library only). `SPEC.md` is the contract it follows.
- `runner.ts`, `check.ts`: the make.fun kit's trial runner and practice checker, unchanged.
- `node check.ts <practice.json>` runs the public practice set (100 of 100 pass).

MIT licensed.
