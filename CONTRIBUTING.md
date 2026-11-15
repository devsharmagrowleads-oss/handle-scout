# Contributing to handle-scout

Thanks for helping. The most useful contributions are new platforms, fixes for detectors that have stopped working, and better username rules.

## Setup

```sh
npm install
npm run build
npm test
```

Node.js 20.9 or newer. The repo is an npm-workspaces monorepo:

- `packages/core` is the engine. All checking logic lives here and has no UI code.
- `packages/cli` and `apps/web` are thin front ends over `scout()`.

`apps/web` consumes the built output of core, so run `npm run build:core` after changing core (`npm run dev` does it for you once at start).

## The one rule

**Never guess.** A detector may report `available` or `taken` only when the site's response proves it. If a site answers a script the same way for every name, or puts up a bot wall, the right result is `unknown` with a reason and the profile link. A wrong "available" costs a user far more than an honest "check this one yourself".

## Adding or fixing a platform

1. Edit `packages/core/src/platforms.ts`. The README shows the shape of a definition.
2. Find a detection signal with a plain HTTP client, not a browser. In order of preference:
   - a public JSON or API endpoint with real status codes,
   - a profile page that returns a real 404,
   - a marker string in the body (`bodyIncludes` / `bodyExcludes`). Fragile; set `confidence` to `medium` or lower and say so in `note`.
3. Write the username `rules` from the site's own documentation or sign-up form. The `pattern` is tested against the lower-cased handle and must match the whole string.
4. Set `probe.taken` to a handle that certainly exists.
5. Choose a tier: `core` platforms are included in the cross-platform suggestion ranking, which multiplies the number of requests by ten. Use `extra` unless the platform matters to most people launching a name.
6. Verify against the live site:

   ```sh
   npm run verify:platforms -- your-platform-id
   ```

   | Verdict | Meaning |
   | --- | --- |
   | `PASS` | Taken handle reported taken, random string reported available. |
   | `PASS (taken-only)` | The definition has no `available` matcher and behaves accordingly. |
   | `BLOCKED` / `PARTIAL` | The site refused one or both requests. Run it again; if it persists, the platform is not reliably checkable. |
   | `FAIL` | The detector gave a confident wrong answer. Do not merge. |

   Run it a few times, a few minutes apart. Several sites answer honestly at first and then start blocking.
7. If you cannot get a stable `PASS`, use `detect: { type: 'manual', reason: '...' }` and explain in the reason what the site does. That is a legitimate, useful contribution.
8. Add the platform to the table in the README, and add a rules case or two in `packages/core/test/validate.test.ts`.

Do not add detectors that need a login, an API key, a borrowed client ID, a third-party lookup service, or a headless browser. Do not add anything that evades a site's bot protection.

## Code

- TypeScript, strict mode. Keep `packages/core` free of dependencies.
- Tests must not touch the network. Inject `fetch` and `resolveNs` (see `test/classify.test.ts`).
- Requests must not carry anything that identifies the user or the project: keep the generic User-Agent, and do not add contact headers.
- Keep changes focused; unrelated refactors make detector fixes hard to review.

## Web UI

Design tokens (colour, spacing, radius, type scale) are CSS variables at the top of `apps/web/app/globals.css`; use them rather than raw values. State is always shown with an icon and a word, never by colour alone. Check your change in light and dark mode and at phone width.

## Pull requests

- Say what you changed and paste the `verify:platforms` output for any detector you touched.
- `npm test`, `npm run typecheck` and `npm run build` must pass.
- By contributing you agree your work is released under the MIT license.

## Reporting a broken detector

Open an issue with the platform, the name you checked, what handle-scout reported, what the site actually shows, and roughly where you ran it from (home connection, cloud server, VPN). Detector behaviour varies a lot by network.
