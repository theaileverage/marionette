# Multiple intents and prompt restoration

This scenario runs real lead and worker model turns. Use the disposable harness
repositories, a profile validated on the current account, and the existing browser
controller. Run baseline smoke first. Do not substitute fabricated availability or
direct database mutations for model dispatch.

1. In the verified Herdr controller pane, create `fresh/compatibility.txt` containing
   `Protocol generation: 22` and `Reconnect: preserve terminal identity; never replay
an uncertain mutation`. Create `fresh/startup.txt` containing `Cold: 1200 ms` and
   `Warm: 300 ms`. Keep both files unchanged during the scenario.
2. Configure and validate the selected profile using the administrative CLI. Set
   lead activity to `coordinate` and scout/reviewer activities to `inspect`, with
   worker delegation disabled. Launch the fresh project's lead. Handle native trust
   only for this disposable repository, recording any trust entry added for the test.
3. Send: `Using only compatibility.txt, explain the protocol generation and reconnect
guarantee with evidence. Keep the work read-only; existing files are valid evidence.`
4. Independently observe Marionette state until its first task is preparing or running.
   Record the outcome/task IDs and revisions. Then send: `Also investigate startup.txt
and explain the cold versus warm start difference with evidence.` Do not add a
   reminder to preserve the first task: that is the behavior under test.
5. Verify two separate outcomes, earlier task preservation, no replacement/cancellation,
   and both entries in `project_briefing.swarm.activeIntents` or `swarm_observe.activeIntents`.
   Observe actual worker reports and the lead's handling of both outcomes. A blocked
   dispatch is not evidence of worker completion. If native MCP calls are rejected,
   distinguish that error from Marionette's outcome authority checks.
6. Once the lead is idle, send `/compact`. Verify the complete generated policy
   instructions are restored in the native session, with no spill-file substitute.
   Ask for the status of both investigations. Verify current briefing refresh and
   continued awareness of every unfinished outcome.
7. Compare both fixture files and existing-repository dirty/untracked contents with
   their originals. Record terminal evidence, independent state assertions, actual
   checks and limitations in `VERIFICATION.md`. Restore only test-added trust entries;
   retain the disposable repositories, session, and evidence for review.

The short visible bootstrap is not the full prompt. Inspect the SessionStart
developer message against the generated guard policy when checking prompt delivery.
`project_briefing` supplies live state, including exact profile/role records and all
active intents. Detailed optional behavior is available through the `multiple-intents`
recipe.
