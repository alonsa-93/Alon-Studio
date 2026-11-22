# Security policy

ALON.ai Studio runs a local server that holds your videos and, optionally, API keys for outside services. Security reports are welcome.

## Reporting a vulnerability

Please report it privately through GitHub: **Security > Report a vulnerability** on this repository. Do not open a public issue for it.

Include what you found, how to reproduce it, and the version (the `version` in `package.json` or the release name). You should get an answer within a week.

## What is in scope

- Access to the local server without the access key, or from another origin or another user on the same computer
- Reading or writing files outside the folders the studio is meant to use
- The link importer reaching private or local addresses
- API keys leaking into responses, logs or exports
- The AI agent saving changes without approval, or using tools it is not given
- The Windows package and installer scripts

## What helps us check a fix

The security tests are in `scripts/security-tests.ts` (gate 5) and the link-import rules in `scripts/regress.ts`. A failing test with your report is the fastest way to a fix.
