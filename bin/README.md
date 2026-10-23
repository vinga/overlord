# bin/

## ovr-watch

Polling wrapper for long waits (deploys, CI). It runs a check command every N
seconds until the output matches `--until` or `--fail`, or `--max` rounds pass.
Each round prints one progress marker. The Overlord server tails the output and
renders the markers as progress cards. In a terminal, it redraws a single
status line with a spinner instead.

```bash
ovr-watch --label "Dev deploy PR 814" --id dev --every 60 --max 25 \
  --until 'deployed' --fail 'Failed|Degraded' --state 'status: (\w+)' \
  -- ./check-deploy.sh dev
```

Exit codes: `0` done, `1` `--fail` matched, `2` timeout, `130` stopped, `64` usage error.
`--fail` is checked before `--until`. `--until`/`--fail` use `grep -E`; `--state`
uses a Python regex (group 1). `ovr-watch --help` lists all options.

### Marker format

```
::progress id=<id> [label="…"] [step=N/M] [state=<word>] [pct=0-100] [done|fail|stopped]:: <message>
```

- `id` defaults to `main`. Each id is one row on the Overlord card. Format: `[A-Za-z0-9_.-]+`.
- `label` is always double-quoted. An inner `"` is escaped as `\"`.
- `state` is a single token, without whitespace.
- The flag `done`, `fail` or `stopped` marks the final line for that id.
- Any other output line is shown as plain text.

`ovr-watch` emits `id`, `label`, `step`, `state` and the final flag. It does not emit `pct`.

### Push to Overlord

If `OVERLORD_PTY_ID` or `OVERLORD_OVR_ID` is set, each marker is also sent
with a POST request to `${OVERLORD_URL:-http://localhost:3173}/api/progress`. This
also applies in a terminal, where markers are not printed.

- `OVERLORD_PTY_ID` is the normal trigger. Overlord sets it on every session it spawns.
- `OVERLORD_OVR_ID` is a manual override. Set it to target a session by its Overlord id.

The request body is JSON. `ptyId` and `ovrId` are included only when set:

```json
{"ptyId": "…", "ovrId": "…", "watchId": "…", "line": "::progress id=main … :: …"}
```

- Each push uses `curl` in the background, with a 2s limit. A slow or stopped
  server does not delay rounds. Push errors never fail the watch.
- The push of the final marker (`done`, `fail` or `stopped`) runs before exit, with a limit of 2s.
- `--watch-id ID` sets the id sent as `watchId`. The default is
  `<id>-<epoch>-<pid>`. Characters outside `[A-Za-z0-9_.-]` become `_`.
- `--no-push` disables pushes. Without either env var, no request is sent.

### Detached mode

`--detach` starts the watch again with `nohup`, in the background. The child
gets `--plain` and the same `--watch-id`. Its output goes to
`${TMPDIR:-/tmp}/ovr-watch-<watch-id>.log`. The parent prints one line and
exits `0` immediately:

```
watching in background: <label> (id <watch-id>, log <log path>)
```

The child continues to run after the calling shell exits. The exit code of the
check is in the log, not in the parent's exit code.

### Install

```bash
ln -s "$PWD/bin/ovr-watch" ~/.local/bin/ovr-watch
```

### Agent usage rule

For long waits, use Bash `run_in_background` with `ovr-watch`. Do not run
`sleep` in the foreground. Do not schedule wakeups only to report progress. For
several targets, run them in one background command:

```bash
ovr-watch --id dev ... -- check dev & ovr-watch --id prod-eu ... -- check prod-eu & wait
```

Codex has no `run_in_background`. Use `--detach` instead:

```bash
ovr-watch --detach --label "Dev deploy PR 814" --until 'deployed' -- ./check-deploy.sh dev
```

Overlord shows the card pinned above the composer and sends one `[ovr-watch] …` line to the session when it ends.
