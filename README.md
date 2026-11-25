# Vernier

A Coding Agent harness where every context-engineering mechanism is a switchable
plugin, and every plugin has to earn its place in an ablation run.

> Status: M0 — skeleton and kernel protocol. No numbers here yet; the ones below
> arrive with M8 and will be reproducible from `reports/`.

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
```

Needs Node >= 24: the repo runs TypeScript directly through Node's type stripping,
so there is no build step. `tsconfig.json` sets `erasableSyntaxOnly` to keep it that
way.

Model access needs `DEEPSEEK_API_KEY` (see `.env.example`). Tests never call a real
model — they run against the faux provider.
