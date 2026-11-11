# Claude Code

Read and follow `AGENTS.md`; it is the repository contract for every agent.

Skills (canonical copies in `.agents/skills/`, plain mirrors in `.claude/skills/`):

- `my-crm-implementation` — sync-in, local Oracle proposal to sealed spec,
  implementation, selected validation, re-sync and publication.
- `ship-it` — shipment and native publication of outstanding commits.

The Oracle approver skill in `.agents/skills/oracle/` belongs only to the
isolated Oracle process. Call `npm run oracle:proposal` and `npm run
oracle:review`; never load, adopt, quote or impersonate that skill.

Edit the `.agents/skills/` copy first and copy it unchanged into `.claude/skills/`
in the same change.
