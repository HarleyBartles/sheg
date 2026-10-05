# Operating standards certification

Sheg subscribes to the immutable `unslop`, `playbook-composition`, and `runbook-composition` definitions listed in [operating-standards.json](operating-standards.json). The pinned source is the Agent Asset Marketplace repository at commit `88c02ec6804fd695e43bf6a632c61014a21738f4`; each entry records its definition path.

The implementation lives in `.agents/unslop/`, `.agents/playbooks/`, and `.agents/runbooks/`. Root [AGENTS.md](../../AGENTS.md) routes agents to this subscription and certification; the [runbook and playbook policy](../doctrine/repo-runbook-policy.md) describes the lifecycle and concern routes.

Agents consult the source-quality playbook and its applicable profiles when implementing or reviewing source changes. They preserve one owner for each domain rule, validate untrusted data at boundaries, share genuinely common behavior while retaining distinct public contracts, and avoid repeated work when the same operation already provides the required evidence.

When a distinct mistake matches a profile, the agent records a durable reference in that profile, checks whether prior evidence is independent, and assesses whether the guard was reachable, followed, and useful. A successful change alone does not establish profile effectiveness. Narrow, consolidate, revise, or retire profiles only when later evidence supports that choice.

Mechanical checks validate the subscription shape, pinned revisions, local Markdown links, and the declared routes from root guidance through runbooks and playbooks to profiles. Reviewers judge whether the documents have the right category, applicability, behavior, and false-positive boundaries. These checks do not establish readership or behavioral effectiveness.
