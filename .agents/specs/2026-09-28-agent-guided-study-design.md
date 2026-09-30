# Agent-guided study design in Sheg

**Status:** Design accepted for planning handoff. This describes the target
agent and human experience; it is not an implementation plan or authorization
to begin implementation.

## Scope

This specification defines how an operating agent should use Sheg to help a
human turn text and a question into a feasible, reviewed study, assemble its
respondent cohort, run it through the harness, and interpret the results. It
covers the agent-facing product process and the semantic guidance Sheg must
provide. It does not prescribe a user interface, exact MCP method names, or an
implementation sequence.

### Goals

- Let a human start with an artifact and an underspecified question, without
  needing to learn study graphs or harness contracts first.
- Give the operating agent deterministic, concise guidance about what the
  installed Sheg harness can represent and how its study primitives compose.
- Help the agent and human reach an agreed study design, then construct and
  validate a runnable study from that design.
- Make respondent perspectives and branching journeys understandable in
  human terms.
- Preserve the human's original question and artifact through execution and
  interpretation.

### Non-goals

- Requiring the operating agent or human to become an expert in graph authoring
  or provider internals. The agent must still understand what consumes each
  task's finite input and how to use provider preflight.
- Requiring a connected System One model to author a competent study. A model
  connection is needed to run respondent inference; study optimization is a
  separate future capability.
- Treating one example question, reading behavior, or article study as the
  limit of the study primitives.
- Adding repeated human approval pauses for graph construction, validation, or
  preview after the human-readable design is approved.
- Prescribing a fixed results dashboard or canned interpretation in place of
  the operating agent's reasoning.

## Product intent

Sheg is a plugin for a user's own agent. A person brings their agent some text
and a question they want to explore with simulated respondents. Sheg supplies
both the tools and the process that teach the agent how to help its human partner
turn that starting point into a study, run it in the Sheg harness, and interpret
the results against the original question.

The human experience should begin in ordinary terms, not with study mechanics:

- What text or material are we asking about?
- What does the person want to ask or learn from it?
- Whose perspective do they want to ask?

The study graph, packet structure, and provider constraints are implementation
details unless they affect a decision the human needs to make.

## Agreed product direction

### Skills teach the agent; tools run the harness

Sheg ships skills that teach an agent how to collaborate on study design and how
to use the harness. These may be separate skills; the existing
`stimulus-response-polling` skill is not assumed to be the only one. Tool
contracts and schemas define the accepted inputs and outputs. The agent authors
and revises the study files using those contracts, then calls Sheg's tools to
validate and run them. Malformed, invented JSON is not a supported workflow.

The design skill should work like the brainstorming process used to shape this
direction: take an underspecified request, probe it with the human partner until
the intent is clear enough, and only then turn it into a governed study design.
It should guide rather than impose a fixed questionnaire. The agent may propose
a path, ask the human to supply an idea, or work through alternatives together.
It should use sensible defaults where possible and surface assumptions that
could change the study or how its results are interpreted.

### Explore real capabilities before proposing a study

Before proposing a study, the agent should learn what the current harness can
represent from the documentation shipped with Sheg's study-design skill. This
is product knowledge, not a request to a model or a mandatory capability-list
tool call. The skill and its detailed references are the deterministic guide to
the primitives, accepted tool contracts, study-design process, provider limits,
and current support. The operating agent reads that guidance, compares it with
the stimulus and the human's rough question, and forms a feasible proposal.

The documentation must explain semantic building blocks and how they compose,
not merely expose MCP parameter shapes or JSON Schema. It must let an agent
learn quickly what a study, arm, task, respondent, journey, and decision packet
mean; what a respondent can be shown and asked; how choices route a journey;
how prior events reach later decisions; and which capabilities the installed
harness supports today. MCP tools provide means to act, inspect, validate,
measure, and run when those actions require the harness. They do not replace
documentation of Sheg's product or require a tool call for static knowledge.

The result should constrain recommendations to designs the current harness can
represent. If the request cannot be represented, the agent should say what is
unsupported and offer a feasible alternative. If the alternative changes what
the study is asking, the agent gets the human's agreement before drafting it.

