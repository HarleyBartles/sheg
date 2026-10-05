# README as the default documentation destination

## Recognition and applicability

Apply this guard when documenting a product change, reviewing documentation added with source work, or proposing any README edit. The mistake is reasoning that something changed, therefore it needs documentation, therefore that documentation belongs in README. Common symptoms are new front-page sections containing environment variables, platform paths, recovery procedures, pre-release transitions, or implementation details whose reader is already operating or maintaining Sheg.

## Corrective action

Before editing, identify the reader, the task they need to complete, and the document that owns that task. Follow the [documentation audience policy](../doctrine/repo-runbook-policy.md#documentation-audiences-and-ownership): `docs/` serves human users and developers, `.agents/` serves agents working in the repo, and canonical skill references ship instructions for agents using Sheg. Inspect the existing guide and its routes. Put operational instructions in the relevant guide, architecture choices in an ADR, agent workflow in its runbook or playbook, and shipped agent instructions in canonical skills. Update the owner and add a useful link from the point where the task arises. Do not duplicate the procedure on the front page.

Write live guidance as current truth. Remove development narratives such as "before dev.N" or "dev.N stops", completion announcements, and test results instead of relocating them from README into another guide. Git and PR history already record those changes. Preserve technical content that serves the human reader's task; do not mistake human developer documentation for agent instructions.

README is Sheg's human-facing orientation: what it does, a meaningful example, how to install and start, and where to learn more. Before adding anything there, state which of those reader tasks the addition supports and why the existing orientation or a link cannot serve it. If the content only explains a changed implementation, an operator setting, or development history, leave README alone. During review, inspect every README addition against that stated reader task and remove or relocate content that has no front-page purpose. A heading that sounds like a product benefit does not justify operational detail beneath it.

## Exceptions

A change to product purpose, supported installation, prerequisites, or the first-use experience can require a README update. A concise link in Learn more can help readers reach a guide. Judge the actual reader task; do not ban all technical vocabulary or force relevant first-use instructions into a hidden document. Explicit human direction governs placement.

## Observation and effectiveness

Commit `8aa867d1fb0ef243b0ff44f5164ed2acd37db6f2` contains the observed failure: datastore operations and a pre-release transition were placed on the front page despite its established orientation role. Moving the transition narrative into an operational guide retained the stale-history problem. This is one incident, not independent recurrence. The guard was absent at the original decision point; later readership and effectiveness are unknown. Record distinct mistake evidence and guard reach or effect when established, without turning this profile into a work-completion log.
