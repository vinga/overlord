# Restart Overlord Dev Servers

Restarts the **server** (port 3000) and optionally the **client** (port 5173).
Use this when a port is stuck or you need to reset in-memory state.
Code changes auto-reload via `tsx watch` / Vite HMR — no restart needed for those.

```bash
# Kill anything on port 3000 and 5173
powershell -Command "
  @(3000, 5173) | ForEach-Object {
    \$port = \$_
    Get-NetTCPConnection -LocalPort \$port -ErrorAction SilentlyContinue |
      Where-Object { \$_.OwningProcess -gt 0 } |
      ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }
  }
  Write-Host 'Ports cleared'
"

sleep 2

# Start server
cd C:/projekty/overlord && npm run dev --workspace=packages/server &

sleep 1

# Start client
cd C:/projekty/overlord/packages/client && C:/projekty/overlord/node_modules/.bin/vite.cmd &

sleep 4
echo "Server: http://localhost:3000  |  Client: http://localhost:5173"
```