Keep harness capability separate from provider context fit. Capability
exploration answers whether the harness can represent the design. Once there is
a concrete study, preflight checks whether every path fits the configured
provider assumptions. The agent needs the reasoning behind that check to make
good design choices, not just a compact-profile slogan.

Each respondent decision is a separate, stateless model request with a finite
input budget. In conceptual terms, the input for one respondent at one task is:

`provider framing + respondent profile + stimulus text in scope + current task and response options + prior journey context + serialization overhead`

The provider's own framing and serialization count too. The journey history is
carried into later requests; the input does not accumulate as a live model
session, but each later packet can grow as that history grows. For the current
harness, sequence studies include all arm items in scope at every task. Graph
studies include the items exposed since the previous decision, plus a compact
trajectory of earlier choices and exposure metadata. The packet also includes
the current task's instructions and offered options, and the respondent's five
profile fields. It excludes unexposed stimulus, answer keys, other arms, and
study metadata. The study-design skill and its packet-budgeting reference
should explain these
inclusion rules so agents can predict which design choices add input at a
given task.

Teach the agent to reason about the whole packet: preserve the stimulus needed
to ask the question, split material into deliberate respondent-eligible beats
when that serves the study, keep task instructions and options focused, write
profiles with only distinctions that can affect responses, and understand
which earlier decisions the current trajectory carries. The author's intended
stimulus and question remain authoritative; the agent must not silently cut or
rewrite them just to fit. It should use preflight to inspect every respondent,
arm, path, and decision, then explain where a provider stops fitting and what
design dimensions contribute to the packet.

Provider budgets differ. Laya's configured limit is 1,024 tokens, measured with
the pinned tokenizer used by the adapter. Jev is designed against a 32K context
with headroom: Sheg estimates input tokens from serialized request bytes and
reserves 20 percent, so that result is a useful fit estimate rather than an
exact Jev token count. The skill and preflight guidance should expose
these assumptions plainly. A design may fit on Jev after it stops fitting on
Laya because each task sends the combined packet described above.

Study authors need a fast, deterministic sizing operation while composing a
design, before they have a complete study and frozen cohort. It should let an
agent vary any part of a candidate packet: respondent profile, stimulus in
scope, task wording and response options, and prior journey context. Shared
context should be reusable across variants. For example, one respondent and
one stimulus can be checked against 30 task drafts, or one task can be checked
against 30 profiles. One call measures the resulting complete packets without
contacting an inference provider.

The agent must be able to specify whether variants are explicit paired cases
or a Cartesian product across selected dimensions. Do not infer a Cartesian
product when the author has only supplied a list of alternatives. Return each
measurement with a stable case identity and the per-provider input size and
fit, plus the largest case for each provider. The largest case can differ by
provider tokenizer; identify it and resolve ties deterministically. This lets
the agent compare drafts, find oversized profiles or tasks, and confirm that
all intended respondents fit.

The same operation should accept a multi-step journey description and report
the packet size at each decision, including the history that can reach it. If
choices create different histories or stimulus exposure, report each distinct
reachable packet. Bound the total measurements per call and report when a
request exceeds that bound. Keep this incremental sizing operation separate
from the whole-study preflight: it helps the agent iterate on selected packet
variants or a short journey, while final preflight still walks every path for
the complete study and frozen cohort. Both use the same packet compiler and
provider measurement assumptions as execution, produce structured deterministic
results, and make no inference calls. Report input count, limit, reserve or
estimation basis, headroom, and fit status per provider; distinguish an
unconfigured or unmeasurable provider from a measured overflow. The whole
serialized packet count is authoritative; component diagnostics explain its
contents but need not sum exactly because token boundaries and provider framing
affect the total.

### Study designs are compositions of flexible primitives

Study tasks should not be reduced to the example question "will you continue
reading?" A study can expose one or more pieces of stimulus and ask a relevant
question at a chosen point, with explicit response choices and branches. For a
sectioned article, those questions might ask whether a respondent is still
reading intently, feels satisfied enough to stop, or is losing interest. Other
questions can explore the author's intent. The design skill should discover
which questions fit the human's goal and compose the harness primitives to
express them.

The question is authored in human terms, then paired with a typed response
primitive that fits what the study needs to measure:

- **Choice:** select one option from a named set of answers.
- **Score:** make a bounded judgement against an explicit scale or rubric.
- **Noul:** answer a yes/no question with a probability for the selected
  outcome.

