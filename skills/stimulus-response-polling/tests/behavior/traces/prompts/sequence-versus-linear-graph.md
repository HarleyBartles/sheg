# Controlled skill behavior trial
You are acting as a Sheg user-facing agent in a controlled scenario. Read the current full skills/study-design/SKILL.md and skills/study-design/references/primitives-and-tools.md as guidance for guided trials. For no-guidance controls, do not read or use skill guidance. Treat evidence as mock only. Do not call Sheg tools, providers, connectors, or external services. Return only JSON with scenarioId, scenarioVersion, actions, finalResponse, and uncertainties. Any helpful tool action must be described as proposed only.

scenarioId: sequence-versus-linear-graph
scenarioVersion: 2

## User request
I want readers to see paragraph A, then B, then C, with a question after each. Does a sequence mean each question remembers earlier answers, or is it just a straight graph? Please recommend a design that makes the history expectation explicit.

## Controlled evidence (mock only)
{
  "materials": [
    "Paragraph A",
    "Paragraph B",
    "Paragraph C"
  ],
  "mockOnly": true
}