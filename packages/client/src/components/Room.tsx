import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import type { Room as RoomType, Session, SessionProvider, TerminalSpawnMode, ArchiveEntry } from '../types';
import { getLaunchInfo } from '../types';
import { WorkerGroup } from './WorkerGroup';
import { SessionCommands } from './SessionCommands';
import styles from './Room.module.css';
import { SpawnDialog } from './SpawnDialog';
import { useRoomOrder } from '../hooks/useRoomOrder';
import { useRoomCollapsed } from '../hooks/useRoomCollapsed';
import { useRoomHidden } from '../hooks/useRoomHidden';
import { GitBranchBadge } from './GitBranchBadge';
import { ArchiveStatsTooltip } from './ArchiveStatsTooltip';
import { ROOM_PREFIX_ENABLED } from '../config/featureFlags';

// 300 distinctive names for new sessions — pick a random unused one
export const SESSION_NAMES = [
  'Alaric','Amara','Ashton','Astrid','Aurelia','Balthazar','Bastian','Beatrix','Bramble','Brynhild',
  'Callisto','Caspian','Cassius','Cedar','Celestine','Dagny','Dashiell','Delphine','Dusk','Dmitri',
  'Eirik','Elowen','Ember','Enrique','Esme','Falcon','Florian','Freya','Fujin','Felix',
  'Gautier','Gideon','Grove','Gunnar','Galatea','Hadrian','Halcyon','Hazel','Hikaru','Hector',
  'Idris','Ingrid','Isolde','Indigo','Isadora','Jasper','Jinhai','Jorvik','Juniper','Juno',
  'Kael','Kaida','Kestrel','Kieran','Knox','Lark','Leander','Lirien','Lysander','Lucian',
  'Magnus','Marcellus','Mireille','Moss','Maeve','Nero','Niamh','Nyx','Noelle','Naveen',
  'Octavia','Odin','Onyx','Orion','Ophelia','Paloma','Percival','Petra','Petal','Phoenix',
  'Quillan','Quillon','Quentin','Quinlan','Quade','Rafaela','Ragnar','Raven','Rosalind','Rune',
  'Sable','Sigrid','Soren','Storm','Stellan','Talon','Thalassa','Theron','Torsten','Thistle',
  'Ulric','Ulfric','Umber','Ursa','Ulysse','Vale','Vesper','Viggo','Vidar','Valentina',
  'Wahid','Wilder','Wren','Wynne','Wolfgang','Xanthe','Xiomara','Xander','Xerxes','Xyla',
  'Yael','Ysolde','Yuki','Yarrow','Yves','Zephyr','Zora','Zenith','Zahir','Zinnia',
  'Rowan','Thane','Elara','Cassian','Saffron','Oberon','Linnea','Cosimo','Fenrir','Solana',
  'Altair','Briar','Calyx','Dante','Eclipse','Finch','Garnet','Haven','Iona','Jovian',
  'Katya','Lazarus','Meridian','Noor','Oleander','Pax','Rhiannon','Solstice','Tiberius','Umbra',
  'Vega','Willow','Xylo','Yara','Zander','Anika','Blaise','Corvus','Daria','Elodie',
  'Fable','Galen','Harlow','Inara','Jericho','Koda','Linden','Maren','Nemo','Orla',
  'Sage','Tavi','Vexen','Whisper','Xeno','Arwen','Blythe','Cyrus','Dione','Eris',
  'Fern','Greer','Helios','Arden','Kira','Lumen','Milo','Nico','Opal','Pike',
  'Rook','Slate','Tarn','Voss','Wynn','Ximena','Zarya','Ajax','Birch','Cleo',
  'Draco','Etta','Flint','Gale','Heron','Iris','Jace','Kelda','Lyric','Mace',
  'Nash','Priya','Shale','Teal','Vane','Corvo','Dove','Echo','Frost','Grail',
  'Heath','Ibis','Jade','Nell','Oaken','Penn','Rhea','Skye','Axel','Beck',
  'Crux','Fenn','Halo','Jett','Nord','Pyre','Astra','Blaze','Cade','Drift',
  'Flux','Grit','Seren','Larkin','Mercer','Sparrow','Hollis','Bronte','Isidore','Clover',
  'Evander','Fielding','Gareth','Hadley','Ianthe','Jasmine','Kellan','Lorelei','Maddox','Nolan',
  'Olexa','Pascal','Reverie','Simone','Tamsin','Ulyana','Viktor','Waverly','Xaldin','Yasmin',
  'Zephyra','Archer','Bellamy','Cedric','Dulcie','Esmera','Fabian','Gemma','Harper','Ignace',
  'Jorah','Atlas','Isolde','Cinder','Thalia','Oriel','Ronan','Sable','Lyra','Ember',
  // batch 2 — 300 originals
  'Aethon','Boreas','Calder','Drevak','Elvan','Fyren','Gravik','Halvard','Ilvane','Jokull',
  'Kaldris','Lyrvane','Molveth','Neldrak','Orvith','Pyrrik','Quelvan','Rosveth','Sildrak','Torvath',
  'Ulvrik','Veldrak','Wyndrak','Xolvath','Yrveth','Zaldane','Aelborn','Bryndor','Celdane','Draveth',
  'Elorith','Fyldane','Galdeth','Halveth','Ilydor','Jalvane','Keldris','Lirborn','Maldeth','Nalvane',
  'Ananke','Hemera','Hypnos','Khione','Eos','Selene','Hecate','Asteria','Phoebe','Perses',
  'Zuberi','Amani','Jabari','Kofi','Kwame','Adaeze','Emeka','Ngozi','Obinna','Chiamaka',
  'Haruki','Hotaru','Izumi','Kagami','Kasumi','Kohaku','Koyuki','Murasaki','Natsuki','Tsuki',
  'Piran','Gwydion','Blodeuedd','Taliesin','Ceridwen','Arianrhod','Pwyll','Pryderi','Manawyd','Carantoc',
  'Aldebaran','Bellatrix','Mintaka','Alnitak','Alnilam','Saiph','Arneb','Phact','Wezn','Nihal',
  'Cressida','Perdita','Titania','Miranda','Caliban','Trinculo','Stephano','Prospero','Sycorax','Gonzalo',
  'Heliodor','Peridot','Tsavorite','Tanzanite','Alexandrite','Paraiba','Phenakite','Demantoid','Indicolite','Rubelite',
  'Morion','Goshenite','Morganite','Larimar','Labradorite','Moonstone','Sunstone','Bloodstone','Carnelian','Chrysoprase',
  'Vrana','Kalina','Zorka','Vesna','Neda','Rada','Zlata','Brana','Stela','Milena',
  'Dragan','Boran','Gordan','Miran','Dalibor','Branimir','Dobrivoj','Vladislav','Zivko','Ratko',
  'Revka','Eiran','Boaz','Liron','Nofar','Shira','Tamar','Yonatan','Avital','Dafna',
  'Gudrun','Solveig','Bryndis','Frode','Sigrun','Thorleif','Ragnvald','Eyvind','Vigfus','Snorri',
  'Fionn','Caoimhe','Sorcha','Tadhg','Nuala','Oisin','Eithne','Ciara','Aoibhe','Seanan',
  'Noctis','Lucis','Aevum','Caelum','Orbis','Nexum','Axius','Vexor','Kyrix','Drakon',
  'Zephyros','Euros','Notos','Aeolus','Triton','Proteus','Nereus','Tethys','Doris','Galene',
  'Morwen','Elorian','Sylvaine','Thornwick','Ashveil','Glenmoor','Darkholm','Starweald','Moonhollow','Brightfen',
  'Velox','Cygni','Lyrae','Aquilae','Cephei','Orionis','Scorpii','Leonis','Virginis','Tauri',
  'Caelindra','Sylvreth','Morwenna','Thorneval','Duskfall','Cinderveil','Ashenveil','Gloomhaven','Frostmere','Embercroft',
  'Makari','Balor','Cernunnos','Dagda','Goibniu','Morrigan','Nuada','Brighid','Lugh','Danu',
  'Aozora','Hayate','Oboro','Suzume','Takara','Utsuro','Yamabuki','Yozora','Fubuki','Ikazuchi',
  'Calveth','Vorin','Trevak','Xalvan','Yndrek','Zaveth','Aldak','Brivel','Corvath','Elveth',
  'Falvak','Gloren','Haldrek','Ilvath','Jolvak','Korven','Lardrek','Morvath','Naldrak','Orvath',
  'Paldrek','Qalveth','Roldrak','Saldeth','Tolveth','Ulvath','Valdrek','Welvan','Xoldrak','Yaldrek',
  'Noctua','Solarius','Lunaris','Cometis','Cosmica','Astronis','Stellaris','Nebulis','Orbita','Galaxia',
  'Thornden','Emberveil','Frostmoor','Stonefield','Duskwood','Dawntide','Cloudrift','Nightveil','Sunrift','Stormrift',
  'Elspeth','Merewyn','Sunniva','Aldwyn','Wulfric','Edwyn','Aelwyn','Briseis','Calynda','Evadne',
];

