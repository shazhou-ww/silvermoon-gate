---
name: ui-change-review
description: "Create concise before/after HTML review artifacts for proposed changes to an existing user interface. Use when a human needs to compare affected screens, workflows, states, layout, or interaction changes before implementation without requiring a complete prototype."
argument-hint: "[affected UI or review goal]"
user-invocable: true
---

# UI Change Review

Create a decision-ready visual comparison, not a replacement application. The
reviewer should understand the proposed UI change in about five minutes.

## Establish The Decision

1. Inspect the current UI in source, screenshots, or a running build. Do not
   invent or deliberately weaken the Before state.
2. Identify the smallest set of screens and states that exposes the material
   change. Omit unchanged navigation and workflows unless they provide needed
   orientation.
3. State the requested decision in one sentence. List no more than the few
   deltas that could change that decision.
4. Keep normative behavior in the owning interface specification, task, or
   contract. Label the visual comparison as illustrative and link to the
   normative source when one exists.

If the current behavior cannot be established, label the uncertainty instead
of presenting an assumption as Before.

## Build The Comparison

Create a small review bundle that opens from `index.html` without a build step.
Start from [`assets/review-index.html`](assets/review-index.html) and create one
HTML file per scenario from
[`assets/review-scenario.html`](assets/review-scenario.html):

```text
ui-review/
   index.html
   scenarios/
      01-primary-flow.html
      02-error-state.html
```

The entry page owns the decision, material deltas, scenario navigation,
normative link, and approval question. It loads one scenario at a time in the
template's iframe. Each scenario file owns only its title, concise callouts,
and equivalent Before/After product surfaces; it must also remain usable when
opened directly. Delete unused example markup and replace every `{{TOKEN}}`.
Use the existing product's visual language inside scenario files; the artifact
should explain the change, not introduce a new design system.

- Put Before and After beside each other at wide widths and stack them in the
  same order on narrow screens.
- Use the same scenario, representative data, viewport, shell, and scale on
  both sides so the comparison is fair.
- Keep shared review chrome in `index.html`; do not duplicate it in scenarios.
   Keep product-specific styles with the scenario that uses them. If multiple
   scenarios share substantial product CSS, place it in a sibling stylesheet
   rather than copying it into every HTML file.
- Prefer one focused scenario file over hiding many states in one document.
   Split only decision-relevant scenarios; do not fragment one coherent
   comparison into separate Before and After files.
- Show only affected regions at enough fidelity to judge hierarchy, labels,
  controls, density, and state changes.
- Put the requested decision and material deltas before the comparison. Let the
  UI carry the explanation; avoid paragraphs that narrate visible details.
- Include error, empty, destructive, loading, or permission states only when
  they materially affect the decision.
- Use concise callouts tied to visible changes. Move implementation detail,
  exhaustive rationale, and validation evidence to secondary references.
- Make the first viewport useful. A reviewer should not need to read task
  history before seeing what changed and why.

Use static states by default. Add only the interaction needed to expose a
decision-relevant state, such as switching scenarios, opening a dialog, or
showing validation feedback. Do not recreate routing, persistence, backend IO,
or every production interaction.

## Preserve The Boundary

The artifact must say that it is an illustrative review aid, not production UI
or a normative behavior contract. It must not:

- silently add features outside the proposed change;
- use polished After styling to make an inaccurate Before look inferior;
- hide unresolved behavior behind a visually complete mock;
- copy secrets, private customer data, or production credentials;
- become the only record of error, privacy, authorization, or compatibility
  behavior.

## Validate What Humans Will See

Open `index.html` in a browser and inspect the actual rendered result. Also open
one scenario file directly to confirm it does not depend on the parent page.
When browser automation is available:

1. Capture or inspect one representative desktop width and one narrow mobile
   width.
2. Visit every scenario through the entry page. Confirm the iframe resizes to
   its content without nested scrollbars, clipped text, incoherent overlap, or
   document-level horizontal overflow.
3. Exercise every included interaction and verify its visible result. Confirm
   scenario links still work after opening the entry page from a local path.
4. Check keyboard order, visible focus, accessible names, dialog semantics, and
   focus restoration when the artifact includes interactive controls.
5. Confirm Before and After still use equivalent scenarios and data after
   responsive changes.

Report any check that could not be performed. Do not expand the prototype merely
to make the validation list longer.

## Present For Review

Give the reviewer only:

- the decision requested;
- the `index.html` entry point for the review bundle;
- the material changes and governing reason;
- unresolved risks or choices that affect approval;
- the normative source link, when applicable.

End with an explicit approval question that names the decision, rather than a
generic request for feedback.

Keep test logs, implementation inventories, and exhaustive alternatives out of
the primary review narrative.