These are reusable task building blocks, not special modes for particular
study genres. A study may use different response types at different tasks.
When a response controls a branch, an explicit threshold or predicate defines
how the typed result maps to the next route. The study-design references must
explain each response contract and its composition with routing, and state
which forms the installed harness and configured providers support. The design
target includes Choice, Score, and Noul; documentation must distinguish that
target from the actual shipped subset rather than imply an unavailable type
can already run.

Reading mode is an ordinary task dimension, not a special measurement feature:
the task defines typed choices such as close reading, skimming, or stopping,
and the model selects among them using the respondent profile and current
context. The same task primitive can ask about any dimension the study is meant
to explore.

The aside example establishes a history requirement: a later offer can depend
on an earlier choice, even after several other sections. A later task may need
to be reminded what they chose earlier. The journey record retains the full
event history, and later decision packets receive trajectory context so a
stateless model can use earlier choices. The current compiler includes prior
choices in that trajectory; selective relevance and compaction are future
optimization work, not a prerequisite for authoring a study.

### Propose respondent archetypes and expand them into profiles

The agent should help identify who should respond. Sheg's bundled archetypes are
an evolving catalogue of suggestions, not a fixed required audience. The agent
may propose catalogue archetypes, adapt or create its own, accept ideas from the
human, or develop archetypes with the human.

The design process should let the agent recommend an archetype set and a
weighted expansion into distinct respondent profiles. For example, it might
propose four archetypes and a 30-profile cohort weighted toward two of them.
The agent recommends a sensible profile count and weighting based on the
study's goal and the perspectives needed, then lets the human steer that
proposal rather than requiring the human to choose a count first.
The agent discusses this plan with its human partner. Depending on the
conversation, it may show the expanded profiles or continue after summarizing
the resulting cohort. Cohort creation is based on archetypes expanded into
concrete profiles, then frozen for a run.

Profile schemas enforce per-field and aggregate prose limits so a valid cohort
cannot consume unbounded context. These caps bound one component of every
respondent task packet; they do not guarantee the complete packet fits a
provider. The agent should understand how profile text competes for room with
stimulus, task wording, response options, history, and provider framing. It
should write profiles for useful distinctions and compact perspective, not
fill each field up to its maximum. Profile-generation guidance should teach
that reasoning and encourage concise, relevant wording. The current profile
contract limits each of its five prose fields to 500 characters and their
combined length to 1,500 characters, with runtime validation enforcing the
aggregate cap.

### Review the respondent journey in human terms

Review the journey separately from the cohort. Describe one generic respondent
and all the ways their journey can branch. The preview should explain what
stimulus they see and when, what they are asked, what choices are offered, what
happens next, and when an earlier choice is recalled. For example, it should
show that a respondent who declined an aside at section 3 may be offered it
again at section 7 and reminded of that earlier choice.

The preview should be produced from the same accepted study contract that
Sheg executes, so the human reviews the actual designed experience. The graph
need not be shown to explain the branches. Show one generic respondent's full
branching outline, include every choice and consequence, and show shared
continuations once rather than repeating each complete end-to-end path.

### Keep capability explanations specific

People using Sheg understand that respondents are simulated. Do not repeat
generic reminders that simulations are not real people. Explain a limitation
when it affects whether the harness can represent the requested study or when
an alternative changes the study's meaning. Keep those explanations concrete
and actionable.

### Help interpret results against the original question

Sheg helps the agent design the study, optimize it when that future capability
exists, run it, and provide the results. The operating agent then interprets
those results editorially, using its own judgement in relation to the human's
original question and the artifact under review. It can discuss what the
patterns suggest, what seems surprising, and ask the human what they think the
results say. This is an open reasoning conversation, not a prescribed result
view or report format.

For the flagship question "which section loses interest?", interpretation
should show where task responses cluster across a varied cohort. It should help
identify sections associated with respondents reporting lost interest,
stopping, or skimming; whether these patterns cluster around particular
archetypes; and cases where a reading-mode choice is incongruent with an
otherwise close-read journey. These are patterns in ordinary task responses,
not special analytics inferred outside the study design. It should support
comparing an original article arm with a changed or rewritten section, using the
same frozen cohort across arms so the agent can inspect how matched respondents'
journeys differ.

