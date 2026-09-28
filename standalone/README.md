# WorkforceOS standalone revenue pilot

This additive entry point runs a bounded research → draft → review queue through the official Claude Code CLI. It does not import the Conway runtime, create a wallet, fund credits, or reproduce agents. The upstream Automaton entry point remains available and unchanged.

The included assignment prepares evidence and outreach drafts for a first DreamSiteOS customer: a $500 one-page website offer with domain and hosting separate. It does not send messages, collect payments, publish websites, or claim revenue. The offer still requires human delivery and review.

## Implementation status

Implemented and locally tested on Linux with Node 22, pnpm 10.28.1 and Claude Code 2.1.283. The TypeScript build and 68 selected tests pass (25 standalone, 23 existing financial, 20 existing replication). The standalone pipeline was tested using a fake provider and a local fake executable; it has **not** completed a live Claude generation or been deployed to a persistent host. The preparation workspace has no Claude login. No funds were spent.

Conway's application displayed a new-signup closure and an October 1, 2026 shutdown notice when checked on September 28. This entry point avoids that dependency. Consult the current service notice before using the original runtime.

## Requirements and activation

Use an existing Linux/macOS machine with persistent storage, Node 22, pnpm 10.28.1, and official Claude Code 2.1.283. Newer 2.x releases pass the version gate but require compatibility verification. Windows has not been tested; process-tree cancellation is supported on Unix.

1. Check out `codex/standalone-revenue-pilot` in this fork. Install and build with Node 22 active:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run build
   ```

2. On that machine, use the official `claude auth login` flow with the existing Pro/Max subscription. Do not select Console/API billing. Do not paste passwords, API keys, tokens, or Claude credential files into chat, this repository, or a pull request. If `claude` is not installed, follow Anthropic's installation instructions and select the tested release.

3. In the Claude account, verify that **paid extra usage is OFF**. Subscription limits can interrupt a run. The pilot requires an operator acknowledgement of this account setting; it cannot inspect or change it automatically.

4. Set these values in the terminal that will run the worker. Only set the acknowledgement after completing step 3:

   ```sh
   export WORKFORCE_SUBSCRIPTION_ONLY=confirmed-extra-usage-off
   # Optional: use an absolute path to the official Claude executable.
   # export WORKFORCE_CLAUDE_BIN=/absolute/path/to/claude
   node dist/standalone/index.js doctor
   node dist/standalone/index.js init standalone/pilot.json
   node dist/standalone/index.js run
   ```

`doctor` checks the CLI version and subscription authentication without requesting generation. It accepts only an authenticated `claude.ai` Pro/Max status; unfamiliar status formats fail closed. State defaults to `~/.workforceos-pilot`, outside the repository. `WORKFORCE_STATE_DIR` can select an existing persistent private directory instead. Keep the same directory across restarts.

`run` processes the finite queue and exits on completion, a pause, or a blocker. `once` attempts just one job. There is no recurring schedule, automatic refill, or always-on service installed. A terminal session in a temporary chat workspace is not persistent hosting. Before scheduling repeated operation, validate one real run and establish an explicit ongoing budget and assignment policy.

## Controls and output

```sh
node dist/standalone/index.js status
node dist/standalone/index.js export
node dist/standalone/index.js pause
node dist/standalone/index.js resume
```

`status` emits JSON suitable for a future boardroom integration; no public dashboard/server is exposed. `export` writes `report.md` in the private state directory, marked DRAFT / NOT SENT. Review sources and business claims before use. Research has WebSearch and WebFetch; draft and review have no tools. Review checks the supplied evidence but does not independently browse it.

`pause` causes an active worker to kill its CLI process group on the next one-second poll on Unix. SIGINT/SIGTERM also cancel the active CLI call. Every generation has a ten-minute timeout and bounded captured output. Interrupted/failed jobs retain their full allocation and are never retried automatically. There can be a delay before provider-side work stops; cancellation is not a billing guarantee.

If the host crashed with a job marked `running`, first verify that the old worker and CLI process are stopped. Then:

```sh
node dist/standalone/index.js abandon-interrupted
```

This marks interrupted work failed and pauses the pilot. `resume` unpauses; it does not reset failed jobs, repeat completed work, or release allocations. Failed dependencies continue to block downstream jobs. Diagnose the failure before planning any additional run. Do not delete state or initialize a second state directory to bypass the pilot's lifetime allowance.

## Allowances and billing limits

- The pilot's lifetime reservation limit is 5,000 milliUSD ($5 of estimated model usage). The sample assigns $2 research, $1 drafting, and $0.50 review, leaving $1.50 unallocated.
- Before a call, SQLite reserves its entire allowance transactionally. That reservation remains after success, errors and crashes. Two workers sharing one database cannot claim a second simultaneous job.
- Claude receives a per-call `--max-budget-usd` cap. A result exceeding its allowance pauses the pilot and blocks dependencies. Missing cost estimates and incomplete results also fail closed.
- The CLI's cost estimate and cap are **not a hard invoice limit**. With subscription billing and paid extra usage OFF, calls should use the existing plan's limits; that account setting is the financial boundary. The local dollar ledger is an additional conservative usage control, not proof of actual charges.
- This pilot excludes API credentials, alternate-provider billing environment variables, and arbitrary runtime options from child processes. It disables custom settings, hooks, skills, MCP and browser integration, and exposes only explicitly listed tools. Managed organizational policies still apply. These CLI controls are not a VM or network sandbox.
- No payment method is connected by this code. No additional paid host or service has been provisioned. Do not enable API billing or paid extra usage to work around a subscription limit without a separately reviewed billing cap.

Anthropic's June 15 update says its announced Agent SDK billing changes are paused and supported `claude -p` use currently draws on subscription usage limits. Check the current policy before activation; a Claude subscription is not an API credit balance.

## Verification

```sh
pnpm run build
pnpm exec vitest run src/__tests__/standalone.test.ts src/__tests__/financial.test.ts src/__tests__/replication.test.ts
```

Covered: invalid configuration, atomic claims, persistent reservations, no duplicate jobs after restart, interrupted-job recovery, budget exhaustion, provider overruns, failed preflight, cancellation, tool/credential restrictions, dependent handoffs, report export and CLI subprocess integration. No tests spend money or call a model.

Activation acceptance: `doctor` succeeds on the chosen persistent host; `once` produces a sourced research result; the same database retains its reservation after restart; the remaining jobs complete with a reviewed draft report. Verify usage in the Claude account. These live checks remain outstanding.

## Sources checked September 28, 2026

- [Conway application/service notice](https://app.conway.tech/)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Use the Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude Code with Pro/Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
