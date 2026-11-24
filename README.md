# CodeLab runner

The interactive server of the CodeLab plugins for Moodle ([tiny_codelab](https://github.com/blagojevicboban/moodle-tiny_codelab),
filter_codelab, qtype_codelab). It keeps a student's **C, C++, Java or C#** program running while the student types its
input in the browser console, as in a terminal: prompts appear before the input, and a program can read until the end
of the input (Ctrl+D). C and C++ programs can also run **step by step** under gdb: the browser marks the line that runs
next and shows the variables of the function.

It also runs programs interactively and for grading (`POST /run`, below) across **26 server languages**: C, C++, Java,
C#, **Python, JavaScript, TypeScript, Pascal, PHP, Bash, Go, Rust, R, Ruby, Lua, Kotlin, Perl, Octave, Julia, Scheme,
Dart, Scala, Elixir, Swift, Haskell** and SQL (MariaDB). Each language is automatically advertised by `GET /health` only
when its compiler or runtime is installed in `/usr/bin` (and reachable inside the bubblewrap sandbox). A site can keep
grading on [Jobe](https://github.com/trampgeek/jobe), or leave the Jobe settings of tiny_codelab empty and use only this
server (tiny_codelab newer than 1.12). In examples Python still runs in the browser (Pyodide).

## How it works

1. The browser asks Moodle for a token (web service `tiny_codelab_session`). The token is signed with a secret shared by
   Moodle and the server, holds the user, the site, the language, a nonce and an expiry of 60 seconds, and opens one
   session only, for that language (tiny_codelab 1.12; tokens without a language from older versions run any).
2. The browser opens `wss://<server>/session?token=...` and sends the program.
3. The server compiles the program and runs it in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox: no
   network, a read-only system, a private `/tmp`, CPU time, memory and file size limits (`prlimit`). The output streams
   to the browser, the typed lines go to the program's standard input.

The compilers and their options are the same as on the Jobe server of tiny_codelab (gcc/g++ with `-w`, `-lm` and the
Visual Studio safe functions, javac, mcs/mono), so the output is the same as in grading.

The [CodeLab manual](https://github.com/blagojevicboban/moodle-tiny_codelab/blob/main/docs/MANUAL.md) describes the runner from the Moodle side (settings, states, error
messages).

## Requirements

- Linux with unprivileged user namespaces (Ubuntu 24.04 tested, also WSL 2)
- Node.js 20 or newer
- `bubblewrap`, `build-essential`, `openjdk-21-jdk-headless`, `mono-mcs` (the versions of Jobe on Ubuntu 24.04:
  gcc 13.3, Java 21, Mono 6.8), and `gdb` for step by step

```sh
sudo apt-get install bubblewrap build-essential openjdk-21-jdk-headless mono-mcs gdb mariadb-server
# For grading without Jobe, the other languages (each is offered only when its program is in /usr/bin):
sudo apt-get install python3 nodejs fp-compiler php-cli
```

## SQL (MySQL / MariaDB)

With a MariaDB server on the same machine, `lang: "mysql"` runs SQL: each session gets a database and a user of its own
(`cl_...`, only that database, `MAX_STATEMENT_TIME` 5 s, two connections), the optional `setup` (tables and data) runs
first, then the code through the `mariadb` client in the sandbox, shown as by the client (`--table -vv`: tables,
Query OK, errors with their line). The database is dropped at the end. Create the runner's MariaDB user with
`sudo bash deploy/mariadb-admin.sh <password>` and set `CODELAB_MYSQL_USER=codelab_admin`, `CODELAB_MYSQL_PASSWORD`
and `CODELAB_MYSQL_SOCKET` (default `/run/mysqld/mysqld.sock`). Without them SQL is not offered.

## Language services: C# (Roslyn) and Java

With the .NET 8 runtime on the server and the analyzer in `roslyn/` published, the runner also answers the C# editors
of tiny_codelab 1.26 or newer while the reader types: completions of the real members of every type, the signatures of a
call, tooltips with the documentation of .NET and the errors of the compiler. The program is checked as C# 7.3 against
the reference assemblies and the XML documentation of .NET Framework 4.7.2, the API that Mono's `mcs` (running and
grading, also on Jobe) offers, so what the editor accepts also compiles. The program is only analyzed, never run.

One process serves every reader (a few hundred MB, not one per student): it starts with the first request, runs in
bubblewrap without network or writable folders, answers in tens of milliseconds and stops after
`CODELAB_ROSLYN_IDLE_MIN` minutes without requests. Readers connect to `/analysis` with a token from Moodle
(`tiny_codelab_analysis`, `p: "analysis"`, `l: "csharp"`); such a token runs no program, a connection uses no quota of
runs, and a user may have four.

```sh
sudo apt-get install dotnet-sdk-8.0      # on a build machine; the server needs only dotnet-runtime-8.0
cd roslyn && dotnet publish -c Release -o publish
```

The Java service (tiny_codelab 1.27 or newer) does the same for Java with the compiler of the server's JDK used as a
library (`java-analyzer/JavaAnalyzer.java`, no other dependency), with the release of the JDK that runs and grades the
programs. The runner builds it with `javac` with the first request (into the temporary folder, once per version of the
source) and runs it in bubblewrap like the C# analyzer. The tooltips show the Javadoc of the JDK from its `src.zip`:

```sh
sudo apt-get install --no-install-recommends openjdk-21-source
```

`GET /health` lists `analysis: ["csharp", "java"]` for the services that are there. Allow about 1 GB more in `MemoryMax` of the
systemd unit (the heap of the analyzer is `CODELAB_ROSLYN_HEAP_MB`). Without the analyzer, or with
`CODELAB_ROSLYN=off`, the editors keep their built-in typing help.

## Runs for grading

`POST /run` with `{lang, code, stdin}` runs a program to its end and answers `{status, stdout, stderr, cmpinfo}`, as
Jobe does (and `time`, below). Optional `cputime` (seconds, at most `CODELAB_CPU_SECONDS`) and `memory` (MB, 16 to 2048; for
Java, C# and JavaScript the size of the heap, since 0.16.0) are the limits of a question. It is called by Moodle's server (tiny_codelab `runner_client`), not by browsers: the request carries
`X-CodeLab-Site`, `X-CodeLab-Time`, `X-CodeLab-Nonce` and `X-CodeLab-Signature` = base64url(HMAC-SHA256(secret, time +
"\n" + nonce + "\n" + body)), valid for 60 seconds and taken once (the nonce). Requests without a nonce (tiny_codelab older
than 1.12) are signed as time + "\n" + body; `CODELAB_REQUIRE_NONCE=1` refuses them. qtype_codelab grades SQL questions
with it; SQL output is then only the result tables (`--table`). Runs for grading have their own places
(`CODELAB_BATCH_MAX`), so a regrade does not take the sessions of the students. When they are all taken, a run waits
for a place (`CODELAB_BATCH_WAIT`); the places go to the site with the fewest runs going on, so a regrade of hundreds
of runs on one site does not hold up a single run of another. A program that ends for lack of memory gets the status
`memory` (here and in sessions).

The answer has an optional `time` too (since 0.9.0): the seconds the program ran, with 3 decimals, for example
`{"status": "ok", ..., "time": 0.012}`. It is wall time of the run in the sandbox, not CPU time, and the compilation is
not in it; the start of the runtime is (about 0.05 s for C, 0.3 s for Java and C#), so it is a hint to the speed of a
solution, not a measure of a judge. There is no `time` when nothing ran (a compilation error, a refused request) and
for SQL. Clients that do not know the field can ignore it: nothing else in the answer changed.

Since 0.10.0, both `POST /run` and WebSocket `/session` (`start`) accept an optional `files` array (`[{name, text}]`,
up to 5 files of 64 KB each; simple names without folders) placed in the program's writable working folder `/work`
(while `/box` stays read-only). Regular files created or changed by the program are returned after the run (`files`
in `POST /run`, `{type: "files", files}` before `exit` in `/session`).

Since 0.11.0, C and C++ runs accept whitelisted optional `compiler` (`gcc`, `msvc`, `clang`) and `std`
(`c99`, `c11`, `c17`, `c23` for C; `c++11`, `c++14`, `c++17`, `c++20`, `c++23` for C++). In `msvc` mode, gcc/g++
compiles with `lib/msvc/` headers (`codelab_msvc.h`, `conio.h`, `windows.h`) providing Visual Studio functions
(`scanf_s`/`fscanf_s`/`sscanf_s` with buffer sizes, `fopen_s`, `strcpy_s`, `strcat_s`, `strncpy_s`, `gets_s`, `_itoa`,
`__int64`, `_getch`, `Sleep`, `system("pause")`/`system("cls")` as no-ops). Signed `GET /health` also reports
installed `compilers` (`gcc`, and `clang` when present).

Since 0.12.0, C and C++ runs accept optional `sanitize: true` (safe mode: `-fsanitize=address,undefined` with
`max_allocation_size_mb=256`, linking `codelab_unbuffered.c` instead of `stdbuf`) to report out-of-bounds array
access, use-after-free, null dereference, division by zero and signed integer overflow with exact source lines.

Since 0.16.0, runs for grading work **as on Jobe** (`compat: "jobe"`, the default), so that a program gets the same
mark on both servers, also when tiny_codelab's Automatic mode turns to the runner because Jobe does not answer:

- A program that wrote to its standard error failed (`runtime`), whatever its exit code; one that wrote nothing there
  succeeded, also with `exit(1)`. A crash (a signal) is `runtime`. A program stopped after twice its CPU time on the
  clock (one that sleeps or waits for input) is `time`.
- Any message of the compiler of C, C++ and Java is a compilation error (a warning of the linker, such as the one for
  `gets`, which `-w` does not turn off, or javac's notes). Such compilations are not cached.
- Python (`py_compile`) and PHP (`php -l`) programs are checked first: a syntax error is `compile`.
- PHP runs without php.ini (`--no-php-ini`, warnings and notices in the standard output), Python with `-BE`, Java
  with `-Xrs`.
- Memory without the request's `memory`: 400 MB (Python 1500 MB), a heap of 200 MB for Java and 512 MB for JavaScript.

Since 0.16.1, a Java program without a public class is named after its class with `main` (as tiny_codelab names it
for Jobe), so it runs instead of failing as class `Main`.

`compat: "runner"` gives the behaviour before 0.16.0 (the exit code decides, 256 MB, warnings allowed); interactive
sessions keep it always. Signed `GET /health` lists the modes (`compat`). The script
`devtools/codelab-demo/probe-jobe-runner.php` of the plugins compares both servers with 31 small programs.

## One server for several Moodle sites

`CODELAB_SECRET` is the secret of every site. To give a site a secret of its own (an administrator of one site then
cannot open sessions in the name of another), add it to `CODELAB_SECRETS` as `site:secret` pairs, comma separated. The
site id is shown under the state of the interactive server in the tiny_codelab settings (the first 12 characters of
sha1 of the site address). With only `CODELAB_SECRETS`, sites that are not listed are refused.

`GET /health` answers `{ok, languages}` (the languages installed on the server); a request signed like a run (empty body) also gets `version`, `sessions`,
`runs`, `queued` and the `versions` of the languages (as Jobe gives them), which the settings page of tiny_codelab shows.

## Building on the server (hooks)

`startServer()` of `server.js` takes optional functions, for a service that keeps its sites somewhere else than in
the environment: `secretsResolver` (`{of(site)}`, the secret of a site), `allowOrigin(site, origin)`,
`authorize({type, site, activeSiteSessions})` before a session or a run (`{ok}` or `{ok: false, code, reason}`; the
reason reaches Moodle as the status of the run or as `{type: "error", reason}` of the session), `onRun({type, site})`
when one starts, and `onRequest(req, res, {secrets})` for more HTTP routes. Without them the server works as described
here.

## Install

```sh
sudo useradd --system --create-home --home-dir /opt/codelab-runner codelab
sudo -u codelab git clone https://github.com/blagojevicboban/codelab-runner /opt/codelab-runner/app
cd /opt/codelab-runner/app && sudo -u codelab npm ci --omit=dev
# Settings: a long random secret (the same goes into the tiny_codelab settings), the Moodle address, MariaDB.
sudo cp deploy/codelab-runner.env.example /etc/codelab-runner.env
# Only root reads it: systemd passes the settings to the server, and the students' programs (same user) cannot.
sudo chown root:root /etc/codelab-runner.env && sudo chmod 600 /etc/codelab-runner.env
sudo nano /etc/codelab-runner.env    # CODELAB_SECRET=$(openssl rand -hex 24), CODELAB_ORIGINS, MariaDB password
sudo cp deploy/codelab-runner.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now codelab-runner
```

On Ubuntu 23.10 and newer, AppArmor stops unprivileged user namespaces, which bubblewrap needs. Allow them for bwrap
with a profile (recommended) or for the whole system:

```sh
sudo tee /etc/apparmor.d/bwrap <<'EOF'
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
EOF
sudo systemctl reload apparmor
# or: sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0
```

Put a TLS proxy in front (Moodle pages are HTTPS, so browsers need `wss://`); `deploy/nginx.conf` is an example. The
server listens on `127.0.0.1:8090` only.

Check: `curl http://127.0.0.1:8090/health` answers `{"ok":true,"sessions":0,"languages":["c","cpp","java","csharp"]}`.

In Moodle, *Site administration > Plugins > Text editors > TinyMCE editor > CodeLab*: set **Address of the interactive
server** (for example `wss://runner.example.org`) and **Secret of the interactive server**. The settings page shows
whether the server answers.

## Security

- The students' programs run as the server's user, so everything that user can read, a program can read too, except
  what the sandbox leaves out: only `/usr`, `/etc` and the program's own folder are mounted, read-only. Keep
  `/etc/codelab-runner.env` readable by root only (systemd reads it); the sandbox also covers it with an empty file
  (`CODELAB_HIDE`, list of files, default `/etc/codelab-runner.env`). Put no other secrets readable by the user in `/etc`.
- No capabilities, no network, `/tmp` of 64 MB (`CODELAB_TMP_MB`), prlimit limits per program, and limits for the whole
  service in the systemd unit (`TasksMax`, `MemoryMax`, `NoNewPrivileges`). Needs bubblewrap 0.9 or newer.
- Updates only from **signed release tags** (below), so that a stolen GitHub login or token cannot run code on the server.

## Updates from GitHub (webhook)

Set `CODELAB_DEPLOY_SECRET` and add a webhook to the repository (Settings > Webhooks): payload URL
`https://<runner>/deploy`, content type `application/json`, the same secret, only the push event. On a push of a release
tag (`v1.2.3`) the runner runs `git fetch --tags && git verify-tag <tag> && git checkout --detach <tag> && npm ci
--omit=dev --ignore-scripts` in its folder, then, when the server has the .NET SDK, builds the C# analyzer with the
packages and hashes of `roslyn/packages.lock.json` (`dotnet publish ... -p:RestoreLockedMode=true`; the Java analyzer
is built by the server itself), waits until the open sessions end (at most `CODELAB_DEPLOY_WAIT`, 60 s) and
exits; systemd starts the new version. Pushes to branches and unsigned tags change nothing. The folder must belong to
the server's user. Without the secret `/deploy` answers 404.

The tag is checked with the public key of the person who releases, e.g. an SSH signing key:

```sh
# On the developer's machine, once: sign tags with an SSH key (its public part is also added on GitHub as a signing key).
git config --global gpg.format ssh && git config --global user.signingkey ~/.ssh/id_ed25519.pub
git tag -s v0.6.0 -m "CodeLab runner 0.6.0" && git push origin v0.6.0
# On the server, as the server's user, in the runner's folder: trust only that key.
echo 'you@example.org namespaces="git" ssh-ed25519 AAAA...' > ~/.config/git/allowed_signers
git config gpg.format ssh && git config gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
```

`CODELAB_DEPLOY_VERIFY=0` skips the check (not recommended); `CODELAB_DEPLOY_ON=branch` deploys every push to
`CODELAB_DEPLOY_BRANCH` (main) as before 0.5.1.

## Settings (environment)

| Variable | Default | |
|---|---|---|
| `CODELAB_SECRET` | – | shared secret, at least 16 characters (this or `CODELAB_SECRETS` is required) |
| `CODELAB_SECRETS` | – | `site:secret` pairs, comma separated: sites with a secret of their own |
| `CODELAB_REQUIRE_NONCE` | 0 | 1: refuse runs for grading without a nonce (all sites on tiny_codelab 1.12 or newer) |
| `CODELAB_PORT`, `CODELAB_HOST` | 8090, 127.0.0.1 | where the server listens |
| `CODELAB_ORIGINS` | any | allowed `Origin` headers, comma separated, e.g. `https://moodle.example.org` |
| `CODELAB_MAX_SESSIONS` | 30 | programs running at once on the server |
| `CODELAB_USER_SESSIONS` | 2 | programs running at once for one user |
| `CODELAB_BATCH_MAX` | 10 | runs for grading (`POST /run`) at once, beside the sessions |
| `CODELAB_BATCH_WAIT` | 30 | seconds a run for grading waits for a place before it is answered `busy` (0: no waiting) |
| `CODELAB_BATCH_SITE_MAX` | `CODELAB_BATCH_MAX` | places of one site, so that a regrade on one site leaves places for the others |
| `CODELAB_RUN_BODY_MB` | 8 | largest run for grading (program and input; tests of contest problems have inputs of megabytes) |
| `CODELAB_BATCH_OUTPUT_MB` | 4 | largest output of a run for grading (sessions keep `CODELAB_MAX_OUTPUT`) |
| `CODELAB_CPU_SECONDS` | 10 | CPU time of a program |
| `CODELAB_WALL_SECONDS` | 300 | longest session, also while waiting for input |
| `CODELAB_MAX_OUTPUT` | 100000 | bytes of output, then the program is stopped |
| `CODELAB_NPROC` | off | process limit; counts every process and thread of the user, so use it with the user `codelab` only. A JVM or Mono has 20 to 30 threads: allow about 40 per session (1200 for 30 sessions), or leave it off and rely on `TasksMax` of the systemd unit |
| `CODELAB_TMP` | system | folder for the programs during a session |
| `CODELAB_TMP_MB` | 64 | size of the program's `/tmp` (memory) |
| `CODELAB_CACHE_MB` | 200 | cache of compiled programs (the same example run by many students is compiled once); 0 turns it off |
| `CODELAB_CACHE` | `codelab-cache` in `CODELAB_TMP` | folder of the cache (outside the sandbox; oldest entries go first) |
| `CODELAB_HIDE` | `/etc/codelab-runner.env` | files a program sees empty, comma separated |
| `CODELAB_DEPLOY_ON`, `CODELAB_DEPLOY_VERIFY` | tag, 1 | what the webhook deploys (see above) |
| `CODELAB_ROSLYN` | `roslyn/publish/CodeLab.Roslyn.dll` | the C# analyzer, or `off` |
| `CODELAB_DOTNET`, `DOTNET_ROOT` | `dotnet` | the .NET 8 runtime that runs the analyzer |
| `CODELAB_ROSLYN_HEAP_MB` | 768 | heap of the analyzer |
| `CODELAB_ROSLYN_IDLE_MIN` | 30 | minutes without requests before the analyzer stops (0: never) |
| `CODELAB_ROSLYN_TIMEOUT` | 8 | seconds a request waits for its answer |
| `CODELAB_ROSLYN_SANDBOX` | 1 | 0: start the analyzer without bubblewrap (development) |
| `CODELAB_JAVA_ANALYZER` | on when `javac` is there | `off` turns the Java service off |
| `CODELAB_JAVA_ANALYZER_HEAP_MB`, `CODELAB_JAVA_ANALYZER_TIMEOUT` | 384, 10 | heap of the Java analyzer, seconds a request waits |
| `CODELAB_MAX_ANALYSIS`, `CODELAB_USER_ANALYSIS` | 200, 4 | connections of the language services on the server and of one user |

Each open session is one compiled program and one process (a JVM for Java, Mono for C#). 30 students at once need about
1 GB of memory for C and C++, more for Java and C#.

## Messages (WebSocket, JSON)

Client to server: `{type: "start", lang, code, stdin, debug, step, breakpoints, setup}`, `{type: "stdin", data}`,
`{type: "eof"}`, `{type: "stop"}`; with `debug: true` (C and C++): `{type: "breakpoints", lines}` at any time, and while
paused `{type: "step"}` (into calls), `{type: "next"}` (over calls), `{type: "out"}` (out of the function),
`{type: "continue"}` (to the next breakpoint or the end). With `step: false` the program stops only at breakpoints.

Server to client: `{type: "compiling"}`, `{type: "compile", ok: false, output}`, `{type: "running"}`,
`{type: "out", data}`, `{type: "err", data}`, `{type: "paused", line, func, vars: [{name, value}], stack: [{func, line,
vars}]}` (the student's frames, innermost first),
`{type: "exit", status, code, signal}` (status `ok`, `runtime`, `time`,
`memory`, `toolong` or `stopped`), `{type: "error", message}` (with `reason` when a hook refused the session).

The language services (`/analysis`, token with `l` csharp or java): the client sends `{id, op, code, files: [{name, code}], line, column, item,
culture}` with `op` one of `complete`, `describe`, `signatures`, `hover` and `diagnostics` (line and column 1-based), at
most 20 a second, and gets `{id, items}`, `{id, text}`, `{id, signatures, active, parameter}`,
`{id, markdown, line, column, endLine, endColumn}` or `{id, items: [{file, severity, code, message, line, column, endLine,
endColumn}]}`; `{id, error}` or `{id, busy: true}` when there is no answer.

In step mode the program is compiled with `-g -O0` and runs under `gdb --interpreter=mi3`; its input and output go
through FIFOs in its folder. A step that goes into the C library (printf, scanf) returns to the student's code at once,
so only the student's lines are shown. `CODELAB_DEBUG_MI=1` prints gdb's machine interface on the server's stderr.

## Tests

```sh
npm test
```

They run real programs in the sandbox (Linux with the packages above). The tests that need no sandbox (tokens, the
queue, the cache, deploy, the start check and the error messages) also run on Windows and macOS:

```sh
npm run test:unit
```

## License

GNU GPL v3 or later. © 2026 Boban Blagojević.
