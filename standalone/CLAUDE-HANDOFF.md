# Claude Code handoff: WorkforceOS pilot

Work only in `codex/standalone-revenue-pilot` until the owner approves promotion. Read `standalone/README.md` and inspect the diff against main before changes. The code is additive; the original Conway runtime was not migrated in place.

## Immediate job

Validate the standalone worker with the owner's existing Claude Code subscription on a persistent host. Verify paid extra usage is OFF using the account UI, then follow the README's activation steps. Use official authentication; never copy credentials into repository files or prompts. A missing login is an activation blocker, not permission to switch to API billing.

The prepared pipeline is research → outreach drafts → review. It supplies a first-customer packet for a $500 one-page website offer with domain and hosting separate. Review sources before sending anything. Do not count a draft, prospect or demo as revenue.

## Review focus

- Can the current official CLI run the configured flags and report the expected subscription auth/result schema?
- Are results complete within the sample's allowances and ten-minute timeout?
- Does a real pause stop the process group, preserve the reservation, and leave a reviewable status?
- Does the same persistent state survive a host restart without repeating work?
- Are claims in the final packet supported by the cited public sources?

The local build and 68 selected tests passed using mocked generation, including subprocess integration. A live generation and a persistent deployment remain unverified. No model/API or hosting spending occurred during preparation.

## Scope boundaries

Do not connect the original Conway wallet, enable paid extra usage, introduce API billing, fund an account, deploy a public endpoint, send outreach, merge main, or create paid infrastructure as part of this validation. Preserve the lifetime state and $5 estimated-usage limit; do not reset the database to get more attempts. Existing user authorization governs any later expansion.

## Later integration

After one accepted real result, an existing dashboard can read the `status` JSON and rendered report. Add an authenticated integration and an explicit scheduling/assignment policy before using it as a continuing workforce. Parallel agents, self-replication, recurring jobs, sales execution, a 3D environment and a boardroom UI are not implemented by this pilot. Prioritize a verified first customer before broadening the build.
