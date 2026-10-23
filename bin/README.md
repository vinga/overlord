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
