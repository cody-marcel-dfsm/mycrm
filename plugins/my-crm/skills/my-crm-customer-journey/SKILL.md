---
name: my-crm-customer-journey
description: Show a CRM lead's application-owned current state, history, goals, graph paths, gates, blockers, and next actions from verified My CRM evidence.
---

# My CRM Customer Journey

Use this skill whenever a lead is displayed and whenever the user asks where a customer is, how they arrived there, what comes next, or how to reach a goal.

Inspect graph resources advertised on the authenticated My CRM connection first. Select resources by their declared application and contract metadata; never construct a URI or supply an authority selector. Use current discovery only for missing evidence. A listed connected graph can supply topology directly.

Keep four evidence classes separate:

- graph facts from the application-owned graph;
- record facts including current node and transition history;
- external evidence from independently identified services; and
- GPT inference labeled as inference.

Validate one graph version and digest, unique node identities, valid directed edges, canonical goals, and the record-to-graph binding. Trace directed paths locally from the verified current node. Topology establishes structural paths; it does not establish transition completion or eligibility.

Lead with a Mermaid flowchart containing the current node, exact intermediate states, goals, relevant branches, conditions, and blockers. Follow it with the same route in plain text. Use server-ranked preferred paths when supplied; otherwise a shortest structural path may be labeled **eligibility unverified**. Never infer a stage or transition from list order, chronology, or sales convention.

When supported reads cannot establish a graph route, show a clearly labeled partial journey using verified milestones only. Preserve the missing operation and freshness limitations.
