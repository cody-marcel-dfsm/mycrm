# FSM authoring

## Workflow

1. Translate the user's automation goal into explicit states, transitions, terminal goals, and semantic capability effects.
2. Discover the current organization's capabilities and use only identifiers returned by BOS.
3. Generate a `bos.fsm/v1` `CrmAutomation` document. Keep provider routing and credentials out of the graph.
4. Run local structural validation for graph shape, unique identifiers, valid references, and reachability.
5. Select a graph-validation operation only from the current My CRM MCP tool catalog or a compatible resource-owned operation contract. BOS resolves capability grants, schemas, permissions, runtime policies, and compatibility.
6. Present the normalized graph, validation findings, runtime implications, and any changes for user review.
7. Install and activate only through currently advertised My CRM operations after the applicable confirmation.
8. Invoke an instance through the current operation and report its server-issued identifiers and lifecycle state.

## Explain plan

An automation explain plan is read-only. Show the proposed graph, semantic capabilities, transition guards, effect parameters, failure paths, compensation strategy, approval points, and intended discovered MCP operations. Mark unresolved capability bindings clearly.

## Graph rules

- Exactly one entry state is required.
- At least one reachable goal state is required.
- State and transition identifiers are unique.
- Every transition references declared states.
- Every effect uses a semantic capability identifier present in current discovery.
- Parameters may contain user-approved values and graph expressions; they may not contain credentials or provider-specific routing.
- BOS validation is authoritative. Local validation is an authoring aid.
- An absent lifecycle operation returns the local draft and a missing-capability result. It never triggers an assumed HTTP route or private service call.
