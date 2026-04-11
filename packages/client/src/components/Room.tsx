import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import type { Room as RoomType, Session, TerminalSpawnMode } from '../types';
import { getLaunchInfo } from '../types';
import { WorkerGroup } from './WorkerGroup';
import { SessionCommands } from './SessionCommands';
import styles from './Room.module.css';
import dialogStyles from './DirectoryPickerDialog.module.css';
import { useRoomOrder } from '../hooks/useRoomOrder';
import { useRoomCollapsed } from '../hooks/useRoomCollapsed';

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

function lastActivityLabel(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '<1m';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  return `${diffHour}h`;
}

function InfoTooltip({ text }: { text: string }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  return (
    <span
      ref={ref}
      onMouseEnter={e => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.top - 8 });
        setVisible(true);
      }}
      onMouseLeave={() => setVisible(false)}
      style={{ display: 'inline-flex', alignItems: 'center', cursor: 'default', color: 'rgba(255,255,255,0.25)', flexShrink: 0 }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4"/>
        <text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="9" fontFamily="Inter,system-ui,sans-serif" fontWeight="600">i</text>
      </svg>
      {visible && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', left: pos.x, top: pos.y, transform: 'translate(-50%, -100%)',
          background: '#1e1e2e', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 7, padding: '8px 12px', maxWidth: 260,
          fontFamily: "'Inter',system-ui,sans-serif", fontSize: 12, lineHeight: 1.5,
          color: 'rgba(255,255,255,0.75)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          zIndex: 9999, pointerEvents: 'none',
        }}>{text}</div>,
        document.body
      )}
    </span>
  );
}

function CopyBtn({ text, onAfterCopy }: { text: string; onAfterCopy?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        onAfterCopy?.();
      }}
      title="Copy"
      style={{ flexShrink: 0, background: 'none', border: 'none', color: copied ? '#22c55e' : 'rgba(255,255,255,0.35)', cursor: 'pointer', padding: '2px 4px', borderRadius: 3, display: 'flex', alignItems: 'center', transition: 'color 0.15s' }}
    >
      {copied
        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      }
    </button>
  );
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

