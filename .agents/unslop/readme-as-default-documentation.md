# README as the default documentation destination

## Recognition and applicability

Apply this guard when documenting a product change, reviewing documentation added with source work, or proposing any README edit. The mistake is reasoning that something changed, therefore it needs documentation, therefore that documentation belongs in README. Common symptoms are new front-page sections containing environment variables, platform paths, recovery procedures, pre-release transitions, or implementation details whose reader is already operating or maintaining Sheg.

## Corrective action

Before editing, identify the reader, the task they need to complete, and the document that owns that task. Inspect the existing guide and its routes. Put operational instructions in the relevant guide, architecture choices in an ADR, agent workflow in its runbook or playbook, and shipped agent instructions in canonical skills. Update the owner and add a useful link from the point where the task arises. Do not duplicate the procedure on the front page.

README is Sheg's human-facing orientation: what it does, a meaningful example, how to install and start, and where to learn more. Before adding anything there, state which of those reader tasks the addition supports and why the existing orientation or a link cannot serve it. If the content only explains a changed implementation, an operator setting, or development history, leave README alone. During review, inspect every README addition against that stated reader task and remove or relocate content that has no front-page purpose. A heading that sounds like a product benefit does not justify operational detail beneath it.

## Exceptions

A change to product purpose, supported installation, prerequisites, or the first-use experience can require a README update. A concise link in Learn more can help readers reach a guide. Judge the actual reader task; do not ban all technical vocabulary or force relevant first-use instructions into a hidden document. Explicit human direction governs placement.

## Observation and effectiveness

In dev.17, commit `8aa867d1fb0ef243b0ff44f5164ed2acd37db6f2` added datastore paths, overrides, and pre-release transition details to README despite the recent front-page cleanup. Human review identified the misplaced operational content. Commit `67fd6d5bf8a63bc8489d8e045cc391e13fbfef15` removed it, and `43d5ba4b799aa161855a74bbea7dce6be4ab9a4f` routed the datastore guide from installation guidance. These are one incident and its correction, not three independent occurrences. This specific guard did not exist at the decision point; its later readership and effectiveness are unknown. Add distinct evidence when later work shows whether the placement check was reached, followed, and useful.
