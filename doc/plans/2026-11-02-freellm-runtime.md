# FreeLLM Work implementation

Paperclip remains the source of truth for companies, agents, tasks, skills, reviews and workspaces. The operator receives a brief plan and execution starts automatically within the selected project. Model inference uses browser sessions.

## Delivery

1. One browser hub for all providers; isolated, persisted conversations and recovery.
2. Embedded provider tabs in Electron, hidden-to-tray lifecycle and authenticated local control.
3. One LangGraph execution loop for chat and scheduled adapters; native delegation, tool results and verified completion.
4. Project files, previews, research and outputs in the original UI.
5. Isolated integration tests, type checks, builds and desktop smoke proof; live authentication reported separately.

## Invariants

Preserve user edits and provider profiles. Never infer success from an ended stream or inserted row. Never replay an uncertain browser submission blindly. Hide views without closing sessions. Keep company/project boundaries. Do not require paid inference services. Each implementation run requires valid acceptance checks. Questions and research are verified according to their own deliverable types.

## Validation

Previous tool tests contain production-side mutations and mocked database calls. Replace them with isolated fixtures. Record test and live results here as work progresses.

## Implemented evidence (2026-11-02)

- Preserved the original company, agents, task history, project services and provider profile. An offline database copy was made before migration; migrations 0320 and 0321 were applied without resetting data.
- The installed desktop launcher now uses this checkout, with its previous launcher backed up. Closing the window hides it to the tray; the authenticated local quit action drains jobs and stops owned services.
- Real Gemini acceptance: run eb66735d-48c3-4f19-a2f6-fe52218fdf4c:55fde866-5445-421d-ac47-9c58235f3307 executed get_project_context, read_file, propose_file_mutation and verify_task. It repaired math.mjs and passed node --test math.test.mjs (also rerun independently). Evidence: .freellm-runtime/acceptance-result.json, native issue comments and database tool receipts.
- The installed application retained the Google login after a clean restart. A fresh hidden-conversation nonce round trip passed at 2026-11-02T00:50:31Z.
- Unit coverage passed 30 tests. Isolated native integration proved real database delegation, receipt/checkpoint persistence, company-scoped approval binding and an actual scheduled browser adapter run that delivered a file and completed its native task.
- A real Windows preview service started, served HTTP and stopped its full owned process tree. Its configuration preserves unrelated existing project services.
- Desktop smoke proved embedded isolated conversations, background viewport, tab discovery from an existing browser connection, hide/reopen lifecycle, authenticated control and idle-tab eviction without evicting active work.
- Real DOM smoke proved paragraph/code extraction, tool-call parsing and cancellation. Public GitHub retrieval through DNS-pinned HTTPS was exercised live.
- Server type checking and UI type checking/build passed. The desktop-served UI assets were synchronized.

## Limits and general checks

- Other provider adapters are candidates until the operator signs in and their live checks pass. Gemini attachments, specific named model switching and fifty simultaneous agents have not been qualified.
- Logical agents are queued per account and browser views are bounded; an agent definition is not a promise of free parallel model capacity.
- Full workspace type checking was attempted and stopped at the existing native subproject dependency on missing Cargo. The whole-repository test command was attempted, but did not finish within the available memory; its own process tree was stopped. The whole-repository build is not certified.
- The existing design-token gate reports 113 violations outside the new pages. No allowlist was added.
- Local commands use the operator's OS privileges. This is not an OS sandbox.
- The native personal conversation remains per agent/user while model sessions are isolated by project/task. Direct workbench jobs share the execution loop but do not yet provide full scheduler budget admission parity.
- Native external MCP connector tools are not exposed by this browser tool executor yet. Public research and local developer tools are available.
- Fully automatic recovery of a browser submission with an uncertain outcome is deliberately blocked pending inspection; it is never blindly resubmitted.

## Final acceptance

- 58 targeted tests passed: 30 execution tests, five real native/database integration tests, six service supervisor tests, ten shell-resolution tests, six database helper tests and one real Windows PostgreSQL stop/reopen integration test. The native task inspection fixture also covers retrieving recent delivery comments while excluding deleted comments.
- A second live test was sent by clicking Send in the built UI after restarting the installed application. Run 4c7dbcaf-f541-4334-b814-6d2994a761f0 resumed the saved Gemini conversation, read math.mjs, ran verify_task with node --test math.test.mjs, and reached completed with verified=true and no page errors. Evidence: .freellm-runtime/ui-acceptance-result.json and acceptance-ui.png.
- The original manager and real project folder are selected in the installed UI. Team/task/file controls were exercised, and doc/FREELLM-WORK.md was opened through the native file API.
- The live browser run took about seven minutes for three model replies. Website latency remains outside the scheduler's control.

- Rapid restart exposed two inherited Windows lifecycle failures: a fixed Chromium debugging port could still be reserved, and forced PostgreSQL termination left PG18 IO workers holding shared memory. The desktop now allocates a fresh control port. Persistent clusters use pg_ctl fast shutdown after validating their PID and data directory, with no forceful fallback against a different owner.
- The database restart integration wrote a real row, stopped and reopened the same cluster, read the row back, and stopped it again while proving that its listener port was released. Fixture cleanup now retains files when shutdown fails.
