## Spec: Claude Office Monitor

**Goal:** Aplikacja webowa wizualizująca wszystkie aktywne sesje Claude Code jako pracowników biurowych w widoku 2D z góry, grupując sesje w pokojach według workspace'u, z subagentami jako osobnymi postaciami skupionymi wokół rodzica.

---

### Inputs / Triggers

- Uruchomienie serwera backendowego
- Zmiany plików w `~/.claude/sessions/` (nowe/usunięte sesje)
- Zmiany plików w `~/.claude/projects/**/*.jsonl` (aktualizacje stanu sesji)
- Zmiany plików w `~/.claude/projects/**/{sessionId}/subagents/` (subagenty)
- Polling listy procesów Windows co 5 sekund (sprawdzenie żywotności PID)

---

### Outputs / Side effects

- Serwer HTTP + WebSocket działający na `localhost:3000`
- Frontend React dostępny pod `localhost:5173` (Vite dev) lub serwowany przez backend (prod)
- Widok biurowy aktualizowany w czasie rzeczywistym gdy zmienia się stan sesji

---

### Dane źródłowe

| Plik | Zawartość |
|------|-----------|
| `~/.claude/sessions/{pid}.json` | `pid`, `sessionId`, `cwd`, `startedAt`, `kind` |
| `~/.claude/projects/{slug}/{sessionId}.jsonl` | Pełny transkrypt sesji, każda linia = jedno zdarzenie |
| `~/.claude/projects/{slug}/{sessionId}/subagents/agent-{id}.jsonl` | Transkrypt subagenta |
| `~/.claude/projects/{slug}/{sessionId}/subagents/agent-{id}.meta.json` | `agentType`, `description` subagenta |
| `~/.claude/ide/{pid}.lock` | `workspaceFolders`, `ideName` |

**Slug projektu** = `cwd` z zamianą `\`, `:`, `/` na `-`, np. `C:\projekty\overlord` → `C--projekty-overlord`

---

### Logika stanu sesji

| Stan | Warunek detekcji |
|------|-----------------|
| `working` | Ostatni event w `.jsonl` to `type: "user"` LUB plik `.jsonl` zmodyfikowany < 8s temu |
| `thinking` | Ostatni event to `type: "user"` ale brak odpowiedzi > 2s |
| `waiting` | Ostatni event to `type: "assistant"` i PID żyje |
| `idle` | PID nie istnieje w `tasklist` |

---

### Subagenty

- Wykrywane z katalogu `~/.claude/projects/{slug}/{sessionId}/subagents/`
- Każdy plik `agent-{id}.jsonl` = jeden subagent
- Subagent dziedziczy pokój rodzica (ten sam `cwd`)
- Subagent ma własny stan (`working`/`waiting`/`thinking`/`idle`) wyznaczany tak samo jak rodzic
- W widoku: subagenty renderowane blisko rodzica (np. zgrupowane pod nim)
- Kolor: wariant koloru rodzica (ten sam odcień, niższe nasycenie lub jaśniejszy)
- `agentType` i `description` z pliku `.meta.json` widoczne w panelu bocznym

---

### Grupowanie w pokojach

- Kryterium: pole `cwd` z pliku sesji
- Sesje z identycznym `cwd` → ten sam pokój
- Nazwa pokoju = ostatni segment ścieżki (np. `overlord`)
- Pokoje układane automatycznie w siatce (CSS Grid)

---

### Panel boczny

Otwiera się po kliknięciu w pracownika (główną sesję lub subagenta). Zawiera:

| Pole | Źródło |
|------|--------|
| Session ID (skrócony) | `sessionId` |
| PID | `pid` |
| Workspace | `cwd` |
| Czas trwania | `startedAt` → teraz |
| Aktualny stan | `state` |
| Ostatnia aktywność | timestamp ostatniego eventu w `.jsonl` |
| IDE | `ideName` z `.lock` file |
| Subagenty | lista: `agentType` + `description` + stan każdego |
| Ostatnia wiadomość | ostatni event `type: "assistant"` z `.jsonl` (pierwsze 300 znaków) |

Panel zamykany przyciskiem lub kliknięciem poza nim.

---

### Architektura systemu

```
┌─────────────────────────────────────────────────────┐
│  packages/server/ (Node.js + TypeScript)            │
│                                                     │
│  SessionWatcher  ──chokidar──▶  ~/.claude/sessions/ │
│  TranscriptReader ─tail────▶  ~/.claude/projects/  │
│  SubagentWatcher ──chokidar──▶  .../subagents/      │
│  ProcessChecker  ──tasklist──▶  Windows PIDs        │
│       │                                             │
│  StateManager (in-memory Map<sessionId, Session>)   │
│       │                                             │
│  WebSocketServer ──broadcast──▶ connected clients   │
│  Express static  ──serve──▶  packages/client/dist   │
└─────────────────────────────────────────────────────┘
            │ ws://localhost:3000