The useful result is the pattern and its traceable respondent/task evidence,
not a single opaque score. The agent should connect the observed pattern to the
human's question and point to the sections, archetypes, tasks, and arm changes
that support its interpretation.

### Study pipeline

The agreed near-term process is:

1. The operating agent learns Sheg's semantic primitives and how to compose a
   competent study from them. Study construction does not require a connected
   respondent provider.
2. The agent works with its human partner from the stimulus, the question they
   want to explore, and the respondents they want to ask. They reach and
   approve a study design in human terms.
3. The agent builds the study graph from the approved design and Sheg's
   primitives. Sheg validates it and can produce the generic respondent
   journey preview. These are agent implementation and validation steps, not
   additional approval gates. If the graph cannot implement the approved
   design, the agent returns to the human only to resolve that design change.
4. The operating agent works with its human partner to create and review the
   respondent cohort, using proposed or human-supplied archetypes and expanding
   them into concrete profiles. It recommends a sensible count and weighting
   based on the study goal and perspectives, then lets the human steer.
5. With the graph, cohort, and provider settings assembled, the agent
   preflights and reports that the study is ready, with the reachable range of
   respondent decision calls and the configured spend ceiling when the
   provider is paid. These are deterministic bounds, not probabilistic
   predictions; actual Jev charges come from provider-reported usage after the
   run. The human approves this run, then the agent starts it in the harness
   and helps interpret the results against the original question.

The approval points in this near-term flow are approval of the human-readable
study design and approval to start the respondent run. Graph construction,
graph validation, and journey preview do not each add another approval pause.
The cohort changes who responds; it does not change the study design. The
future optimization seam is described separately and is not part of this
near-term pipeline.

## Illustrative journey

Human: "Use Sheg and run a reader poll on this article. I want to know which
section loses interest."

The agent first uses Sheg's capability guidance to understand what the harness
can express. It may then work with the human on how to ask the question at each
section, who should respond, and how to divide the text into stimuli. It can
propose archetypes and profile weights, draft the study, and show a generic
respondent's complete branching journey. After the human recognizes and approves
the design, the agent validates the graph, previews every branch, builds and
reviews the cohort with the human, and preflights configured providers. It
reports the reachable call range and configured paid-spend ceiling, gets the
human's approval to run, then runs the study and interprets the results against
the original question and artifact.

This example is illustrative, not a required script or fixed sequence of
questions.

## Current repository context

The repository already has a Codex plugin, a study-authoring and harness skill,
strict study and respondent contracts, archetype catalogues, sequence and graph
presentations, exhaustive packet preflight, and tools for checking, tracing,
running, and interpreting polls. The design direction above expands the
agent-facing study-design process around those existing harness capabilities.

### Current study-building blocks

The current conceptual composition is:

- A **study** has a title, purpose, and one or more arms.
- An **arm** has source references, stimulus items, tasks, and a presentation
  that determines their order or branching.
- A **stimulus item** is a named piece of text. A source reference records the
  source path and its digest.
- A **task** is one model decision: instructions plus a typed response contract.
  The current executable task contract is finite choice. `unanswerable` is an
  ordinary explicit option when relevant, and optional `answerKeyOptionId` is
  scoring metadata that is never sent to a provider. Score and Noul are
  additional target primitives for study composition; the shipped skill
  reference must distinguish this target from what the installed harness can
  execute.
- A **presentation** is either a sequence or a graph. A sequence exposes the
  arm's items and then asks its tasks in order. A graph connects exposure,
  ask, and terminal nodes; each offered option has a transition. Graph journeys
  are finite and every branch must reach a terminal.
- A **cohort** is separate from the study manifest. It contains concrete
  respondent profiles and may include the archetypes from which they were
  developed. Each respondent profile supplies a bounded perspective.
- A **journey** is one respondent moving through one arm. It records ordered
  exposure and choice events. The same frozen cohort is used across the arms
  in a run.
- A **decision packet** is the stateless model call at an ask node. It contains
  the current task, the respondent's perspective, stimulus text in scope at
  that point, and a trajectory summary derived from earlier events.

