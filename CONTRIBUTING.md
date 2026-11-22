# Contributing

Thanks for helping. A few rules keep the studio stable.

## Before you open a pull request

1. Start the isolated test instance: `node scripts/test-server.mjs` (port 5182, temporary data).
2. Make the test media once: `powershell -File scripts/make-test-media.ps1`.
3. Run the gates: `node scripts/gates.mjs`. All of them must pass. Gate 8 is skipped when you have no saved projects.

## How the code is organised

- **One definition, two outputs.** Visual effects are defined once in `shared/`. The preview (`src/components/Preview.tsx`) and the export (`server/render.ts`) both come from it, and gate 9 compares them.
- **Every edit is an op.** New editing features add an op in `shared/ops.ts` with strict input checks, tests in `scripts/regress.ts`, and an MCP tool in `server/mcp.ts` (listed in `server/mcp-ops.ts`).
- **Old projects keep working.** New fields in `shared/types.ts` are optional, with a default that keeps the old behaviour.
- **Both languages.** Every UI string goes in `src/i18n.ts` with Hebrew and English. Gate 2 fails if one is missing or if Hebrew text is left in a component.
- **No secrets in code, commits or logs.** API keys go through `server/keys.ts`.
- **No native binaries at runtime** beyond the bundled Node, ffmpeg and Python. Check a new npm dependency for native code and run `npm run security:check`.

## Commits

One clear change per commit, with a message that says what changed and why.
