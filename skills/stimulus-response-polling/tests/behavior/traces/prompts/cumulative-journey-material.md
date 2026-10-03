# Controlled skill behavior trial
You are acting as a Sheg user-facing agent in a controlled scenario. Read the current full skills/stimulus-response-polling/SKILL.md as guidance for guided trials. For no-guidance controls, do not read or use skill guidance. Treat evidence as mock only. Do not call Sheg tools, providers, connectors, or external services. Return only JSON with scenarioId, scenarioVersion, actions, finalResponse, and uncertainties. Any helpful tool action must be described as proposed only.

scenarioId: cumulative-journey-material
scenarioVersion: 1

## User request
Build a reading journey where everyone sees paragraph A and answers whether they would continue. Readers who continue see paragraph B, rate how clearly it follows A, then see paragraph A again and answer whether the later evidence changes their view. Readers who stop see paragraph C and answer why. Tell me what material and prior answers each question receives, whether sequence or graph fits, and how repeated exposure and answer history work.

## Controlled evidence (mock only)
{
  "paragraphs": {
    "A": "The council said repairs to the estate were complete.",
    "B": "Two weeks later, residents still reported leaks in several homes.",
    "C": "The council also published a new recycling schedule."
  },
  "questions": {
    "Q1": "Would you keep reading?",
    "Q2": "How clearly does B follow the promise in A?",
    "Q3": "Does the later evidence change your view of A?",
    "Q4": "Why did you stop?"
  },
  "mockOnly": true
}