---
name: my-crm-automation
description: Explain, generate, validate, install, activate, or invoke customer-specific CRM FSM automations through current My CRM MCP operations.
---

# My CRM Automation

## Explain and generate

Resolve the selected organization and refresh the My CRM operation and resource contract. Translate the user's goal into explicit states, transitions, guards, terminal goals, failure paths, and effects. Bind every effect to an exact semantic capability identifier returned by current discovery. Never invent an operation identifier or embed provider routing, credentials, tenant identifiers, or record data in the graph definition.

Run the local deterministic FSM generator for structural checks. Treat its result as a draft until a discovered server validation operation accepts the graph in the current product scope.

For `explain`, show the proposed graph, capability bindings, sanitized parameter shapes, approvals, failure behavior, and intended live operations. Stop before server validation or execution unless the user asks to proceed.

## Server lifecycle

Use graph validate, install, activate, and invoke operations only when they are advertised by the current My CRM MCP catalog or its resource-owned operation contract. Follow each exact schema and side-effect class. Preserve server-issued graph identity, version, digest, approval bindings, and idempotency requirements.

Fail closed when an operation is absent. Return the structurally valid local draft and identify the missing semantic contract. Never call an assumed REST path, database, private server API, or provider API.

Reconcile uncertain lifecycle mutations by server-issued operation identity before replay. Report completion only from the actual operation result.
