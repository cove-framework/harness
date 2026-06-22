---
name: review-pr
description: Checklist and rubric for reviewing a pull request before posting a verdict.
allowed-tools: postReview
---

# Reviewing a pull request

Work through this checklist before calling `postReview`. Be concrete: cite files and lines.

## 1. Understand the change

- Read the PR description and the diff in full before commenting.
- Restate the intended behavior change in one sentence. If you cannot, ask for clarification.

## 2. Correctness

- Does the change do what it claims? Look for off-by-one, null/undefined, and async ordering bugs.
- Are error paths handled, or are failures swallowed?
- Are there tests covering the new behavior and the edge cases?

## 3. Security and safety

- Validate untrusted input. Watch for injection (SQL/command/path), unsafe deserialization, and SSRF.
- No secrets, tokens, or credentials in the diff.
- Permission/authorization checks are present where state changes.

## 4. Clarity and maintainability

- Names communicate intent. Dead code and stray debug logging are removed.
- The change is the right size; unrelated refactors are split out.

## 5. Deliver the verdict

Choose exactly one:

- `approve` — ready to merge; note anything optional.
- `request_changes` — list the blocking issues in `blockingIssues`.
- `comment` — non-blocking feedback only.

Call `postReview` with a one-paragraph `summary` and, when blocking, a `blockingIssues` array. `postReview`
is human-gated: it pauses for an approver before the review is sent.
