## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## How it was checked

- [ ] `npm run typecheck` and `npm run lint` pass
- [ ] e2e suites pass (`npm run test:e2e` against a fresh test database)
- [ ] New or changed behavior has a test

## Risk review

- [ ] Migration reviewed by hand (new tables have RLS + a policy; no data loss)
- [ ] Every new mutation writes an audit row
- [ ] Tenant scoping: queries filter by organization / workspace; no ids trusted from callers
- [ ] No secrets, tokens, or customer data in code, logs, or fixtures
- [ ] Security-relevant? (auth, sessions, permissions, API keys, money) Say how below

<!-- Notes for the reviewer -->
