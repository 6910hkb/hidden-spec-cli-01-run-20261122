# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/6910hkb/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/6910hkb/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. It reads a patch in one of
four formats — a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON
text-editor tool calls — and applies it to a tree of text files, exactly
as SPEC.md says. Old lines are matched at three tiers (exact, trailing
whitespace, then leading and trailing whitespace, with re-indentation),
moves are reported as `R <old> -> <new>`, and a failed edit changes
nothing: the edits after it still run and are all reported, and when any
edit failed no file is written at all.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a path relative to the working directory; absent or `-` reads
the patch from standard input. `--format` is `unified`, `search-replace`,
`v4a`, `json`, or `auto` (the default, which detects the format).
`--check` does everything but write, and `--strict` matches lines exactly.

`SPEC.md` is the whole contract. `check.ts` runs the public practice set
(`node check.ts ../program/generator/practice.json` from the kit), and
`runner.ts` is the trial runner the grader uses.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7yd20ms9&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
