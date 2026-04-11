# Restart Overlord Dev Servers

Restarts the **server** (port 3000) and optionally the **client** (port 5173).
Use this when a port is stuck or you need to reset in-memory state.
Code changes require a manual restart (tsx watch removed). Vite HMR still handles client changes.

**IMPORTANT:** Only kill processes bound to ports 3000/5173 — do NOT kill all node processes, as that destroys active Claude sessions.

## macOS

```bash
# Kill ONLY processes on ports 3000 and 5173
kill -9 $(lsof -ti:3000) 2>/dev/null; kill -9 $(lsof -ti:5173) 2>/dev/null

sleep 1

# Start server
npm run dev --workspace=packages/server > /tmp/overlord-server.log 2>&1 &

# Start client
npm run dev --workspace=packages/client > /tmp/overlord-client.log 2>&1 &

sleep 4
curl -s http://localhost:3000/api/info && echo "" && lsof -ti:5173 | head -1 && echo "Both up"
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