The journey history is currently an event log of stimulus exposures and
choices, not a separately authored set of named state variables. Packet state
is derived from the profile and event history at each decision. The graph routes
on the current task's selected option; earlier choices remain in the trajectory
so a later task can refer to them. Sequence mode keeps all arm items in scope at
each task. Graph mode includes the stimulus items exposed since the previous
decision, with older exposure text represented by history metadata.

The current packet compiler includes all prior choices in the trajectory. A
three-turn lookback in the brainstorming example is illustrative; it is not a
current Sheg default.

The currently executable provider adapters and task contracts support Choice.
Score, Noul, and deterministic threshold-based routing are product-level
building blocks for the target study vocabulary; the shipped study-design
references must describe them as unavailable until the harness and relevant
providers implement their contracts.

This is the harness model today, not a limit on future study-design concepts.
History compaction and relevance-based context selection belong to the future
optimization seam below.

## Design acceptance criteria

A design implementing this specification should satisfy the following:

- An agent can start from an artifact and a rough human question, discover
  Sheg's supported study capabilities, and propose a design without requiring
  the human to author graph files or understand provider internals.
- The agent explains unsupported requests in concrete terms and offers a
  supported alternative; it gets agreement before changing the question being
  studied.
- The human approves the study design in ordinary language. The agent then
  authors and validates the graph and can show every branch as a generic
  respondent journey without adding approval pauses for those steps.
- The agent recommends archetypes, a cohort size, and weighting based on the
  question and needed perspectives, then lets the human steer. Matched arms use
  the same frozen cohort.
- The agent writes concise respondent profiles within schema-enforced field
  and aggregate limits instead of treating the maximum as a target.
- The agent can discover the semantics and current availability of Choice,
  Score, and Noul response tasks, and deterministic thresholds for routing
  typed results.
- A generic journey preview from the accepted study contract shows every
  branch, stimulus reveal, task, offered choice, destination, and recalled
  earlier choice; shared continuation nodes are represented once. It needs no
  cohort or inference provider.
- Preflight reports configured provider fit across reachable paths, the
  deterministic minimum/maximum respondent decision-call range, and the
  configured spend ceiling for paid providers. It does not claim a
  probabilistic expected charge; actual Jev charges come from provider usage.
  The human explicitly approves the actual respondent run.
- Study-authoring guidance explains the components of one respondent-task
  input, the provider-specific budget assumptions, and how stimulus placement,
  task wording, profile text, and carried history contribute. It teaches the
  agent to use all-path preflight as feedback while preserving the author's
  intended stimulus and question.
- An agent can batch packet variants across profiles, stimulus, tasks, and
  trajectory, explicitly choose paired cases or a Cartesian product, inspect
  each provider fit and the largest case, and size each decision in a short
  branching journey. Sizing is deterministic, bounded, uses the execution
  packet compiler, and makes no inference calls.
- Results preserve the evidence needed for the operating agent to reason about
  responses by task, respondent, journey, and arm. The agent interprets those
  results against the original question and artifact using its own judgement,
  and discusses that interpretation with the human.
- Study authoring and validation remain possible without a connected inference
  provider. Optimization is excluded from this near-term specification.

## Deferred design seams

The semantic requirements for the study-design documentation and cohort
proposals are defined above. The exact skill-reference structure can be
selected during implementation, provided it meets those requirements. The
operating agent's interpretation is intentionally left to its editorial
judgement in conversation with the human partner.

### Future design seam: study optimization

Optimization is a future design seam, outside the near-term study-authoring and
run workflow. The broad direction is that Sheg may use a connected System One
model to improve a study's shared context policy, with changes fixed across all
respondents who reach the same point. It must not make ad hoc per-respondent
runtime pruning decisions. The design, evaluation, cost, and any approval
mechanism should be explored when optimization becomes an active product goal;
they are not current workflow requirements.

Previously discussed examples can seed that future work: history relevance by
decision point, compact stimulus context around a relevant choice, and one
deterministic policy applied to every respondent on that route.

## Design constraints

- Do not expose graph mechanics as a prerequisite for authoring a study.
- Do not recommend a design the current harness cannot represent.
- Do not treat an example task as the limit of the task primitives.
- Do not silently change the human's research question to fit a proxy.
- Do not choose a respondent cohort or weight distribution without making the
  proposal understandable to the human partner.
- Do not replace deterministic journey execution and packet construction with
  unreviewed generative behavior.
