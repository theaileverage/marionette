# diagnose

Version: 1

Trigger: Before investigating a reported bug or accepting a causal diagnosis.

Start with the observed user journey, expected result, actual result, inputs and repeatability. Separate the initiating trigger, masking conditions and visible symptom. Compare a failing path with a proven working path and inspect relevant history. Name a falsifying observation and run the smallest counterfactual that could distinguish the explanations. Retain contradictory evidence. Report observations separately from hypotheses, with reproduction commands, results and limitations. When implementation is authorized, carry the reproduction into a regression test. Load more procedure only when it resolves a concrete uncertainty.

This is optional guidance. The lead may adapt the method while preserving the user objective, permissions, evidence and concurrent work.

Example: For a timezone bug, contrast two timestamps whose lexical and absolute orders disagree, then run the proposed fix against both UTC and offset cases.