┌───────────▼─────────────────────────────────────────┐
│  packages/client/ (React + TypeScript + Vite)       │
│                                                     │
│  useOfficeData() hook (WebSocket + state)           │
│       │                                             │
│  <Office>       ── <Room> per workspace             │
│  <Room>         ── <WorkerGroup> per session        │
│  <WorkerGroup>  ── <Worker> (główna) +              │
│                    <Worker>[] (subagenty)            │
│  <DetailPanel>  ── panel boczny po kliknięciu       │
└─────────────────────────────────────────────────────┘
```

---

### Struktura projektu (monorepo npm workspaces)

```
overlord/
├── package.json                  # root workspace
├── packages/
│   ├── server/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── sessionWatcher.ts
│   │   │   ├── transcriptReader.ts
│   │   │   ├── subagentWatcher.ts
│   │   │   ├── processChecker.ts
│   │   │   └── stateManager.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── client/
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── types.ts
│       │   ├── components/
│       │   │   ├── Office.tsx
│       │   │   ├── Room.tsx
│       │   │   ├── WorkerGroup.tsx
│       │   │   ├── Worker.tsx
│       │   │   └── DetailPanel.tsx
│       │   └── hooks/
│       │       └── useOfficeData.ts
│       ├── index.html
│       ├── package.json
│       └── vite.config.ts
├── specs/
│   └── claude-office-monitor.md
└── CLAUDE.md
```

---

### Model danych (WebSocket payload)

```typescript
type OfficeSnapshot = {
  rooms: Room[];
  updatedAt: string;
};

type Room = {
  id: string;           // hash z cwd
  name: string;         // basename(cwd)
  cwd: string;
  sessions: Session[];
};

type Session = {
  sessionId: string;
  pid: number;
  startedAt: number;    // ms epoch
  state: WorkerState;
  lastActivity: string; // ISO timestamp
  lastMessage?: string; // ostatni tekst z type:"assistant", max 300 znaków
  ideName?: string;
  color: string;        // HSL kolor przypisany do sesji
  subagents: Subagent[];
};

type Subagent = {
  agentId: string;
  agentType: string;    // np. "Explore", "Plan"
  description: string;
  state: WorkerState;
  lastActivity: string;
};

type WorkerState = 'working' | 'waiting' | 'thinking' | 'idle';
```

---

### Wizualizacja

- **Styl:** Pixel-art / retro office – CSS + SVG, bez game engine
- **Pokój:** prostokąt z tytułem (`name`), biurka dla każdej grupy sesji
- **WorkerGroup:** główna postać + subagenty skupione blisko niej
- **Pracownik (SVG):**
  - 🟢 `working` – animacja pisania (bounce)
  - 🔵 `thinking` – pulsujące kółko
  - 🟡 `waiting` – dymek `...` (fade in/out)
  - ⚫ `idle` – 40% opacity, brak animacji
- **Kolory:** każda sesja losuje kolor (HSL hue); subagenty = ten sam hue, jasność +20%
- **Kliknięcie** w dowolną postać → otwiera `<DetailPanel>` z prawej strony

---

### Stack technologiczny

| Warstwa | Technologia |
|---------|------------|
| Backend | Node.js 20+, TypeScript, Express, `ws`, `chokidar` |
| Frontend | React 18, TypeScript, Vite, CSS Modules |
| Komunikacja | WebSocket (`ws` library) |
| Monorepo | `npm workspaces` |

---

### Acceptance Criteria

- [ ] AC1: `npm run dev` z roota startuje jednocześnie serwer (port 3000) i frontend (port 5173)
- [ ] AC2: Wszystkie pliki sesji z `~/.claude/sessions/` wykrywane przy starcie
- [ ] AC3: Nowa sesja pojawia się w UI w ciągu 2 sekund od utworzenia pliku w `sessions/`
- [ ] AC4: Martwy PID → stan `idle` w ciągu 10 sekund
- [ ] AC5: Sesje z tym samym `cwd` renderowane w tym samym pokoju
- [ ] AC6: Stany `working`/`waiting`/`thinking` aktualizują się na podstawie ostatniego eventu w `.jsonl`
- [ ] AC7: UI aktualizuje się bez przeładowania (WebSocket push)
- [ ] AC8: Brak sesji → pusty widok z komunikatem "No active sessions"
- [ ] AC9: Subagenty widoczne jako osobne postaci blisko rodzica, w kolorze pochodnym
- [ ] AC10: Kliknięcie w pracownika otwiera panel boczny z detalami sesji i listą subagentów
- [ ] AC11: Panel boczny zamykany kliknięciem poza nim lub przyciskiem ×

---

### Out of scope

- Autentykacja / dostęp zdalny (tylko localhost)
- Historyczne (martwe) sesje starsze niż bieżąca sesja serwera
- Kontrola sesji z UI (tylko odczyt)
- Linux/macOS (Windows-first, `tasklist`)
- Persystencja między restartami serwera
