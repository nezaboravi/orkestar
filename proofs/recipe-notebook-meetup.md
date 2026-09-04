# Recipe Notebook: meetup acceptance brief

## Prompt to give Lenka

Build a polished recipe notebook in this fresh Laravel project. Include a
public landing page, Features and About pages, and a usable recipe library
with create, view, edit, delete and search. Use the installed Laravel stack.
Keep it local; no deployment, publishing, purchases, or database resets.

Start with a product designer using the strongest verified available model.
I want a contemporary editorial food/product identity, not a default Laravel
welcome page or a generic admin dashboard dressed up as a marketing site.
Define typography, color, spacing, responsive composition, imagery treatment,
and the key interaction states before the planner and builder start.

Use Taskavel visibly: create one demo project, create scoped tasks, and move
them through the actual board columns as work progresses. Verify the writes.
Do not put tasks in Done until the independent review and audit pass. If OAuth
is needed, ask me to authenticate and then resume in this project.

Delegate the work through the designer, planner, builder, tester, frontend QA,
independent security/performance reviewer, and auditor. Repair verified scoped
defects and re-review. Show the actual roles/models and available usage at the
end; never invent unavailable costs. Proceed without showing me the plan first.

## Design acceptance

- Landing: distinct art direction, strong typographic hierarchy, a clear value
  proposition and real navigation into the application. No fake testimonials,
  customer counts, awards or invented commercial pricing.
- Marketing pages: useful Features and About content with consistent navigation
  and footer, not empty templates or duplicated hero sections.
- Recipe library: responsive cards/list, useful search, clear empty state and
  readable ingredient/method sections. Forms include validation and error states.
- Imagery: use approved/local assets or deliberate graphic treatments; do not
  depend on unstable hotlinked images or download unlicensed assets.
- Desktop and mobile: no horizontal overflow, readable contrast, keyboard focus,
  sensible touch targets and accessible labels. Review actual rendered pages.
- The designer reviews the implementation against the brief after frontend QA.
  A technically green test suite does not approve an unfinished visual design.

## Behavior and orchestration acceptance

1. Create a recipe, reload, search for it, edit it, and verify persistence.
2. Verify invalid input, empty search, missing recipe and delete confirmation.
   Use only disposable records created for this test; respect approval policy.
3. Open every public page on desktop and mobile; inspect browser console and
   failed network requests. Capture representative screenshots as evidence.
4. Check input/output handling, authorization where applicable, query behavior,
   pagination/search bounds, asset delivery and relevant performance risks.
5. Retain independent review findings, exact reproductions, repairs and re-review.
6. Confirm the Taskavel tasks and column transitions through fresh reads.
7. Separate application status from orchestration status. Any missing promised
   proof, agent identity or required tracker integration prevents a full DONE.

## Launch choice

This run uses Codex inside Solo: `lenka up solo codex`, after installing the
verified release. Cross-provider Claude design delegation is a capability
question only, not part of this run's authorization. Do not silently switch
the chosen harness or presume a particular Claude model is available.
