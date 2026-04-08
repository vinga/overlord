# Docker + Traefik Setup

Run Claude Office Monitor in Docker with Traefik reverse proxy, accessible at `http://overlord.localhost`.

## Prerequisites

- Docker Desktop installed and running
- Port 80 free (or stop any local web server)

## Setup

### 1. Configure your `.claude` path

Copy `.env.example` to `.env` and set your username:

```env
CLAUDE_DIR=C:/Users/<username>/.claude
```

### 2. Add `overlord.localhost` to your hosts file

Open `C:\Windows\System32\drivers\etc\hosts` as Administrator and add:

```
127.0.0.1 overlord.localhost
```

### 3. Start

```bash
docker compose up --build
```

The first build takes a few minutes (compiles native modules). Subsequent starts are fast.

## URLs

| URL | Description |
|-----|-------------|
| `http://overlord.localhost` | Claude Office Monitor |
| `http://localhost:8080` | Traefik dashboard |

## Stop

```bash
docker compose down
```

## Limitations

Running in a Linux container means some Windows-native features are unavailable:

- **PID checking** — closed sessions stay visible until removed from session files (transcript-based state still works)
- **Terminal/PTY injection** — requires the Windows host; not functional in container
- **`tasklist` process checker** — skipped on Linux; sessions rely on transcript state only
