# Restart Overlord Dev Servers

Restarts the **server** (port 3000) and optionally the **client** (port 5173).
Use this when a port is stuck or you need to reset in-memory state.
Code changes require a manual restart (tsx watch removed). Vite HMR still handles client changes.

**IMPORTANT:** Only kill processes bound to ports 3000/5173 — do NOT kill all node processes, as that destroys active Claude sessions.

**IMPORTANT:** After running the restart commands, the server is up and ready. Do NOT re-run or re-attempt any tool call that was pending before the restart — the restart itself is the complete action. Just report the result and move on.

## Health check (use this to verify, not `lsof -i :3000`)

**Gotcha:** `lsof -i :3000` prints the port as `hbci` (its IANA service name) on macOS, so grepping for `:3000` in the output misses it. Always pass `-P` (disables port-name resolution) or just hit the HTTP endpoint.

```bash
# Reliable: HTTP probe — returns 200 when server is healthy
curl -sS -o /dev/null -w "server:%{http_code}\n" http://localhost:3000/api/info

# Reliable: numeric port listing
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

Treat `server:200` as the single source of truth. Bridge `ENOENT` spam in the log from stale pipes is normal and does NOT mean the server failed to start — check for `Overlord server listening on http://localhost:3000` in the log instead.

## macOS

The entire kill+start sequence runs in a **detached subshell** (`nohup bash -c '...'`).
This is critical: if the caller is an embedded PTY session, killing the server kills
that session too. The detached subshell survives and finishes the restart.

```bash
# Write the restart script to a temp file so it runs detached from this shell.
# This survives embedded PTY session death (server kill = session kill).
cat > /tmp/overlord-restart.sh << 'SCRIPT'
#!/bin/bash
cd /Users/kamilamyczkowska/IdeaProjects/overlord

# Graceful shutdown: SIGTERM first, escalate to SIGKILL after 2s.
srv_pids=$(lsof -ti:3000 2>/dev/null); cli_pids=$(lsof -ti:5173 2>/dev/null)
[ -n "$srv_pids" ] && kill $srv_pids 2>/dev/null
[ -n "$cli_pids" ] && kill $cli_pids 2>/dev/null
sleep 2
srv_pids=$(lsof -ti:3000 2>/dev/null); cli_pids=$(lsof -ti:5173 2>/dev/null)
[ -n "$srv_pids" ] && kill -9 $srv_pids 2>/dev/null
[ -n "$cli_pids" ] && kill -9 $cli_pids 2>/dev/null

# Start server + client
nohup npm run dev --workspace=packages/server > /tmp/overlord-server.log 2>&1 &
nohup npm run dev --workspace=packages/client > /tmp/overlord-client.log 2>&1 &

# Write result for the caller to read
code=000
for i in $(seq 1 150); do
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 1 http://localhost:3000/api/info 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 0.1
done
client=$(lsof -nP -iTCP:5173 -sTCP:LISTEN 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
echo "server:$code  client:$client" > /tmp/overlord-restart-result.txt
SCRIPT
chmod +x /tmp/overlord-restart.sh

# Launch detached — survives even if this shell/session dies
nohup /tmp/overlord-restart.sh > /dev/null 2>&1 &

# Poll for the result file (written by the detached script)
rm -f /tmp/overlord-restart-result.txt
for i in $(seq 1 200); do
  [ -f /tmp/overlord-restart-result.txt ] && break
  sleep 0.1
done
cat /tmp/overlord-restart-result.txt 2>/dev/null || echo "server:pending (check /tmp/overlord-server.log)"
echo "Logs: /tmp/overlord-server.log and /tmp/overlord-client.log"
```

## Windows

```bash
# Kill ONLY processes on ports 3000 and 5173 (not all node processes!)
powershell -Command "
  @(3000, 5173) | ForEach-Object {
    \$port = \$_
    Get-NetTCPConnection -LocalPort \$port -State Listen -ErrorAction SilentlyContinue |
      Where-Object { \$_.OwningProcess -gt 0 } |
      ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }
  }
  Write-Host 'Ports cleared'
"

sleep 2

# Start server (no watch — won't auto-restart on file changes)
cd C:/projekty/overlord && npm run dev --workspace=packages/server > C:/tmp/overlord-server.log 2>&1 &

sleep 1

# Start client (Vite HMR handles client changes automatically)
cd C:/projekty/overlord/packages/client && C:/projekty/overlord/node_modules/.bin/vite.cmd > C:/tmp/overlord-client.log 2>&1 &

sleep 4
echo "Server: http://localhost:3000  |  Client: http://localhost:5173"
echo "Logs: C:/tmp/overlord-server.log and C:/tmp/overlord-client.log"
```