function lightenHsl(color: string, amount: number): string {
  const m = color.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
  if (!m) return color;
  const h = parseFloat(m[1]);
  const s = parseFloat(m[2]);
  const l = Math.min(100, parseFloat(m[3]) + amount);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function ArchiveAvatar({ color, keyId }: { color: string; keyId: string }) {
  const base = lightenHsl(color, 0);
  const hi = lightenHsl(base, 25);
  const gradId = `archgrad-${keyId}`;
  return (
    <svg width="18" height="20" viewBox="0 0 40 44" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0, opacity: 0.75 }}>
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="60%" y2="100%">
          <stop offset="0%" stopColor={hi} />
          <stop offset="100%" stopColor={base} />
        </linearGradient>
      </defs>
      <circle cx="20" cy="10" r="9" fill={`url(#${gradId})`} />
      <circle cx="16.5" cy="9.5" r="1.7" fill="rgba(0,0,0,0.55)" />
      <circle cx="23.5" cy="9.5" r="1.7" fill="rgba(0,0,0,0.55)" />
      <rect x="11" y="21" width="18" height="18" rx="3" fill={`url(#${gradId})`} />
    </svg>
  );
}

function extractFirstLine(content: string): string {
  const raw = content.split('\n')[0] ?? '';
  return raw.replace(/^[#>*\-_`~\s]+/, '').trim();
}

function lastActivityLabel(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '<1m';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  return `${diffHour}h`;
}

/** Tooltip for the desk age label — spells out what the "10h" / "18m" badge measures. */
function lastActivityTooltip(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return 'Time since last activity in this session';
  const when = d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  return `Time since last activity — last message at ${when}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function formatArchiveEntryTime(archivedAt: string): string {
  const d = new Date(archivedAt);
  const today0 = startOfDay(new Date());
  const y0 = today0 - 86_400_000;
  const t = d.getTime();
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (t >= today0) return hm;
  if (t >= y0) return `yesterday ${hm}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function groupArchiveByTime(entries: ArchiveEntry[]): Array<{ label: string; entries: ArchiveEntry[] }> {
  const now = new Date();
  const today0 = startOfDay(now);
  const y0 = today0 - 86_400_000;
  const d2 = today0 - 2 * 86_400_000;
  const week0 = today0 - 7 * 86_400_000;
  const month0 = today0 - 30 * 86_400_000;

  const buckets: Record<string, ArchiveEntry[]> = {
    Today: [], Yesterday: [], '2 days ago': [],
    'Earlier this week': [], 'This month': [], Older: [],
  };
  const order = ['Today', 'Yesterday', '2 days ago', 'Earlier this week', 'This month', 'Older'];

  const sorted = [...entries].sort((a, b) =>
    new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime()
  );
  for (const e of sorted) {
    const t = new Date(e.archivedAt).getTime();
    const key = t >= today0 ? 'Today'
      : t >= y0 ? 'Yesterday'
      : t >= d2 ? '2 days ago'
      : t >= week0 ? 'Earlier this week'
      : t >= month0 ? 'This month'
      : 'Older';
    buckets[key].push(e);
  }
  return order.filter(k => buckets[k].length > 0).map(label => ({ label, entries: buckets[label] }));
}



function OverlordToast({ message, icon, accent, onDone }: { message: string; icon: React.ReactNode; accent: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2500);
    return () => clearTimeout(t);
  }, [onDone]);

  return ReactDOM.createPortal(
    <div
      onClick={onDone}
      style={{
        position: 'fixed', top: 16, right: 16,
        background: '#2a2a3d', border: `1px solid ${accent}`,
        borderRadius: 9, padding: '10px 16px',
        display: 'flex', alignItems: 'center', gap: 10,
        boxShadow: '0 6px 24px rgba(0,0,0,0.6)',
        fontFamily: "'Inter',system-ui,sans-serif", fontSize: 13,
        color: 'rgba(255,255,255,0.92)', zIndex: 10000,
        cursor: 'pointer', animation: 'toastIn 0.15s ease',
      }}
    >
      {icon}
      <span>{message}</span>
    </div>,
    document.body
  );
}

function CommandCopiedToast({ onDone }: { onDone: () => void }) {
  return (
    <OverlordToast
      message="Command copied — paste in your terminal"
      accent="rgba(212,175,55,0.35)"
      icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
      onDone={onDone}
    />
  );
}


interface RoomProps {
  room: RoomType;

  onSelectSession: (session: Session, subagentId?: string) => void;
  customNames: Record<string, string>;
  onSpawnSession?: (cwd: string) => void;
  onSpawnDirect?: (cwd: string, name: string, mode: TerminalSpawnMode, provider: SessionProvider) => void;
  selectedSessionId?: string | null;
  onRoomClick?: (roomId: string) => void;
  isSpawning?: boolean;
  onSpawnNameChange?: (name: string) => void;
  onSpawnCommit?: (name: string | null) => void;
  onDeleteSession?: (sessionId: string) => void;
  onCloseSession?: (sessionId: string) => void;
  onArchiveSession?: (sessionId: string) => void;
  onOpenArchive?: (entry: ArchiveEntry) => void;
  onDeleteArchive?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  onCloneSession?: (sessionId: string) => void;
  onNewTerminalSession?: (cwd: string, mode?: TerminalSpawnMode) => void;
  terminalSpawnCwd?: string | null;
  onTerminalSpawnCommit?: (name: string | null) => void;
  isPtySession?: (sessionId: string) => boolean;
  pendingSpawns?: Array<{ id: string; cwd: string; fullName: string; startedAt: number }>;
  platform?: string;
  onRoomDragStart?: (e: React.DragEvent) => void;
  onRoomDragEnd?: () => void;
  /** True when this room is hidden but rendered because it matches an active search. */
  searchRevealed?: boolean;
}

function SpawningDesk({ name }: { name: string }) {
  return (
    <div className={`${styles.desk} ${styles.deskSpawning}`} aria-busy="true">
      <div className={styles.deskInfo}>
        <div className={styles.deskTimeLabel}>spawning</div>
      </div>
      <div className={styles.spawningWorker}>
        <svg
          width="48"
          height="63"
          viewBox="0 0 40 52"
          xmlns="http://www.w3.org/2000/svg"
          className={styles.spawningSvg}
        >
          <defs>
            <linearGradient id={`spawn-grad-${name}`} x1="0%" y1="0%" x2="60%" y2="100%">
              <stop offset="0%" stopColor="rgba(212,175,55,0.55)" />
              <stop offset="100%" stopColor="rgba(212,175,55,0.18)" />
            </linearGradient>
          </defs>
          <circle cx="20" cy="12" r="10" fill={`url(#spawn-grad-${name})`} />
          <rect x="10" y="24" width="20" height="22" rx="3" fill={`url(#spawn-grad-${name})`} />
          <rect x="2" y="24" width="7" height="14" rx="2" fill="rgba(212,175,55,0.22)" />
          <rect x="31" y="24" width="7" height="14" rx="2" fill="rgba(212,175,55,0.22)" />
          <rect x="11" y="46" width="7" height="6" rx="2" fill="rgba(212,175,55,0.22)" />
          <rect x="22" y="46" width="7" height="6" rx="2" fill="rgba(212,175,55,0.22)" />
        </svg>
        <span className={styles.spawningLabel}>{name}</span>
        <span className={styles.spawningHint}>
          <span className={styles.spawningDot} />
          <span className={styles.spawningDot} />
          <span className={styles.spawningDot} />
        </span>
      </div>
    </div>
  );
}

function DeskMenu({ onDelete, onClone, onClear, onArchive, onClose }: { onDelete: () => void; onClone?: () => void; onClear?: () => void; onArchive?: () => void; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'absolute', top: 4, right: 4, zIndex: 10 }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          background: 'rgba(30,30,40,0.85)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 4, color: 'rgba(255,255,255,0.4)', width: 22, height: 22,
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0, opacity: 0.5,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; }}
        title="Options"
      >
        <svg width="12" height="10" viewBox="0 0 12 10" fill="currentColor">
          <rect y="0" width="12" height="1.5" rx="0.75"/>
          <rect y="4.25" width="12" height="1.5" rx="0.75"/>
          <rect y="8.5" width="12" height="1.5" rx="0.75"/>
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 26, right: 0, background: '#1e1e2e',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: 4,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', zIndex: 100, minWidth: 140,
        }}>
          {onClone && (
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onClone(); }}
              style={{
                display: 'block', width: '100%', padding: '8px 14px',
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >Clone</button>
          )}
          {onClear && (
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onClear(); }}
              style={{
                display: 'block', width: '100%', padding: '8px 14px',
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(251,146,60,0.1)'; e.currentTarget.style.color = '#fb923c'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >Clear</button>
          )}
          {onClose && (
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onClose(); }}
              style={{
                display: 'block', width: '100%', padding: '8px 14px',
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(148,163,184,0.15)'; e.currentTarget.style.color = '#cbd5e1'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >Close</button>
          )}
          {onArchive && (
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onArchive(); }}
              style={{
                display: 'block', width: '100%', padding: '8px 14px',
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(148,163,184,0.15)'; e.currentTarget.style.color = '#cbd5e1'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >Archive</button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(); }}
            style={{
              display: 'block', width: '100%', padding: '8px 14px',
              background: 'none', border: 'none', color: '#ff6b6b',
              fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,107,107,0.1)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >Delete</button>
        </div>
      )}
    </div>
  );
}

