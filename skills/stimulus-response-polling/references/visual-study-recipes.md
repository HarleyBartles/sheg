# Visual study recipes

Use these recipes for frozen screenshots, article images, character sketches, and bounded script evidence. Sheg runs authored typed questions over saved material and respondent profiles; Clef supplies model evidence. These studies do not observe human attention, reading, comprehension, or preference.

## Rendered-page comparisons

Begin by deciding whether the question is about each version's adequacy or a direct preference between versions. For independent adequacy, ask the same typed question of each supplied screenshot in a separate equivalent context, holding respondent profile, question, rubric, state, provider, and model fixed. A matched journey fork can create those conditions for the same respondents who reach a chosen boundary. A direct preference is a different question: bind both screenshots to one image Choice, use neutral stable labels and an authored tie or no-preference option, and do not describe the selected option as proof that it is readable or effective.

If the screenshots change image position, typeface, and size together, decide whether the treatment is intentionally that whole bundle. To isolate a factor, change one variable at a time; if interactions matter, author a design that compares the combinations rather than attributing a bundled result to one change. Record viewport dimensions, capture bounds, render scale, font identity and load status, and treatment notes when supplied. Mark missing capture facts unknown. Do not invent provenance.

When the question is whether screenshot text is legible, do not put the exact page copy into the same packet as plaintext; that lets the model answer from text without reading the rendered image. Ask separate content questions when the copy is needed for meaning. Use pixel mode for visual judgments and supply factual alt text for provenance; the pixel projection omits alt text. A described-mode question tests the supplied description rather than the image pixels.

Sheg's image scaler preserves the full image and only scales it; it does not crop, tune quality, or guarantee small text stays legible. Inspect the exact prepared candidate, verify it still shows the difference under study, and let the user choose which version to submit. Do not claim typography expertise, eye tracking, conversion, or real reader behavior from Clef answers.

## Character sketches

For unprompted trait reading, use a context without the target character brief or target-trait description. Author a small set of typed trait questions in advance, such as separate Noul questions about whether the sketch reads as confident and as curious. This measures responses to those authored dimensions; it does not discover arbitrary traits or return a free-form explanation. The question itself names and therefore cues each dimension, so this is unprompted only relative to the withheld brief, not a fully uncued impression. Bind the supplied sketch in pixel mode. Keep any later prompted brief-fit assessment in a separate context so the unprompted response cannot inherit the target traits.

For prompted fit, include the authored brief and ask about each meaningful dimension separately. A brief such as “heroic and intelligent” can use one typed proposition per trait so one strong dimension does not hide a miss on the other. Optional Choice questions can probe authored unintended impressions. These remain judgments against the supplied brief, not an objective design winner or a human audience result.

For a direct comparison, keep the v0.4 candidate set to at most four sketches in one question. Map every stable Choice option ID to its bound image material with `materialOptions`, include a tie or no-preference option, use neutral labels, and inspect the exact request before execution. A four-way question asks which one is best among those four in one response. Pairwise asks six separate two-image questions over the same frozen profile and brief; set `providerSelection.batching` to `singleton` so each question exposes only its own pair. It returns six explicit head-to-head outcomes and can reveal ties or inconsistent relations, at greater call and token use. Preserve those results as a graph; do not infer missing outcomes or force an automatic total ranking. The exploratory six-image spike is not a v0.4 recipe and does not establish universal equivalence between comparison shapes.

Do not compare five or more designs by splitting them across Clef calls, showing a contact sheet, or merging subset winners into a ranking. Ask the user to choose up to four candidates for this study or defer the larger comparison to a later iteration. A local quartet choice answers only which option is preferred within that quartet.

## Script identity and protagonist prominence

When matching a design to a character in a script, state the target character by name if the script contains several and include only the passages needed to judge that character's behavior, dialogue, relationships, role, and tone. Ask about fit to that named characterization, using no more than four bound sketches and authored typed dimensions. Do not substitute the most prominent character for the named target or treat a visual match as a popularity vote.

Protagonist prominence is a different construct from visual fit to a character brief. If the question is which design most likely represents the story's lead, identify the relevant narrative evidence, such as scene recurrence, who initiates the central plan, or who resolves the conflict; do not invent an appearance brief. Keep the image set within four, preserve ambiguity, and report the answer as a model judgment over the supplied script evidence.
