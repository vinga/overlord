import type { Room, SessionProvider, TerminalSpawnMode } from '../types';
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

/** Quick spawn replays only real session modes; older room-config files may still hold raw/note. */
export function isSessionMode(mode: TerminalSpawnMode | undefined): mode is TerminalSpawnMode {
  return !!mode && mode !== 'raw' && mode !== 'note';
}

/** A random name from the pool that no session in the room uses yet. */
export function pickSessionName(room: Room, customNames: Record<string, string>, prefix = '', separator = '+'): string {
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

export interface QuickSpawnChoice {
  prefix: string;
  mode: TerminalSpawnMode;
  provider: SessionProvider;
}

/** What quick spawn uses in a room: the name prefix and the last mode / provider
 *  from room-config, written back so the next quick spawn repeats them. `fallback`
 *  stands in when room-config can't be read. */
export async function resolveQuickSpawn(cwd: string, fallback: QuickSpawnChoice): Promise<QuickSpawnChoice> {
  let { prefix, mode, provider } = fallback;
  try {
    const r = await fetch(`/api/room-config?cwd=${encodeURIComponent(cwd)}`);
    if (r.ok) {
      const cfg = await r.json() as { prefix?: string; lastMode?: TerminalSpawnMode; lastProvider?: SessionProvider };
      prefix = ROOM_PREFIX_ENABLED ? (cfg.prefix ?? '') : '';
      if (isSessionMode(cfg.lastMode)) mode = cfg.lastMode;
      provider = cfg.lastProvider === 'opencode' || cfg.lastProvider === 'codex' ? cfg.lastProvider : 'claude';
    }
  } catch { /* fall back to cached values */ }
  if (provider === 'opencode' || provider === 'codex') mode = 'embedded';
  fetch('/api/room-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, lastMode: mode, lastProvider: provider }),
  }).catch(() => {});
  return { prefix, mode, provider };
}
