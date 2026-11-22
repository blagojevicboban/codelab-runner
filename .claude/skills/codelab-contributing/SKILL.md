---
name: codelab-contributing
description: Rules and checks for contributing to CodeLab runner, the sandboxed server that runs students' programs for the CodeLab Moodle plugins. Use while changing any file of this repository, before opening a pull request, and when the user asks whether a change is ready or safe. Covers the security rules of the sandbox, the tests, and what contributors must not change.
---

# Contributing to CodeLab runner

The runner compiles and runs **untrusted student programs** (bubblewrap sandbox, prlimit limits, signed requests from
Moodle). Every change is a security change. Read `CONTRIBUTING.md` and `README.md` first.

## Workflow

- One issue per pull request, from a branch `fix/<name>` or `feature/<name>`; put `Fixes #N` in the description, and
  say what the change means for the sandbox.
- `main` is protected: green CI (Node 20 and 22 with MariaDB); then merge. Releases: bump `version` in `package.json`,
  wait for CI, tag `v<version>` (signed when you can); servers update only when the maintainer deploys a tag.
- Commit messages in English. Never commit secrets (`CODELAB_SECRET`,
  `CODELAB_SECRETS`, database passwords); use your own test values.

## Security rules

1. Never loosen the sandbox (`lib/sandbox.js`): no network, no access to the runner's files, environment or other
   sessions, limits on CPU, memory, file size, processes and output. Tightening is welcome; loosening needs a
   written reason in the pull request.
2. Values from clients (language, limits, compiler options, file names) come from white lists or are clamped to the
   server's limits, never passed as free command-line text or paths.
3. Requests stay signed (HMAC with the site's secret, time window, nonce against replay); tokens of sessions are
   short-lived and bound to one language.
4. Errors returned to clients are short and never contain secrets, paths of the server or stack traces.
5. No new dependency without a reason; `npm ci --ignore-scripts` is used on servers.

## Checks

```sh
npm test    # all tests (Linux or WSL 2 with bubblewrap, gdb, compilers and MariaDB)
```

The tests of `lib/token.js`, `lib/queue.js`, `lib/cache.js`, `lib/deploy.js`, `lib/errors.js` and the start check of `server.js`
run anywhere: `npm run test:unit`.

- New behaviour gets a test in `test/`; a bug fix gets a test that failed before.
- Keep the code style of the files around (ES modules, two levels of JSDoc for exported functions, no emoji).
- Files written on Windows must keep LF line endings.