function SpawnMenu({ cwd, onSpawnEmbedded, onSpawnTerminal, platform = 'darwin' }: { cwd: string; onSpawnEmbedded: () => void; onSpawnTerminal?: (mode?: TerminalSpawnMode) => void; platform?: string }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const itemStyle: React.CSSProperties = {
    display: 'block', width: '100%', padding: '8px 14px',
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
    fontSize: 13, textAlign: 'left', cursor: 'pointer', borderRadius: 6,
    whiteSpace: 'nowrap',
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className={styles.spawnButton}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        title={`New Claude session in ${cwd}`}
        aria-label="New session menu"
      >
        +
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          background: '#1e1e2e', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8, padding: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          zIndex: 100, minWidth: 180,
        }}>
          <button
            style={itemStyle}
            onClick={() => { setOpen(false); onSpawnEmbedded(); }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
          >New Overlord Session</button>
          {onSpawnTerminal && (<>
            <button
              style={itemStyle}
              onClick={() => { setOpen(false); onSpawnTerminal('bridge'); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >{platform === 'win32' ? 'New Terminal (bridge)' : 'New Terminal.app (bridge)'}</button>
            <button
              style={itemStyle}
              onClick={() => { setOpen(false); onSpawnTerminal('plain'); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >{platform === 'win32' ? 'New Terminal (direct)' : 'New Terminal.app (direct)'}</button>
          </>)}
        </div>
      )}
    </div>
  );
}

export function Room({ room, onSelectSession, customNames, onSpawnSession, onSpawnDirect, selectedSessionId, onRoomClick, isSpawning, onSpawnNameChange, onSpawnCommit, onDeleteSession, onCloseSession, onArchiveSession, onOpenArchive, onDeleteArchive, onRenameSession, onCloneSession, onNewTerminalSession, terminalSpawnCwd, onTerminalSpawnCommit, isPtySession, pendingSpawns, platform = 'darwin', onRoomDragStart, onRoomDragEnd, searchRevealed = false }: RoomProps) {
  const [, setTick] = useState(0);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [spawnName, setSpawnName] = useState('');
  const [terminalSpawnName, setTerminalSpawnName] = useState('');
  const [terminalMode, setTerminalMode] = useState<TerminalSpawnMode>('bridge');
  const [showSpawnPanel, setShowSpawnPanel] = useState(false);
  const [spawnPanelName, setSpawnPanelName] = useState('');
  const [namePrefix, setNamePrefix] = useState('');
  const [lastMode, setLastMode] = useState<TerminalSpawnMode>('embedded');
  const [lastProvider, setLastProvider] = useState<SessionProvider>('claude');
  const [showCopyToast, setShowCopyToast] = useState(false);
  const [clearToast, setClearToast] = useState<'sent' | 'error' | null>(null);
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntry[]>([]);
  const [archiveExpanded, setArchiveExpanded] = useState(false);
  const [confirmDeleteArchiveId, setConfirmDeleteArchiveId] = useState<string | null>(null);

  const fetchArchive = React.useCallback(() => {
    fetch(`/api/archive/by-room/${encodeURIComponent(room.id)}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(json => setArchiveEntries(Array.isArray(json.entries) ? json.entries : []))
      .catch(() => { /* ignore */ });
  }, [room.id]);

  useEffect(() => { fetchArchive(); }, [fetchArchive]);

  useEffect(() => {
    function onChange(ev: Event) {
      const detail = (ev as CustomEvent).detail as { roomId?: string } | undefined;
      if (!detail?.roomId || detail.roomId === room.id) fetchArchive();
    }
    window.addEventListener('archive:changed', onChange);
    return () => window.removeEventListener('archive:changed', onChange);
  }, [fetchArchive, room.id]);

  const handleArchive = onArchiveSession ? (sessionId: string) => {
    onArchiveSession(sessionId);
    setTimeout(fetchArchive, 500);
  } : undefined;
  const { getOrder, setOrder } = useRoomOrder();
  const { isCollapsed, toggle } = useRoomCollapsed();
  const collapsed = isCollapsed(room.id);
  const { isHidden, hide, unhide } = useRoomHidden();
  const hidden = isHidden(room.id);

  const isTerminalSpawning = terminalSpawnCwd === room.cwd;

  function getNextName(prefix: string, separator: string = '+'): string {
    const usedNames = new Set([
      ...Object.values(customNames),
      ...room.sessions.map(s => s.proposedName).filter(Boolean),
    ] as string[]);
    // Pick a random unused name from the pool
    const available = SESSION_NAMES.filter(n => !usedNames.has(n));
    if (available.length > 0) {
      return available[Math.floor(Math.random() * available.length)];
    }
    // Fallback: numbered names if all 300 are taken
    let max = 0;
    const escapedSep = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${prefix}\\${escapedSep}(\\d+)$`);
    for (const name of usedNames) {
      const match = name?.match(pattern);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return `${prefix}${separator}${max + 1}`;
  }

  // Use room.id as the stable key for localStorage
  const roomKey = room.id;

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/room-config?cwd=${encodeURIComponent(room.cwd)}`)
      .then(r => r.ok ? r.json() as Promise<{ prefix: string; lastMode?: TerminalSpawnMode; lastProvider?: SessionProvider }> : null)
      .then(cfg => {
        if (!cancelled && cfg) {
          setNamePrefix(ROOM_PREFIX_ENABLED ? (cfg.prefix ?? '') : '');
          if (cfg.lastMode) setLastMode(cfg.lastMode);
          setLastProvider(cfg.lastProvider === 'opencode' || cfg.lastProvider === 'codex' ? cfg.lastProvider : 'claude');
        }
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [room.cwd]);

  const spawnInputRef = useRef<HTMLInputElement>(null);
  const terminalSpawnInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isSpawning) {
      const name = getNextName('OVERLORD');
      setSpawnName(name);
      onSpawnNameChange?.(name);
      setTimeout(() => { spawnInputRef.current?.focus(); spawnInputRef.current?.select(); }, 50);
    } else {
      setSpawnName('');
    }
  }, [isSpawning]);

  useEffect(() => {
    if (isTerminalSpawning) {
      const prefix = terminalMode === 'bridge' ? 'BRIDGE' : 'DIRECT';
      const sep = terminalMode === 'bridge' ? '+' : '*';
      const name = getNextName(prefix, sep);
      setTerminalSpawnName(name);
      setTimeout(() => { terminalSpawnInputRef.current?.focus(); terminalSpawnInputRef.current?.select(); }, 50);
    } else {
      setTerminalSpawnName('');
    }
  }, [isTerminalSpawning, terminalMode]);

  function handleSpawn(e: React.MouseEvent) {
    e.stopPropagation();
    if (onSpawnSession) {
      onSpawnSession(room.cwd);
    }
  }

  // Build sorted sessions list respecting custom order.
  // Ordering is keyed by overlordId (stable across /clear and --resume) so
  // resuming a session doesn't reshuffle its slot. Falls back to sessionId
  // for any session without an overlordId.
  const orderKey = (s: Session): string => s.overlordId ?? s.sessionId;
  // Stable fallback when no custom order exists: oldest startedAt first.
  // Idle time is intentionally NOT used — workers must not reshuffle as
  // closed sessions age past arbitrary thresholds.
  const byStartedAt = (a: Session, b: Session): number =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
  // Dedup by overlordId: a single lineage (same overlordId across resumes)
  // should render as one worker. Prefer an active session over closed, then
  // most recent by startedAt.
  const dedupByOverlord = (sessions: Session[]): Session[] => {
    const bestByOvr = new Map<string, Session>();
    for (const s of sessions) {
      const key = s.overlordId ?? s.sessionId;
      const cur = bestByOvr.get(key);
      if (!cur) { bestByOvr.set(key, s); continue; }
      const sActive = s.state !== 'closed';
      const curActive = cur.state !== 'closed';
      if (sActive !== curActive) {
        if (sActive) bestByOvr.set(key, s);
        continue;
      }
      if (s.startedAt > cur.startedAt) bestByOvr.set(key, s);
    }
    return [...bestByOvr.values()];
  };
  const allSessions = dedupByOverlord(room.sessions);

  const storedOrder = getOrder(roomKey);

  let sortedSessions: Session[];
  if (storedOrder.length > 0) {
    const orderedMap = new Map(storedOrder.map((id, idx) => [id, idx]));
    const inOrder = allSessions
      .filter(s => orderedMap.has(orderKey(s)))
      .sort((a, b) => (orderedMap.get(orderKey(a)) ?? 0) - (orderedMap.get(orderKey(b)) ?? 0));
    const notInOrder = allSessions
      .filter(s => !orderedMap.has(orderKey(s)))
      .sort(byStartedAt);
    sortedSessions = [...inOrder, ...notInOrder];
  } else {
    sortedSessions = [...allSessions].sort(byStartedAt);
  }

  const handleDrop = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    const currentOrder = sortedSessions.map(orderKey);
    const fromIdx = currentOrder.indexOf(draggedId);
    const toIdx = currentOrder.indexOf(targetId);
    const newOrder = [...currentOrder];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, draggedId);
    setOrder(roomKey, newOrder);
    setDraggedId(null);
    setDragOverId(null);
  };

  // Compute state counts for collapsed summary.
  // Reviewed waiting sessions are silenced (read or parked) — they don't
  // contribute to the waiting chip.
  const stateCounts = room.sessions.reduce<Record<string, number>>((acc, s) => {
    if (s.state === 'waiting' && s.review != null) return acc;
    acc[s.state] = (acc[s.state] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className={`${styles.room} ${collapsed ? styles.roomCollapsed : ''}`}>
      <div className={styles.titleBar}>
        {onRoomDragStart && (
          <span
            className={styles.roomDragHandle}
            draggable
            onDragStart={onRoomDragStart}
            onDragEnd={onRoomDragEnd}
            title="Drag to reorder room"
            aria-hidden="true"
          >⠿</span>
        )}
        <button
          className={styles.collapseBtn}
          onClick={() => toggle(room.id)}
          data-tooltip={collapsed ? 'Expand room' : 'Collapse room'}
          data-tooltip-dir="down"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
            <polyline points="2 3 5 6 8 3" />
          </svg>
        </button>
        <button
          className={`${styles.hideBtn} ${hidden ? styles.hideBtnActive : ''}`}
          onClick={() => (hidden ? unhide(room.id, room.cwd) : hide(room.id, room.cwd))}
          data-tooltip={hidden ? 'Show room' : 'Hide room'}
          data-tooltip-dir="down"
          aria-label={hidden ? 'Show room' : 'Hide room'}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
            <circle cx="8" cy="8" r="1.8" />
            {hidden && <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" />}
          </svg>
        </button>
        <div className={styles.roomNameStack}>
          <span
            className={`${styles.roomName} ${onRoomClick ? styles.roomNameClickable : ''}`}
            onClick={onRoomClick ? (e) => { e.stopPropagation(); onRoomClick(room.id); } : undefined}
            role={onRoomClick ? 'button' : undefined}
            tabIndex={onRoomClick ? 0 : undefined}
            onKeyDown={onRoomClick ? (e) => { if (e.key === 'Enter') onRoomClick(room.id); } : undefined}
            title={onRoomClick ? room.cwd : undefined}
          >
            {room.name}
          </span>
          {(() => {
            const firstLine = room.description ? extractFirstLine(room.description) : '';
            if (!firstLine) return null;
            return (
              <span className={styles.roomDescription} title={room.description}>{firstLine}</span>
            );
          })()}
        </div>
        {searchRevealed && (
          <span
            className={styles.hiddenBadge}
            data-tooltip="This room is hidden — shown because it matches your search"
            data-tooltip-dir="down"
          >hidden</span>
        )}
        {collapsed && (
          <div className={styles.collapsedChips}>
            {(['working', 'thinking', 'waiting', 'closed'] as const).map(state => {
              const count = stateCounts[state];
              if (!count) return null;
              return (
                <span key={state} className={`${styles.stateChip} ${styles[`stateChip_${state}`]}`} data-tooltip={`${count} ${state}`}>
                  {count}
                </span>
              );
            })}
          </div>
        )}
        <div className={styles.titleSpacer} />
        {room.gitBranch && (
          <GitBranchBadge
            branch={room.gitBranch}
            cwd={room.cwd}
            gitWarning={room.gitWarning}
            pullRequest={room.pullRequest}
            gitAhead={room.gitAhead}
          />
        )}
        {onSpawnDirect && (
          <button
            className={styles.spawnButton}
            onClick={async (e) => {
              e.stopPropagation();
              if (showSpawnPanel) { setShowSpawnPanel(false); return; }
              const baseName = getNextName('');
              if (ROOM_PREFIX_ENABLED) {
                try {
                  const r = await fetch(`/api/room-config?cwd=${encodeURIComponent(room.cwd)}`);
                  if (r.ok) {
                    const cfg = await r.json() as { prefix?: string };
                    setNamePrefix(cfg.prefix ?? '');
                  }
                } catch { /* fall back to cached namePrefix */ }
              }
              setSpawnPanelName(baseName);
              setShowSpawnPanel(true);
            }}
            data-tooltip="New session — choose name &amp; mode"
            data-tooltip-dir="down"
            data-tooltip-align="right"
            aria-label="New session"
          >+</button>
        )}
        {onSpawnDirect && room.sessions.length > 0 && (
          <button
            className={styles.quickSpawnButton}
            onClick={async (e) => {
              e.stopPropagation();
              const baseName = getNextName('');
              let fresh = namePrefix;
              let mode: TerminalSpawnMode = lastMode;
              let provider: SessionProvider = lastProvider;
              try {
                const r = await fetch(`/api/room-config?cwd=${encodeURIComponent(room.cwd)}`);
                if (r.ok) {
                  const cfg = await r.json() as { prefix?: string; lastMode?: TerminalSpawnMode; lastProvider?: SessionProvider };
                  fresh = ROOM_PREFIX_ENABLED ? (cfg.prefix ?? '') : '';
                  setNamePrefix(fresh);
                  if (cfg.lastMode) { mode = cfg.lastMode; setLastMode(cfg.lastMode); }
                  provider = cfg.lastProvider === 'opencode' || cfg.lastProvider === 'codex' ? cfg.lastProvider : 'claude';
                  setLastProvider(provider);
                }
              } catch { /* fall back to cached values */ }
              if (provider === 'opencode' || provider === 'codex') mode = 'embedded';
              fetch('/api/room-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd: room.cwd, lastMode: mode, lastProvider: provider }),
              }).catch(() => {});
              setLastMode(mode);
              setLastProvider(provider);
              onSpawnDirect(room.cwd, fresh + baseName, mode, provider);
            }}
            data-tooltip={`Quick spawn — reuse last selection (${lastProvider}, ${lastMode})`}
            data-tooltip-dir="down"
            data-tooltip-align="right"
            aria-label="Quick spawn"
          >
            <span>+</span>
            <svg width="7" height="9" viewBox="0 0 8 11" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginLeft: 1, flexShrink: 0, alignSelf: 'flex-end', marginBottom: 2 }}>
              <path d="M6 1L3.5 5.5h3L2 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
      </div>
      {showSpawnPanel && onSpawnDirect && (
        <SpawnDialog
          open
          fixedCwd={room.cwd}
          suggestedName={spawnPanelName}
          initialPrefix={namePrefix}
          onSpawn={(cwd, fullName, mode, provider, prefix) => {
            fetch('/api/room-config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cwd: room.cwd, prefix, lastMode: mode, lastProvider: provider }),
            }).catch(() => {});
            setNamePrefix(prefix);
            setLastMode(mode);
            setLastProvider(provider);
            onSpawnDirect(cwd, fullName, mode, provider);
            setShowSpawnPanel(false);
          }}
          onClose={() => setShowSpawnPanel(false)}
          onCopyAndClose={() => setShowCopyToast(true)}
          onPrefixSaved={(p) => setNamePrefix(p)}
        />
      )}
      {showCopyToast && <CommandCopiedToast onDone={() => setShowCopyToast(false)} />}
      {clearToast === 'sent' && (
        <OverlordToast
          message="/clear sent — conversation will reset shortly"
          accent="rgba(212,175,55,0.35)"
          icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
          onDone={() => setClearToast(null)}
        />
      )}
      {clearToast === 'error' && (
        <OverlordToast
          message="Clear failed — session may be busy or inaccessible"
          accent="rgba(239,68,68,0.4)"
          icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>}
          onDone={() => setClearToast(null)}
        />
      )}
      {!collapsed && <div className={styles.desks}>
        {sortedSessions.map((session) => {
          const isSelected = session.overlordId === selectedSessionId || session.sessionId === selectedSessionId;
          const sessionOrderKey = orderKey(session);
          const isDragging = draggedId === sessionOrderKey;
          const isDragOver = dragOverId === sessionOrderKey && draggedId !== sessionOrderKey;
          return (
            <div
              key={session.sessionId}
              data-desk-ovr={session.overlordId ?? undefined}
              data-desk-sid={session.sessionId}
              className={[
                styles.desk,
                isSelected ? styles.deskSelected : '',
                isDragging ? styles.dragging : '',
                isDragOver ? styles.dragOver : '',
              ].filter(Boolean).join(' ')}
              draggable={true}
              onDragStart={() => setDraggedId(sessionOrderKey)}
              onDragOver={(e) => { e.preventDefault(); setDragOverId(sessionOrderKey); }}
              onDrop={(e) => { e.preventDefault(); handleDrop(sessionOrderKey); }}
              onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
            >
              <span className={styles.dragHandle} aria-hidden="true">⠿</span>
              <div className={styles.deskInfo}>
                <div className={styles.deskTimeLabel} title={lastActivityTooltip(session.lastActivity)}>
                  {lastActivityLabel(session.lastActivity)}
                </div>
                {(() => {
                  const launch = getLaunchInfo(session, isPtySession?.(session.overlordId ?? session.sessionId));
                  // Overlord-spawned is the default — no chip for it, only for other launch types.
                  const showLaunchBadge = launch.category !== 'pty';
                  if (!showLaunchBadge && session.provider !== 'codex' && session.provider !== 'opencode') return null;
                  return (
                    <div className={styles.deskLaunchRow}>
                      {showLaunchBadge && (
                        <span className={styles.deskLaunchBadge} data-category={launch.category}>{launch.name}</span>
                      )}
                      {session.provider === 'codex' && (
                        <span className={styles.deskLaunchBadge} data-category="codex">Codex</span>
                      )}
                      {session.provider === 'opencode' && (
                        <span className={styles.deskLaunchBadge} data-category="opencode">OpenCode</span>
                      )}
                    </div>
                  );
                })()}
              </div>
              {onDeleteSession && (
                <DeskMenu
                  onDelete={() => onDeleteSession(session.sessionId)}
                  onClone={onCloneSession && session.hasActivity ? () => onCloneSession(session.sessionId) : undefined}
                  onClear={session.state !== 'closed' ? () => {
                    fetch(`/api/sessions/${session.sessionId}/inject`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ text: '/clear\r' }),
                    }).then(r => {
                      setClearToast(r.ok ? 'sent' : 'error');
                    }).catch(() => setClearToast('error'));
                  } : undefined}
                  onClose={onCloseSession && session.state !== 'closed' ? () => onCloseSession(session.sessionId) : undefined}
                  onArchive={handleArchive ? () => handleArchive(session.sessionId) : undefined}
                />
              )}
              <WorkerGroup session={session} onSelectSession={onSelectSession} customName={customNames[session.sessionId]} onDeleteSession={onDeleteSession} onRename={onRenameSession} />
            </div>
          );
        })}
        {pendingSpawns?.map(p => (
          <SpawningDesk key={p.id} name={p.fullName} />
        ))}
      </div>}
      {!collapsed && archiveEntries.length > 0 && (
        <div className={styles.archiveFooter}>
          <button
            type="button"
            className={styles.archivePill}
            onClick={() => setArchiveExpanded(v => !v)}
            aria-expanded={archiveExpanded}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: archiveExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s' }}>
              <polyline points="2 3 5 6 8 3" />
            </svg>
            <span>Archive</span>
            <span className={styles.archiveCount}>{archiveEntries.length}</span>
          </button>
          {archiveExpanded && (
            <ul className={styles.archiveList}>
              {groupArchiveByTime(archiveEntries).flatMap(group => [
                <li key={`__group__${group.label}`} className={styles.archiveGroupLabel}>{group.label}</li>,
                ...group.entries.map(entry => {
                const avatarColor = entry.color ?? 'hsl(30, 75%, 55%)';
                const prLabel = entry.pullRequest ? `#${entry.pullRequest.number}` : null;
                const branchLabel = entry.gitBranch ?? null;
                return (
                  <li key={entry.sessionId} className={styles.archiveEntryRow}>
                    <button
                      type="button"
                      className={styles.archiveEntry}
                      onClick={() => onOpenArchive?.(entry)}
                      title={new Date(entry.archivedAt).toLocaleString()}
                    >
                      <ArchiveAvatar color={avatarColor} keyId={entry.sessionId} />
                      <div className={styles.archiveEntryBody}>
                        <div className={styles.archiveEntryTopRow}>
                          <span className={styles.archiveEntryName}>{entry.name}</span>
                          {(branchLabel || prLabel) && (
                            <span className={styles.archiveEntryBranch}>
                              {branchLabel && (
                                <span className={styles.archiveEntryBranchText}>
                                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0 }}>
                                    <circle cx="5" cy="4" r="1.6" />
                                    <circle cx="5" cy="12" r="1.6" />
                                    <circle cx="12" cy="8" r="1.6" />
                                    <path d="M5 5.6v4.8M6.5 12h2a2 2 0 0 0 2-2V9.6" strokeLinecap="round" />
                                  </svg>
                                  {branchLabel}
                                </span>
                              )}
                              {prLabel && (
                                <span className={styles.archiveEntryPr}>{prLabel}</span>
                              )}
                            </span>
                          )}
                          <span className={styles.archiveEntryTime}>
                            {formatArchiveEntryTime(entry.archivedAt)}
                          </span>
                          <ArchiveStatsTooltip sessionId={entry.sessionId} />
                        </div>
                        {entry.intent && (
                          <div className={styles.archiveEntryIntent}>{entry.intent}</div>
                        )}
                        {entry.lastMessage && (
                          <div className={styles.archiveEntryDesc}>{entry.lastMessage}</div>
                        )}
                        {entry.notes && (
                          <div className={styles.archiveEntryNotes}>{entry.notes}</div>
                        )}
                      </div>
                    </button>
                    {onDeleteArchive && (confirmDeleteArchiveId === entry.sessionId ? (
                      <span className={styles.archiveDeleteConfirm}>
                        <button
                          type="button"
                          className={styles.archiveDeleteConfirmBtn}
                          title="Delete permanently — cannot be undone"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteArchiveId(null);
                            onDeleteArchive(entry.sessionId);
                          }}
                        >✓</button>
                        <button
                          type="button"
                          className={styles.archiveDeleteCancelBtn}
                          title="Cancel"
                          onClick={(e) => { e.stopPropagation(); setConfirmDeleteArchiveId(null); }}
                        >✕</button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={styles.archiveDeleteBtn}
                        title="Delete archived session permanently"
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteArchiveId(entry.sessionId); }}
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2.5 4h11M6 4V2.7h4V4M5 4l.6 9a1 1 0 0 0 1 .95h2.8a1 1 0 0 0 1-.95L11 4M6.7 6.8v4.5M9.3 6.8v4.5" />
                        </svg>
                      </button>
                    ))}
                  </li>
                );
              })
              ])}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
