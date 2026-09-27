# Interpret poll results

Confirm the run is completed before treating it as a final result. If its state is running or interrupted, load [run and recovery](run-and-recovery.md) and report its current state instead.

Use `poll_report` to inspect intended and completed denominators, exclusions, outcomes, item exposure, attempts, latency, token usage, confidence, and billing evidence. Include branch and early-exit counts when they affect interpretation.

Use `poll_compare` only when stimulus fingerprints match. Describe agreement or divergence among matched completed readers.

A poll is a simulation of profile-conditioned judgments, not an observation of actual readership. Keep provider confidence separate from choice probabilities and from another provider's confidence. State when local checkpoint revision is unknown. Name failed and unsupported journeys, missing readers, and unknown charges. Treat simulated readers as correlated perspectives, not independent votes. Do not present results as accuracy, calibration, readership, or a publication score. A poll can surface confusing branches or compare bounded judgments; it does not replace human review or actual reader evidence.
