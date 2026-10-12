# Individual CRM detail completion

A named-person lead/contact lookup, profile or single-field request includes
journey presentation. Preserve that intent through a workspace clarification
and load `my-crm-customer-journey` before completing a successful individual
lookup, even when search returns an array. Use the identity and source evidence
already returned; resolve ambiguous matches before a targeted journey read.
Broad lists retain their filters, ordering and pagination. Honor explicit
text-only requests and preserve the scope of focused workflows owned by other
products.

Use the packaged [domain display planner](../scripts/plan-detail-display.mjs)
when local script execution is supported. Its stdin/stdout CLI accepts a local
projection of verified public observations: `intent: "individual-detail"`,
`identity: "exact"` only after disambiguation, `current: {id, label}`, optional
`topology: {nodes, edges}`, the resolved `goal`, optional server `ranked_path`,
and `view` (`compact`, `shortest`, `full` or explicit `text`). Nodes carry public
`id` and `label` with any source-declared `goal`, `gate` or `blocker`; edges carry
public `from`, `to` and returned labels/conditions. A failed topology read supplies
its exact `read_failure`. Supply `eligibility: {path, status}` only from a
source's explicit assessment of that exact path; otherwise leave it unverified.
An assessment of a different route cannot establish eligibility for the selected
one. This is a client presentation projection, never a
server request or schema: derive its facts from current discovered contracts,
copy no private identifier or authority, and perform no persistence or mutation.

Retain the original `individual-detail` intent after workspace clarification.
Honor the planner's `journey_required` completion gate and its missing-state,
identity, graph or goal requirements before returning. Use only the selected
nodes and edges for rendering. The planner preserves required route states and
conditions and computes no execution-eligibility claim. When local script execution
is unavailable, apply the same completion and selection rules below directly.

Resolve the current node and the explicit or application-described positive
goal from currently advertised evidence. Select one compact route: use the
application-ranked path when returned, otherwise choose a shortest structural
path from verified directed topology. An explicit shortest-path request chooses
the fewest verified transitions; report a differing app ranking as a short note.
Keep ties and ranking provenance visible below the graph, and label structural
eligibility unverified. Preserve all required intermediate states, conditions,
gates and blockers on the selected route. Source evidence determines whether
the path is available; conventional stage names never establish an edge.

Delegate rendering to installed BOS visualization with only the selected path's
states and transitions, bold route labels, thick green arrows, and a clear
current-state marker. Use concise transition labels on edges. Render full
topology, cycles, off-route approvals or negative branches when the user
explicitly requests that view. Keep profile fields, freshness, source provenance,
alternative-path notes and action eligibility below the compact graph.

Continue advertised journey/graph/goal/path reads after a current-state-only
record result. An empty actions array or missing optional history leaves
independent topology evidence usable. For a specific failed or unavailable read,
preserve every verified graph fact, show a labeled partial current-state graph
through BOS visualization and identify the exact missing evidence. With no
verified state, report the gap without fabricating a node or path. A text-only
profile or activity timeline leaves an ordinary resolved detail request
incomplete.

After successful create/update, complete existing post-mutation cache maintenance
once before any cache-backed display read. Obtain missing display evidence
without replaying the mutation. Preserve confirmed outcomes if a display read
fails; use historical labeling for deleted records and invent no new graph state.