function RoomSpawnDialog({ cwd, initialName, onSpawn, onCancel, onCopyAndClose }: {
  cwd: string;
  initialName: string;
  onSpawn: (name: string, mode: TerminalSpawnMode) => void;
  onCancel: () => void;
  onCopyAndClose?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [mode, setMode] = useState<TerminalSpawnMode>('embedded');
  const [bridgePath, setBridgePath] = useState<string>('overlord-bridge');
  const nameRef = useRef<HTMLInputElement>(null);
  const markerRef = useRef(Math.random().toString(36).slice(2, 10));

  useEffect(() => {
    setTimeout(() => { nameRef.current?.focus(); nameRef.current?.select(); }, 50);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  useEffect(() => {
    fetch('/api/info')
      .then(r => r.json())
      .then((info: { bridgePath?: string }) => { if (info.bridgePath) setBridgePath(info.bridgePath); })
      .catch(() => {});
  }, []);

  const safeName = name.trim().replace(/["\s]/g, '-');
  const marker = markerRef.current;
  const commands: Record<TerminalSpawnMode, string | null> = {
    embedded: null,
    bridge: `cd "${cwd}" && "${bridgePath}" --pipe overlord-${marker} -- claude --name ${safeName}___BRG:${marker}`,
    plain: `cd "${cwd}" && claude --name "${name.trim()}"`,
  };

  const modeRows: { key: TerminalSpawnMode; label: string; tooltip: string }[] = [
    { key: 'embedded', label: 'Overlord', tooltip: 'Spawns a PTY session managed entirely inside Overlord. No terminal window needed — inject messages, view output, and monitor state directly from the UI.' },
    { key: 'bridge',   label: 'Bridge',   tooltip: 'Opens Terminal.app with a named-pipe relay. Overlord can inject messages and track the session while you keep full terminal control.' },
    { key: 'plain',    label: 'Direct',   tooltip: 'Opens Terminal.app running claude directly. No relay — Overlord monitors via session files only. Use when bridge is not needed.' },
  ];

  return ReactDOM.createPortal(
    <div className={dialogStyles.backdrop} onClick={onCancel}>
      <div className={dialogStyles.dialog} onClick={e => e.stopPropagation()}>
        <div className={dialogStyles.header}>
          <h2 className={dialogStyles.title}>New Session</h2>
          <button className={dialogStyles.closeBtn} onClick={onCancel}>×</button>
        </div>

        {/* Fixed path */}
        <div style={{ padding: '10px 20px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.25)', marginBottom: 6 }}>Directory</div>
          <div style={{ fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: 12, color: 'rgba(255,255,255,0.45)', background: '#0a0a14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '7px 12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cwd}</div>
        </div>

        {/* Name row */}
        <div className={dialogStyles.config} style={{ paddingBottom: 0 }}>
          <div className={dialogStyles.configRow}>
            <label className={dialogStyles.label}>Name</label>
            <input
              ref={nameRef}
              className={dialogStyles.nameInput}
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onSpawn(name.trim(), mode); }}
              placeholder="Session name…"
              spellCheck={false}
            />
          </div>
        </div>

        {/* Mode rows — each with optional command inline */}
        <div style={{ padding: '10px 20px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {modeRows.map(({ key, label, tooltip }) => {
            const cmd = commands[key];
            const active = mode === key;
            return (
              <div
                key={key}
                onClick={() => setMode(key)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  background: active ? 'rgba(255,255,255,0.05)' : 'transparent',
                  border: '1px solid transparent',
                  borderLeft: active ? '2px solid rgba(212,175,55,0.6)' : '2px solid transparent',
                  borderRadius: 6, padding: '7px 10px', cursor: 'pointer',
                  transition: 'all 0.12s',
                }}
              >
                {/* Mode label + info tooltip */}
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, width: 72, alignSelf: 'center' }}>
                  <span style={{
                    fontFamily: "'Inter',system-ui,sans-serif", fontSize: 11, fontWeight: 600,
                    color: active ? '#d4af37' : 'rgba(255,255,255,0.3)',
                    transition: 'color 0.12s',
                  }}>{label}</span>
                  <InfoTooltip text={tooltip} />
                </span>

                {/* Command or description */}
                {cmd && name.trim() ? (
                  <>
                    <code style={{ flex: 1, fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: 10, color: active ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.3)', wordBreak: 'break-all', lineHeight: 1.5, minWidth: 0 }}>{cmd}</code>
                    <CopyBtn text={cmd} onAfterCopy={() => { onCancel(); onCopyAndClose?.(); }} />
                  </>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className={dialogStyles.actions}>
          <button className={dialogStyles.cancelBtn} onClick={onCancel}>Cancel</button>
          <button
            className={dialogStyles.spawnBtn}
            onClick={() => name.trim() && onSpawn(name.trim(), mode)}
            disabled={!name.trim()}
          >Spawn</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

interface RoomProps {
  room: RoomType;

  onSelectSession: (session: Session, subagentId?: string) => void;
  customNames: Record<string, string>;
  onSpawnSession?: (cwd: string) => void;
  onSpawnDirect?: (cwd: string, name: string, mode: TerminalSpawnMode) => void;
  selectedSessionId?: string | null;
  onRoomClick?: (roomId: string) => void;
  isSpawning?: boolean;
  onSpawnNameChange?: (name: string) => void;
  onSpawnCommit?: (name: string | null) => void;
  onDeleteSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  onCloneSession?: (sessionId: string) => void;
  onNewTerminalSession?: (cwd: string, mode?: TerminalSpawnMode) => void;
  terminalSpawnCwd?: string | null;
  onTerminalSpawnCommit?: (name: string | null) => void;
  isPtySession?: (sessionId: string) => boolean;
  platform?: string;
  onRoomDragStart?: (e: React.DragEvent) => void;
  onRoomDragEnd?: () => void;
}

function DeskMenu({ onDelete, onRename, onClone, onClear, currentName }: { onDelete: () => void; onRename?: (name: string) => void; onClone?: () => void; onClear?: () => void; currentName?: string }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameVal, setNameVal] = useState('');
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setRenaming(false); }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'absolute', top: 4, right: 4, zIndex: 10 }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); setRenaming(false); }}
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
          {renaming ? (
            <div style={{ padding: '4px 8px' }}>
              <input
                autoFocus
                value={nameVal}
                onChange={(e) => setNameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nameVal.trim()) { onRename?.(nameVal.trim()); setOpen(false); setRenaming(false); }
                  if (e.key === 'Escape') { setRenaming(false); }
                }}
                style={{
                  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 4, color: '#fff', padding: '4px 8px', fontSize: 12, width: '100%',
                  outline: 'none', fontFamily: 'Inter, system-ui, sans-serif',
                }}
                placeholder="New name…"
              />
            </div>
          ) : (
            <>
              {onRename && (
                <button
                  onClick={() => { setNameVal(currentName ?? ''); setRenaming(true); }}
                  style={{
                    display: 'block', width: '100%', padding: '8px 14px',
                    background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                    fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
                >Rename</button>
              )}
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
            </>
          )}
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

export function Room({ room, onSelectSession, customNames, onSpawnSession, onSpawnDirect, selectedSessionId, onRoomClick, isSpawning, onSpawnNameChange, onSpawnCommit, onDeleteSession, onRenameSession, onCloneSession, onNewTerminalSession, terminalSpawnCwd, onTerminalSpawnCommit, isPtySession, platform = 'darwin', onRoomDragStart, onRoomDragEnd }: RoomProps) {
  const [, setTick] = useState(0);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [spawnName, setSpawnName] = useState('');
  const [terminalSpawnName, setTerminalSpawnName] = useState('');
  const [terminalMode, setTerminalMode] = useState<TerminalSpawnMode>('bridge');
  const [showSpawnPanel, setShowSpawnPanel] = useState(false);
  const [spawnPanelName, setSpawnPanelName] = useState('');
  const [showCopyToast, setShowCopyToast] = useState(false);
  const [clearToast, setClearToast] = useState<'sent' | 'error' | null>(null);
  const { getOrder, setOrder } = useRoomOrder();
  const { isCollapsed, toggle } = useRoomCollapsed();
  const collapsed = isCollapsed(room.id);

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

  const idlePriority = (s: Session) => {
    if (s.state !== 'closed') return 0;
    const mins = (Date.now() - new Date(s.lastActivity).getTime()) / 60000;
    if (mins > 15) return 2;
    if (mins > 5) return 1;
    return 0;
  };

  // Build sorted sessions list respecting custom order
  const allSessions = room.sessions;

  const storedOrder = getOrder(roomKey);

  let sortedSessions: Session[];
  if (storedOrder.length > 0) {
    const orderedMap = new Map(storedOrder.map((id, idx) => [id, idx]));
    const inOrder = allSessions
      .filter(s => orderedMap.has(s.sessionId))
      .sort((a, b) => (orderedMap.get(a.sessionId) ?? 0) - (orderedMap.get(b.sessionId) ?? 0));
    const notInOrder = allSessions
      .filter(s => !orderedMap.has(s.sessionId))
      .sort((a, b) => idlePriority(a) - idlePriority(b));
    sortedSessions = [...inOrder, ...notInOrder];
  } else {
    sortedSessions = [...allSessions].sort((a, b) => idlePriority(a) - idlePriority(b));
  }

  const handleDrop = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    const currentOrder = sortedSessions.map(s => s.sessionId);
    const fromIdx = currentOrder.indexOf(draggedId);
    const toIdx = currentOrder.indexOf(targetId);
    const newOrder = [...currentOrder];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, draggedId);
    setOrder(roomKey, newOrder);
    setDraggedId(null);
    setDragOverId(null);
  };

  // Compute state counts for collapsed summary
  const stateCounts = room.sessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.state] = (acc[s.state] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className={`${styles.room} ${collapsed ? styles.roomCollapsed : ''}`}>
      <div className={styles.titleBar}>
        {onRoomDragStart && (
          <div
            className={styles.dragHandle}
            draggable
            onDragStart={onRoomDragStart}
            onDragEnd={onRoomDragEnd}
            title="Drag to reorder room"
          >
            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/>
              <circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/>
              <circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/>
            </svg>
          </div>
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
        {onSpawnDirect && (
          <button
            className={styles.spawnButton}
            onClick={(e) => {
              e.stopPropagation();
              const name = getNextName('');
              setSpawnPanelName(name);
              setShowSpawnPanel(p => !p);
            }}
            title={`New session in ${room.cwd}`}
            aria-label="New session"
          >+</button>
        )}
      </div>
      {showSpawnPanel && onSpawnDirect && (
        <RoomSpawnDialog
          cwd={room.cwd}
          initialName={spawnPanelName}
          onSpawn={(name, mode) => {
            onSpawnDirect(room.cwd, name, mode);
            setShowSpawnPanel(false);
          }}
          onCancel={() => setShowSpawnPanel(false)}
          onCopyAndClose={() => setShowCopyToast(true)}
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
          const isSelected = session.sessionId === selectedSessionId;
          const isDragging = draggedId === session.sessionId;
          const isDragOver = dragOverId === session.sessionId && draggedId !== session.sessionId;
          return (
            <div
              key={session.sessionId}
              className={[
                styles.desk,
                isSelected ? styles.deskSelected : '',
                isDragging ? styles.dragging : '',
                isDragOver ? styles.dragOver : '',
              ].filter(Boolean).join(' ')}
              draggable={true}
              onDragStart={() => setDraggedId(session.sessionId)}
              onDragOver={(e) => { e.preventDefault(); setDragOverId(session.sessionId); }}
              onDrop={(e) => { e.preventDefault(); handleDrop(session.sessionId); }}
              onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
            >
              <span className={styles.dragHandle} aria-hidden="true">⠿</span>
              <div className={styles.deskInfo}>
                <div className={styles.deskTimeLabel}>{lastActivityLabel(session.lastActivity)}</div>
                {(() => {
                  const launch = getLaunchInfo(session, isPtySession?.(session.sessionId));
                  return (
                    <div className={styles.deskLaunchRow}>
                      <span className={styles.deskLaunchBadge} data-category={launch.category}>{launch.name}</span>
                    </div>
                  );
                })()}
              </div>
              {onDeleteSession && (
                <DeskMenu
                  onDelete={() => onDeleteSession(session.sessionId)}
                  onRename={onRenameSession ? (name) => onRenameSession(session.sessionId, name) : undefined}
                  onClone={onCloneSession && session.activityFeed && session.activityFeed.length > 0 ? () => onCloneSession(session.sessionId) : undefined}
                  onClear={session.state !== 'closed' ? () => {
                    fetch(`/api/sessions/${session.sessionId}/inject`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ text: '/clear\r' }),
                    }).then(r => {
                      setClearToast(r.ok ? 'sent' : 'error');
                    }).catch(() => setClearToast('error'));
                  } : undefined}
                  currentName={customNames[session.sessionId] ?? session.proposedName ?? session.sessionId.slice(0, 8)}
                />
              )}
              <WorkerGroup session={session} onSelectSession={onSelectSession} customName={customNames[session.sessionId]} onDeleteSession={onDeleteSession} onRename={onRenameSession} />
            </div>
          );
        })}
      </div>}
    </div>
  );
}
