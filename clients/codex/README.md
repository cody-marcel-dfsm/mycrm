# My CRM codex distribution

Package: `plugins/my-crm`.

Install BOS for this host first. From a published My CRM release checkout:

```bash
codex plugin marketplace add ./clients/codex
codex plugin add my-crm@my-crm
```

Restart the host and confirm all eight My CRM skills are available. Use the root README for native verification and update guidance.

SKILL.md supplies the instructions. agents/openai.yaml is optional Codex UI metadata; these packages retain it with the complete source trees.
