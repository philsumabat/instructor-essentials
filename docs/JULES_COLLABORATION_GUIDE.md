# Instructor's Guide to Collaborating with Jules AI

*A non-technical, classroom-focused guide to reviewing, verifying, and deploying pull requests created by Google Jules AI in the Instructors' Toolkit.*

---

## 1. What is Jules AI and How Does It Fit into Toolkit?

**Jules** is Google's asynchronous AI coding agent that can read our repository, understand issues or feature requests you describe in GitHub, and automatically write code, fix bugs, or create new features by opening a **Pull Request (PR)** on GitHub.

As an instructor, you do not need to write JavaScript or understand matrix mathematics to work with Jules. Your primary role is **product director and classroom validator**: you tell Jules what instructors and students need, and verify that the resulting tool behaves honestly and reliably in real grading sessions.

---

## 2. Golden Rule: The Single-Agent Principle

> [!IMPORTANT]
> **Never have two AI agents editing the same branch at the same time.**

When collaborating with Jules in the cloud while also using a local AI assistant (like Antigravity or Gemini Code Assist on your laptop):
- **Give Jules its own task:** Let Jules work alone on a dedicated branch until it finishes and opens a PR.
- **Do not edit Jules' branch locally while Jules is still running:** Wait until Jules finishes its task.
- **Inspect and finalize with your local AI:** Once Jules submits a PR, bring your local AI assistant in to test, inspect, bundle, and merge.

---

## 3. How to Prompt Jules for Reliable Results

When creating a task or issue for Jules on GitHub, write in clear classroom language and specify expected teacher workflows:

1. **State the Classroom Goal:**
   *Example:* *"When opening an exam session saved to Google Drive, the inspect sheet view should not show scan images from previous sessions. It should show a clean placeholder inviting the instructor to attach their scans folder if images were not embedded."*
2. **Specify Strict Zero-Regression Constraints:**
   - Always tell Jules: *"Do not break existing offline-first grading or client-side privacy."*
   - *"Write or update unit tests under `tests/js/` to verify this change."*
3. **Remind Jules of the Mandatory Build Step:**
   - Always include this sentence: *"Always run `npm run build:studio` before submitting your PR to ensure standalone bundles in `docs/` match the source files in `builder/`."*

---

## 4. The 3-Step Routine to Review a Jules PR

When Jules opens a PR, follow this simple 3-step routine:

### Step 1: Read Jules' PR Summary on GitHub
- Did Jules understand your actual request?
- Did Jules touch only the relevant files (`builder/checker.html`, `builder/home.html`, etc.)?
- Did Jules avoid adding external npm dependencies or paid API keys?

### Step 2: Ask Your Local AI Assistant to Inspect & Test the PR
You do not need to memorize git commands. Simply prompt your local AI assistant:

> *"Jules submitted PR #X on branch `jules-fix-...`. Please check out that branch, review Jules' diff, run `npm test` to verify zero test regressions, compile the standalone files with `npm run build:studio`, and tell me if it is safe to merge."*

Your local assistant will:
1. Run all 130+ automated tests across the OMR and layout engine.
2. Verify that `docs/index.html`, `docs/builder.html`, and `docs/checker.html` are compiled and synchronized.
3. Report any potential edge cases or bugs directly in plain English.

### Step 3: Approve & Merge to `main`
Once tests pass and the studio is built:
- Click **Squash and merge** on GitHub (or instruct your local AI to merge and push to `main`).
- Because GitHub Pages serves directly from `docs/`, your changes are live within 60 seconds at `https://philsumabat.github.io/grader/`.

---

## 5. Why Standalone Bundling (`npm run build:studio`) Matters

In Instructors' Toolkit:
- Source code lives in the `builder/` directory (e.g., `builder/home.html`, `builder/checker.html`, `builder/index.html`).
- The live public site on GitHub Pages runs from the `docs/` directory (`docs/index.html`, `docs/checker.html`, `docs/builder.html`).

Whenever anyone (Jules, an AI assistant, or you) edits a file in `builder/`, running `npm run build:studio` in your terminal compiles the modular JavaScript and CSS into single, zero-dependency HTML files and copies them into `docs/`.

If Jules ever submits a PR where it edited `builder/` but forgot to update `docs/`, your automated test `standalone-bundle.test.mjs` will flag it immediately! Simply run `npm run build:studio`, commit the updated `docs/` files, and push.

---

## 6. Quick Troubleshooting Cheat Sheet

| Symptom | Root Cause | Quick Fix |
| :--- | :--- | :--- |
| **GitHub Pages does not show new feature** | `docs/` bundles were not updated after changing `builder/` | Run `npm run build:studio`, stage changes, and push to `main`. |
| **`npm test` fails with strictEqual on `docs/`** | `docs/index.html` does not match `builder/home.html` | Run `npm run build:studio` and rerun `npm test`. |
| **Review Queue or Save shows `QuotaExceededError`** | Storing mega-byte scan images in `localStorage` | Verify that `scanData` is stripped from routine saves and only saved in lightweight progress format (~50 KB). |
| **Phantom images in Sheet Inspector** | Old in-memory scans were grafted during cloud restore | Verify that `state.scans = [];` is reset on session restore and images are matched by `examId`/`studentId`. |

---

*Instructors' Toolkit is maintained with teacher workflows as the single source of truth. Jules is here to assist—you remain in complete control.*
