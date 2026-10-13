# Guidance for AI coding agents

## Project context

This is an instructor-led project. The maintainer is an instructor who understands classroom needs and can describe how they want the tool to work, but does not claim expertise in software engineering, computer vision, OCR, or psychometrics. Treat classroom requirements as the product source of truth. Treat technical approaches and assessment interpretations as proposals to explain, investigate, and validate—not as established expert conclusions.

When proposing or making changes:

- Explain technical choices, tradeoffs, and assumptions in plain language.
- Ask for clarification when a classroom requirement is genuinely ambiguous; otherwise make a small, reversible choice and state it.
- Do not overstate accuracy, privacy, statistical meaning, or hosting guarantees.
- For engine changes, describe how behavior will be evaluated and identify important failure cases.
- Preserve the requirement that core features remain free and usable without paid services or accounts.
- Prefer incremental, reviewable changes that fit the existing project unless evidence supports a larger redesign.

## Project references

Read these documents before making broad product or architecture changes:

- [`ROADMAP.md`](ROADMAP.md) — prioritized product and engine improvements.
- [`DECISIONS.md`](DECISIONS.md) — current architecture, implementation decisions, and verification guidance.
- [`README.md`](README.md) — project overview, components, quickstart, and deployment links.

The architecture overview is maintained in `README.md` and the detailed architecture specification is in `DECISIONS.md`; there is no separate architecture document at present. If a dedicated architecture document is created later, link it here and keep its scope distinct from the decision history.

## Working in this repository

- Follow existing patterns and check the relevant files before changing generated or bundled artifacts.
- Keep the browser-based builder and checker compatible with their standalone/static deployment paths.
- Keep the Python CLI and optional hosted Gradio app usable without making the hosted service mandatory.
- Avoid adding paid APIs, required accounts, or new infrastructure without a clear product need.
- Do not claim an engine improvement from intuition alone. Use representative scans and known expected results when available; explain any limitations in coverage.
- Do not introduce real student personal data into fixtures, examples, or documentation.
- Before editing, inspect `git status` and preserve unrelated user changes. Do not overwrite or revert work that is already present.
- Run only the checks relevant to the requested change unless the user asks for broader verification. Report what was and was not verified.

## Communication

Keep the maintainer in control of product decisions. Present recommendations with their practical effect on an instructor’s workflow, note uncertainties plainly, and avoid burying important tradeoffs in jargon.
