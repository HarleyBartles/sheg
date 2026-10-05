# Operating standards certification

Sheg subscribes to the immutable `unslop`, `playbook-composition`, and `runbook-composition` definitions listed in [operating-standards.json](operating-standards.json). The pinned source is the Agent Asset Marketplace repository at commit `88c02ec6804fd695e43bf6a632c61014a21738f4`; each entry records its definition path.

The repository's adoption and routing decision is recorded in [ADR-0034](../../docs/decisions/0034-adopt-routed-agent-operating-standards.md).

The implementation lives in `.agents/unslop/`, `.agents/playbooks/`, and `.agents/runbooks/`. Root [AGENTS.md](../../AGENTS.md) routes agents to this subscription and certification; the [runbook and playbook policy](../doctrine/repo-runbook-policy.md) describes the lifecycle and concern routes.

Sheg gives the loose upstream playbook standard a local implementation: every concern guide uses Applicability, Method, Constraints, Verification, References and routing, and Maintenance in that order, as defined in the policy. Gitflow owns branch and release routing, version alignment owns release identity, and source quality owns implementation and review concerns. Their methods include the capabilities, decisions, constraints, and evidence needed for those concerns; empty capability inventories are omitted. Each is reached from implementing and PR stages and links back to those applicable lifecycle procedures.

When authoring or changing a playbook, review its applicability against actual repository work, trace its method through the current commands and policy owners, check whether its constraints prevent the relevant mistakes, and assess whether its verification establishes the stated result. Inspect stage routing in both directions and maintain the guide when those dependencies change. The author maintains this certification in the same change; PR review independently assesses its semantic claims. Uniform structure supports review but does not establish usefulness or agent readership.

Agents consult the source-quality playbook and its applicable profiles when implementing or reviewing source changes. They preserve one owner for each domain rule, validate untrusted data at boundaries, share genuinely common behavior while retaining distinct public contracts, and avoid repeated work when the same operation already provides the required evidence.

When a distinct mistake matches a profile, the agent records a durable reference in that profile, checks whether prior evidence is independent, and assesses whether the guard was reachable, followed, and useful. A successful change alone does not establish profile effectiveness. Narrow, consolidate, revise, or retire profiles only when later evidence supports that choice.

`npm run guidance:check` validates subscription metadata, local Markdown links, the required ordered and populated sections of every playbook, inventory registration, applicable stage links and their inbound routes, and the source-quality profile routes. It checks commit syntax rather than fetching or establishing upstream provenance; pin changes require inspecting the immutable source definition. Reviewers judge concern category, method usefulness, current policy accuracy, evidence sufficiency, and maintenance obligations. These mechanical checks do not establish readership or behavioral effectiveness.
