# Vernier

A Coding Agent harness where every context-engineering mechanism is a switchable
plugin, and every plugin has to earn its place in an ablation run.

> Status: M1 — it runs real tasks against `deepseek-flash`. No benchmark numbers
> yet; those arrive with M8 and will be reproducible from `reports/`.

A vernier is the sliding second scale on a caliper. It exists to resolve differences
the main scale is too coarse to show. That is the job here: a single run cannot tell
you whether compaction helped — the difference is inside the noise. Only repeated,
controlled comparison can.

## Why this exists

Most agent harnesses claim their context tricks help. This one measures them. Each
mechanism (tool hardening, context compaction, long-term memory, planning, prompt
rewriting) is a plugin that can be switched off from a profile in `profiles/`, and
the benchmark runs every configuration on the same tasks, three times each.

## The question it is built to answer

With `deepseek-flash`, a cached input token costs $0.006/M against $0.30/M for a
fresh one — a 50x gap. Context compaction rewrites history, which invalidates the
prefix cache. So "compaction saved 40% of tokens" and "compaction saved money" are
different claims, and most harnesses never check the second one. This repo reports
cache hit rate alongside token counts, and the compaction plugin is built to keep
the prefix byte-stable so both can be true at once.

## Layout

| Path                 | What lives there                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/kernel`    | The protocol: `Plugin`, `Service`, the eight `Hooks`, dependency validation. Knows nothing about any mechanism. |
| `packages/runtime`   | The loop: request building, tool execution, budget, cancellation.                                               |
| `packages/providers` | Model access via `@earendil-works/pi-ai` (`deepseek-flash` + a faux model for offline tests).                   |
| `packages/tools`     | read / write / edit / grep / find / bash.                                                                       |
| `packages/session`   | Append-only JSONL history and resume.                                                                           |
| `packages/plugins`   | One directory per mechanism. All optional.                                                                      |
| `packages/evals`     | Task loader, docker runner, assertion-based judge, report.                                                      |
| `profiles/`          | Ablation configurations: B0 baseline through F full.                                                            |
| `docs/`              | Upstream analysis of pi, architecture notes, implementation plan.                                               |

## Running

```sh
npm install
npm run check      # lint + typecheck + test

node packages/cli/src/main.ts "fix the failing test in calc.py" --cwd /path/to/workspace
```

```
[turn 4] <- tool_use in 615ms  (in 183+896 out 54)
  · bash {"command":"python3 test_calc.py"}
    ok 47ms 3 bytes
[turn 5] <- stop in 1480ms  (in 251+896 out 54)

stop: done
turns: 5  tools: 5  elapsed: 5.2s
tokens: in 1480 + cached 3328 -> out 317 (reasoning 3)
cache hit: 69.2%   cost: $0.00084
```

Every run prints its own cost and cache hit rate. That is not decoration: the cache
column is what makes the compaction question in the next section answerable.

Needs Node >= 24: the repo runs TypeScript directly through Node's type stripping,
so there is no build step. `tsconfig.json` sets `erasableSyntaxOnly` to keep it that
way.

Model access needs `DEEPSEEK_API_KEY` (see `.env.example`). Tests never call a real
model — they run against the faux provider.
