# CodeLab runner

The interactive server of the CodeLab plugins for Moodle ([tiny_codelab](https://github.com/blagojevicboban/moodle-tiny_codelab),
filter_codelab, qtype_codelab). It keeps a student's **C, C++, Java or C#** program running while the student types its
input in the browser console, as in a terminal: prompts appear before the input, and a program can read until the end
of the input (Ctrl+D). C and C++ programs can also run **step by step** under gdb: the browser marks the line that runs
next and shows the variables of the function.

It does not grade. Questions are still graded on [Jobe](https://github.com/trampgeek/jobe); this server is only for
**Run** in examples, in the editor dialog and in the attempt of a question. Python runs in the browser (Pyodide).
Without the server, every program runs on Jobe with the input given before the run.

## How it works

1. The browser asks Moodle for a token (web service `tiny_codelab_session`). The token is signed with a secret shared by
   Moodle and the server, holds the user, the site, a nonce and an expiry of 60 seconds, and opens one session only.
2. The browser opens `wss://<server>/session?token=...` and sends the program.
3. The server compiles the program and runs it in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox: no
   network, a read-only system, a private `/tmp`, CPU time, memory and file size limits (`prlimit`). The output streams
   to the browser, the typed lines go to the program's standard input.

The compilers and their options are the same as on the Jobe server of tiny_codelab (gcc/g++ with `-w`, `-lm` and the
Visual Studio safe functions, javac, mcs/mono), so the output is the same as in grading.

## Requirements

- Linux with unprivileged user namespaces (Ubuntu 24.04 tested, also WSL 2)
- Node.js 20 or newer
- `bubblewrap`, `build-essential`, `openjdk-21-jdk-headless`, `mono-mcs` (the versions of Jobe on Ubuntu 24.04:
  gcc 13.3, Java 21, Mono 6.8), and `gdb` for step by step

```sh
sudo apt-get install bubblewrap build-essential openjdk-21-jdk-headless mono-mcs gdb mariadb-server
```

## SQL (MySQL / MariaDB)

With a MariaDB server on the same machine, `lang: "mysql"` runs SQL: each session gets a database and a user of its own
(`cl_...`, only that database, `MAX_STATEMENT_TIME` 5 s, two connections), the optional `setup` (tables and data) runs
first, then the code through the `mariadb` client in the sandbox, shown as by the client (`--table -vv`: tables,
Query OK, errors with their line). The database is dropped at the end. Create the runner's MariaDB user with
`sudo bash deploy/mariadb-admin.sh <password>` and set `CODELAB_MYSQL_USER=codelab_admin`, `CODELAB_MYSQL_PASSWORD`
and `CODELAB_MYSQL_SOCKET` (default `/run/mysqld/mysqld.sock`). Without them SQL is not offered.

## Runs for grading

`POST /run` with `{lang, code, stdin}` runs a program to its end and answers `{status, stdout, stderr, cmpinfo}`, as
Jobe does. It is called by Moodle's server (tiny_codelab `runner_client`), not by browsers: the request carries
`X-CodeLab-Time` and `X-CodeLab-Signature` = base64url(HMAC-SHA256(secret, time + "\n" + body)), valid for 60 seconds.
qtype_codelab grades SQL questions with it; SQL output is then only the result tables (`--table`).

## Install

```sh
sudo useradd --system --create-home --home-dir /opt/codelab-runner codelab
sudo -u codelab git clone https://github.com/blagojevicboban/codelab-runner /opt/codelab-runner/app
cd /opt/codelab-runner/app && sudo -u codelab npm ci --omit=dev
# Settings: a long random secret (the same goes into the tiny_codelab settings), the Moodle address, MariaDB.
sudo cp deploy/codelab-runner.env.example /etc/codelab-runner.env
sudo chown root:codelab /etc/codelab-runner.env && sudo chmod 640 /etc/codelab-runner.env
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

## Updates from GitHub (webhook)

Set `CODELAB_DEPLOY_SECRET` and add a webhook to the repository (Settings > Webhooks): payload URL
`https://<runner>/deploy`, content type `application/json`, the same secret, only the push event. On a push to
`CODELAB_DEPLOY_BRANCH` (main) the runner runs `git pull --ff-only && npm ci --omit=dev` in its folder, waits until the
open sessions end (at most `CODELAB_DEPLOY_WAIT`, 60 s) and exits; systemd (`Restart=on-failure`) starts the new
version. The folder must belong to the user `codelab`. Without the secret `/deploy` answers 404.

## Settings (environment)

| Variable | Default | |
|---|---|---|
| `CODELAB_SECRET` | – | shared secret, at least 16 characters (required) |
| `CODELAB_PORT`, `CODELAB_HOST` | 8090, 127.0.0.1 | where the server listens |
| `CODELAB_ORIGINS` | any | allowed `Origin` headers, comma separated, e.g. `https://moodle.example.org` |
| `CODELAB_MAX_SESSIONS` | 30 | programs running at once on the server |
| `CODELAB_USER_SESSIONS` | 2 | programs running at once for one user |
| `CODELAB_CPU_SECONDS` | 10 | CPU time of a program |
| `CODELAB_WALL_SECONDS` | 300 | longest session, also while waiting for input |
| `CODELAB_MAX_OUTPUT` | 100000 | bytes of output, then the program is stopped |
| `CODELAB_NPROC` | off | process limit; counts every process of the user, so use it with the user `codelab` only |
| `CODELAB_TMP` | system | folder for the programs during a session |

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
`memory`, `toolong` or `stopped`), `{type: "error", message}`.

In step mode the program is compiled with `-g -O0` and runs under `gdb --interpreter=mi3`; its input and output go
through FIFOs in its folder. A step that goes into the C library (printf, scanf) returns to the student's code at once,
so only the student's lines are shown. `CODELAB_DEBUG_MI=1` prints gdb's machine interface on the server's stderr.

## Tests

```sh
npm test
```

They run real programs in the sandbox (Linux with the packages above).

## License

GNU GPL v3 or later. © 2026 Boban Blagojević.
