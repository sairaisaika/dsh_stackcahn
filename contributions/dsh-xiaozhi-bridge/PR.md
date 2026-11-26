# fix: report the model bound to the active robot session

Changing the global default model while a robot session is active currently makes `agentStatus().model` report the new default, even though subsequent turns reuse the Agent created with the original selection. Keep the active model label until that Agent is disposed; a new session picks up the current default as before.

Add dependency-free Node tests covering model reporting across a default-model change and session reset, cwd-triggered recreation, and unchanged user-message forwarding. Run these tests in CI alongside the existing syntax/JSON checks.

Validation: `node --test` passes (2 tests). The model-reporting regression fails on the unmodified base and passes with this patch. This uses mocked DSH services; it does not establish compatibility with a running DSH release or robot hardware.

Base: howecheung/dsh-xiaozhi-bridge @ 58a243831d5f8ed2fc9ce18d54150e14ebccd816.
