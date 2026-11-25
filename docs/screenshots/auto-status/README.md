# Auto status screenshots (#1307)

States from #1269 (DL-109/110), captured on Windows 11 Pro 10.0.26300 from a local dev build (`npm run compile`), dark theme, 1440x900, driven by the fake runtime with jsonl fixtures (`claude.agent.runtime: fake`) through the design-parity harness (`build/klawly/design-parity.ts`). Settings: `claude.auto.enabled: true`, `claude.auto.cost.notifyUsd: 1`, `claude.auto.cost.stopUsd: 3`.

| State | File | What it shows |
|---|---|---|
| Working | `working.png` | Auto strip while a turn runs ($0.42). |
| Waiting | `waiting.png` | Auto strip when the turn waits for the user ($0.88). |
| Done | `done.png` | Auto strip after a finished turn ($0.87). |
| Failed | `failed.png` | Auto strip after a failed turn ($0.95), with Retry and Retry on Opus. |
| Guard, notify | `guard-cost-notify.png` | Cost strip at the notify limit ($1.60 Used), with Continue and Stop. |
| Guard, stopped | `guard-cost-stop.png` | Cost strip at the stop limit ($3.40), with Raise Limit, Stop and Hand Off With a Summary. |

| Guard, context | `guard-context.png` | Nudge "Context Is Getting Large" at 90k of a 100k cap (`claude.auto.context.capTokens: 100000`). |

The guard state is the cost strip; it replaces the auto strip while visible. Cost text: two decimals under $10 ("$1.60 Used"), whole dollars from $10 ("$12 Used"); the formatter is `formatClaudeAutoCostUsd` and is unit-tested.

Delegated turn (`npm run auto-status-shots`, `build/klawly/auto-status-shots.ts`; Windows 11 Pro 10.0.26300, wide pane, Agents sidebar shown):

| State | File | What it shows |
|---|---|---|
| Delegate card | `delegate-card.png` | Worker card "Opus 5.5 · Medium · 0s · $0.42 · Done" and $0.42 in the strip. |
| Agents row cost | `agents-row-cost.png` | The delegated chat's row in the Agents sidebar reads "Opus 5.5 · $0.42". |

Why these needed their own script: Auto always picks Opus and reads its flag when a session is created. A chat on the default model, or already on Opus, stays put (`stay`), so no card appears. The run starts with Auto off, picks Sonnet, then turns Auto on with the Auto pill before the second turn. The product renders both correctly; the old harness never made Auto delegate.
