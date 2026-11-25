---
description: Design language rule — every visual change applies a recorded practice from design/LANGUAGE.md (or adds one, with its reason), including on VS Code surfaces and after upstream merges
globs: src/vs/workbench/contrib/claude/**,src/vs/workbench/contrib/claudeBackground/**,extensions/theme-klawly/**,resources/klawly/**,design/**,src/vs/**/*.css,UPSTREAM.md
alwaysApply: false
---

# Design language (`design/LANGUAGE.md`)

`design/LANGUAGE.md` records every design practice Klawly follows, with an ID (`DL-NN`), the reason for it, where it lives and what it applies to. It is the source of truth for how Klawly looks; the `design-philosophy` skill holds the vocabulary.

## Every visual change
- Before you change how something looks (color, size, spacing, radius, type, icons, wording, which controls show), find the practice in `design/LANGUAGE.md` that covers it and follow it.
- Cite the practice ID in the comment above the code that applies it: `/* DL-21: ... */` in CSS, `// DL-12: ...` in TypeScript. The comment also names the surface and the issue.
- If no practice covers the decision, add one in the same pull request, following "Adding or changing a practice" in `design/LANGUAGE.md`. Fill in all five fields. **Why** names the feeling (Calm, Focused, Consistent, Delightful) and the concrete problem; "looks better" is not a reason.
- If your change contradicts a practice, either change the practice (edit the entry, add the issue to **Since**, update every place that cites it) or change your code. Never leave the two disagreeing.
- Mirror the practice in `design/` so the prototype stays true (rule 36).

## VS Code surfaces
- Apply practices to VS Code surfaces with the cheapest step in "How a practice reaches a surface" in `design/LANGUAGE.md`: theme color, then Klawly token, then a scoped rule in `claudeChrome.css`, then a registration hook, then a small upstream edit listed in `UPSTREAM.md` with its practice ID.
- Every rule in `claudeChrome.css` is scoped `.monaco-workbench:not(.hc-black):not(.hc-light)` (DL-02). High contrast stays stock.
- Never restyle a VS Code surface from Klawly code without a practice ID, and never put that restyle in a Klawly stylesheet other than `claudeChrome.css`, so all of it is in one place for the next merge.

## After an upstream merge
- Follow "When upstream changes" in `design/LANGUAGE.md`: list new and changed upstream UI, check every `claudeChrome.css` selector still matches, apply the practices to new surfaces, and record new practices and upstream edits.
- The merge pull request says which surfaces were checked and which practices were applied or added, with screenshots in Klawly Dark and Klawly Light.

## Never
- Never reuse a retired `DL` number or delete an entry outright; retire it with its reason.
- Never cite a practice that does not exist, and never change a practice's meaning without updating every place that cites it (`git grep "DL-NN"`).
- Never copy another product's styling into a practice. Practices are decisions made from measurements, in our own words.
