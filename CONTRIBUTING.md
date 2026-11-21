# Contributing to CodeLab runner

Thank you for helping. The runner is the interactive and grading server of the CodeLab plugins for Moodle
([tiny_codelab](https://github.com/blagojevicboban/moodle-tiny_codelab),
[filter_codelab](https://github.com/blagojevicboban/moodle-filter_codelab),
[qtype_codelab](https://github.com/blagojevicboban/moodle-qtype_codelab)). It runs untrusted student programs, so
**every change is a security change**: keep that in mind and say in the pull request what it means for the sandbox.

## Workflow

1. Take an open issue (or open one first for a larger change) and say in it that you are working on it.
2. Create a branch from `main` in this repository: `fix/<short-name>` or `feature/<short-name>`.
3. Keep a pull request to one topic; describe the change and how you tested it.
4. `main` is protected: a pull request needs a green CI (Node 20 and 22 with MariaDB) and the maintainer's approval.
   Release tags `v*` are created and signed by the maintainer only; servers deploy only signed tags.
5. Do not change the version in `package.json`: the maintainer does that when a release is made.

## Development setup

- Linux (Ubuntu 24.04 or WSL 2), Node 20 or 22, `bubblewrap`, `prlimit`, compilers (gcc, g++, OpenJDK, Mono, Python 3,
  Node, fpc, php), `gdb` for step by step, MariaDB for SQL. Ubuntu 24.04 needs the AppArmor user namespace profile for
  `bwrap` (see README).
- `npm ci`, then `node server.js` with the environment from the README (`CODELAB_SECRET` or `CODELAB_SECRETS`,
  `CODELAB_ORIGINS`, ...). Use your own test secret; never commit one.

## Checks

```sh
npm test            # all tests: sandbox, sessions, gdb, SQL, grading (needs Linux with bubblewrap)
```

The tests of `lib/token.js`, `lib/queue.js`, `lib/cache.js` and `lib/deploy.js` need no sandbox and also run on
Windows or macOS: `node --test test/token.test.mjs test/queue.test.mjs test/cache.test.mjs test/deploy.test.mjs`.

## Rules

- No new way for a program to reach the network, the runner's files, environment or other sessions. Sandbox flags
  (`lib/sandbox.js`) are only tightened, not loosened, unless the pull request explains why it is safe.
- Values from clients (languages, limits, compiler options) come from white lists, never as free command-line text.
- Limits (CPU, memory, output, time, queue) stay enforced on the server, never trusted from the request.
- New behaviour gets a test in `test/`.
- No emoji in code, texts or messages.

## Commits

English, one line that says what changes (for example `Grading: limit the output of a run to 4 MB`), and more lines
when the reason is not obvious. Never commit secrets, keys or passwords.

## Security

Do not open public issues for security problems: write to the maintainer through the contact on the GitHub profile.

## Licence

By contributing you agree that your contribution is released under the GNU GPL v3 or later, like the runner.
