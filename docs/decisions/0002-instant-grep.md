# 0002 Instant Grep (a local search index)

- Status: accepted 2026-10-13 (issue 498).
- Date: 2026-10-13. Measured on Windows 11 Pro 10.0.26200 (AMD Ryzen 9 7900X, 32 GB, NVMe SSD), Claude Code 2.1.296.

## Question

Should Klawly build a local search index (a trigram index in the shared process, exposed to Claude as a `fast_grep` tool and used by the `@` picker), so code search is instant on big repositories? Issue 498 says to measure first and build only if searches take seconds.

## Decision

**Not needed now (Wait).** Claude's own Grep (ripgrep, embedded in Claude Code) answers the real searches Claude made in this repository in 0.03 s at the median and under 0.75 s at worst. Searching a whole 21,000- or 31,000-file repository takes about 0.4 to 0.55 s, and listing every file (what Glob and the `@` picker walk) takes under 0.2 s. An index would cost disk, memory and a file watcher to save a fraction of a second.

Some Grep calls did take 2 to 20 s in the session logs, but replaying those exact calls takes at most 0.39 s, so the index would not have helped them (see Findings).

Re-open as a Port when either of these is measured: replayed Grep calls on a user's repository take more than 2 s at p90, or the `@` picker's file list takes more than 1 s.

## Method

1. **Session logs.** Every Grep and Glob call in this PC's Claude Code transcripts (`~/.claude/projects/*/*.jsonl` and their subagent logs), timed from the `tool_use` record to its `tool_result` record. This is an upper bound: it also counts permission prompts, hooks, other tools in the same batch and machine load.
2. **Replay.** 200 of the 477 distinct Grep calls Claude made in the Klawly repository (random sample, seed 498), run again with Claude Code's own ripgrep (`claude.exe` started as `rg`, ripgrep 14.1.1) and the flags Grep uses (`--hidden --glob !.git --max-columns 500`, plus `-l`, `-c` or `-n`, `-i`, `-U`, context, `--type` and `--glob` from the call). Each call ran twice; "first" is the first run in the process, "again" the second. Calls ran twice on:
   - **Klawly** (this repository, Code - OSS 1.141 plus Klawly, 20,947 tracked files), once with the call's own path and once on the whole repository;
   - **Kubernetes** (`kubernetes/kubernetes`, shallow clone of 05d4105f, 31,430 tracked files), on the whole repository. Klawly's patterns rarely match there, which makes this the worst case: ripgrep reads every file.
3. **The slow calls.** Each Grep call that took more than 2 s in the logs and was the only tool in its message, replayed the same way.

Wall times include starting the ripgrep process.

## Findings

Session logs (upper bound, all projects on this PC):

| Calls | n | p50 | p90 | p99 | max | over 2 s |
|---|---|---|---|---|---|---|
| Grep, all projects | 1,167 | 0.08 s | 1.61 s | 17.1 s | 79.3 s | 9.5% |
| Grep, Klawly repository | 477 | 0.12 s | 8.93 s | 18.8 s | 79.3 s | 16.8% |
| Glob, all projects (`durationMs` from Claude Code) | 88 | 0.61 s | 4.25 s | 8.82 s | 8.98 s | 21.6% |

Replay with Claude Code's ripgrep:

| Repository | Calls | Run | p50 | p90 | p99 | max | over 1 s |
|---|---|---|---|---|---|---|---|
| Klawly | as called (own path) | first | 0.031 s | 0.413 s | 0.503 s | 0.732 s | 0 |
| Klawly | as called (own path) | again | 0.029 s | 0.405 s | 0.482 s | 0.501 s | 0 |
| Klawly | whole repository | first | 0.406 s | 0.482 s | 1.000 s | 1.161 s | 2 |
| Klawly | whole repository | again | 0.406 s | 0.517 s | 0.941 s | 0.970 s | 0 |
| Kubernetes | whole repository | first | 0.542 s | 0.642 s | 1.195 s | 1.579 s | 4 |
| Kubernetes | whole repository | again | 0.546 s | 0.635 s | 1.153 s | 1.387 s | 3 |

Listing every file (`rg --files`): Klawly 0.13 s, then 0.16 s; Kubernetes 0.16 s, then 0.19 s.

The slow calls: 80 Klawly Grep calls took more than 2 s in the logs; 29 shared their message with other tools (mostly Bash), so they waited on those. The other 51 ran alone and took 2.2 to 20.1 s. Replayed, the slowest of the 51 takes 0.39 s. They cluster in a few sessions and days (2026-10-07 to 2026-10-09) when many agents and TypeScript builds ran in parallel on this PC. The logs do not say what each call waited on, so the cause is not proven: machine load, hooks or the session itself are the candidates. ripgrep's own search time is not.

## Why not build it anyway

- It would not fix the slow calls above: they are slow outside the search, and an index process would add to the same memory and disk load.
- Claude Code's Grep is part of Claude Code. A `fast_grep` MCP tool would be a second search tool Claude has to choose between, with its own results and ignore rules to keep in step with `.gitignore` and the read rules (issue 458).
- Disk, memory and a watcher on every open folder, for every user, to save under half a second per search.

## Reproduce

The logs are local to each machine, so a re-measure runs on the machine in question:

1. Collect `Grep` `tool_use` inputs from `~/.claude/projects/<project>/*.jsonl` (and `*/subagents/*.jsonl`).
2. Run each with Claude Code's ripgrep: on Windows, start `%USERPROFILE%\.local\bin\claude.exe` with `argv[0]` set to `rg` (Python: `subprocess.run(['rg', *args], executable=claude_exe)`); on macOS, `ARGV0=rg claude`. Use `--hidden --glob !.git --max-columns 500` and the call's own mode, case, context, type, glob and path.
3. Report p50, p90, p99 and max per repository, first and second run, and compare with the `tool_use` to `tool_result` times from the same logs.
