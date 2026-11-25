/* Leitfaden des Nutzers: wie er sortiert (nach Stimmung und Situation, nicht nach Genre) und was jede Playlist bedeutet.
   GUIDE geht bei jeder KI-Entscheidung mit; RULES werden beim Start einmal als Notizen zu den passenden Playlists abgelegt
   (Zuordnung über den Namen, auch bei leicht anderer Schreibweise). Bei Änderungen GUIDE_VERSION erhöhen. */
import { db, kv } from '../data/db'
import { getNotes, setNote } from './notes'

export const GUIDE_VERSION = 1

export const GUIDE = `SO SORTIERT DER NUTZER (hat Vorrang vor allen anderen Hinweisen):
Er sortiert nicht nach Genre, sondern nach Stimmung und Situation: In welchem Moment und in welcher Laune hört er die Playlist? Ein Song gehört dorthin, wessen Gefühl er trifft – egal welches Genre. Entscheidend ist oft der Unterton (fröhlich, neutral, leicht traurig, richtig traurig): Er trennt Playlists, die sich sonst ähneln.
Ordner:
- Chill („Jetzt aber mal entspannt“): alle sollen entspannen, unterscheiden sich in Ausgangslaune und Unterton. Vaper = atmosphärisch + leicht traurig, Kiffer = atmosphärisch + nicht traurig, Raucher = entspannter Rap + traurig. U can Chill and Smile = entspannt + glücklich; Die Ruhe selbst = entspannt bei leicht schlechter Laune (stabilisierend, oft ruhiger Indie).
- Traurig („Fuck man.“): leise und traurig (Indie/Pop) = Watch People in the rain.; traurig und seltsam-atmosphärisch, nachts = Wird schon wa?; komplett am Boden, harter emotionaler Rock = Leave me here.; traurig ohne Gesang = Take a Rest, man.
- Sonstiges („Misc AG“): passt in keinen Stimmungs-Ordner (Rap ohne Zuhause, sinnlich, Hyperpop, Kindheits-Tracks, EDM, Filmmusik …).
- Gute Laune („It was a good day“, Tage über 5/10): Rap mit guter Laune = Mainy Musik; Pop/Indie mit guter Laune = Bessere Radio; Indie mit Landschafts-/Fahrrad-Gefühl = Downtown Shi; Indie zum Aufstehen = Morgendlicher Sonnenuntergang; Party = Homeclubbing; Vorfreude = Es Passiert; krasser Rock = Stein-Schienen; Indie-Rock = Mini-Rock.
- Nacht („Mach ma mal lange Nacht“): hart und laut = Ouh shiiiii; düster und nachdenklich = ouhhh shit..; schwebend und natürlich = Night Drive; schwebend und elektronisch = Electric and magic; Retro-Synthesizer = Neon-City; gute Laune abends in der Stadt = Mainy Musik (Night edition) (am Tag: Mainy Musik); ruhiges Nachdenken nach einem großen Ereignis = After-Mood.
- Dazu drei eigene Radiosender (Entspannung, Tages-Vibes, Nacht), wie ein besseres Radio: nur Songs, die genau zum Gedanken des Senders passen und nicht davon abdriften.`

/** Regel je Playlist (Name wie vom Nutzer genannt). */
export const RULES: Record<string, string> = {
  'U can Chill and Smile': 'Tage, an denen alles nett ist, aber nichts Spannendes passiert: glücklich und entspannt, die Songs sollen mich genau so halten. Genre egal, Hauptsache entspannt und positiv.',
  'Die Ruhe selbst': 'Wie U can Chill and Smile, aber für Tage, an denen etwas Mist passiert ist und die Laune leicht unter dem Durchschnitt liegt. Songs sollen nicht runterziehen, sondern stabil halten („geht schlimmer, aber alles gut“). Meist ruhiger Indie oder sonst Entspanntes.',
  '(Nicht-)Vaper Playli': 'Auf einer Party etwas abseits sitzen und entspannen. Sehr atmosphärisch, jedes Genre, extrem gemütlich – mit leicht traurigem Unterton. Beispiele: Virginia Beach, 30 for 30, always have a choice, Latitude (Remix), All Mine. Abgrenzung: Kiffer = gleich, aber ohne Traurigkeit; Raucher = Rap und trauriger.',
  '(Nicht-)Raucher Playli': 'Extrem entspannt sein und nicht raus wollen. Entspannter Rap mit sanften, angenehmen Beats; Unterton trauriger und etwas weniger chillig als bei Vaper. Beispiele: 4422, Went West Mrs Magic, 327, Mamas favourite, (Luv)sic Pt. 3, 93 \'til Infinity.',
  '(Nicht-)Kiffer Playli': 'Wie die Vaper Playli, aber ohne traurigen Unterton: atmosphärisch, gemütlich, rein positiv. Beispiele: The Color Violet, Vámonos, say something (Lil Yachty), Good Days (SZA).',
  'Damn Sweet': 'Alles, was mich süß und cutesy fühlen lässt: oft japanisch angehauchte Melodien, leicht und völlig unbeschwert. Beispiele: NOT CUTE ANYMORE, Just a Dream, dumb feeling, how to pretend.',
  'Flawed Moments': 'Songs von Flawed Mangoes und andere Songs, die genau seinen Vibe haben.',
  'Relaxde Mainy Music': 'Entspannte Musik mit Rap und R&B, sehr genreübergreifend. Noch eine Baustelle. Abgrenzung: Mainy Musik ist energiegeladen und gute Laune, diese hier entspannt.',
  'Wird schon wa?': 'Traurig, aber zu atmosphärisch für eine normale Trauer-Playlist: die seltsame Seite der Traurigkeit, interessantere Stimmung, oft nachts. Beispiele: A COLD PLAY (The Kid LAROI), Bed (The Neighbourhood), 777 cypher (MUj).',
  'Watch People in the rain.': 'Ohne Regenschirm im Regen sitzen, Leute beobachten und sich überlegen, wie sie ihr Leben leben, während ich einfach da bin. Trauriger Indie und Pop, leise und traurig.',
  'Take a Rest, man.': 'Nur Songs ohne Gesang, extrem beruhigend: wirklich traurig, 3 Uhr nachts, ich brauche eine Pause und sollte schlafen. Beispiele: (dream) von salvia path, Star Shopping von Megami.',
  'Leave me here.': 'Die Endstufe, nur wenn wirklich etwas Furchtbares passiert ist: Radiohead und viele harte, laute, emotionale Rock-Lieder.',
  'Lock ma in': 'Rap, bei dem ich nicht weiß, wohin damit; vieles klingt ähnlich. Auffang-Playlist – nur wählen, wenn der Rap in keine Stimmungs-Playlist passt.',
  'Sensual Shi': 'Sinnliche Musik, zum Beispiel The Weeknd.',
  'G(o)od-Stuff': 'Momente, in denen ich mich richtig geil und krass fühle.',
  'Hyperpoppen': 'Durchgedrehte Musik mit Dubstep- und Hyperpop-Beats, gesungen von Anime-Mädchenstimmen.',
  'Bro, dreh das ab digga.': 'Tracks, die sonst niemand mit mir hören würde, meist aus meiner Kindheit: z. B. Bad Piggies Theme, Subway Surfers, Runaway (U & I), Legends Never Die.',
  'ErsteDeutscheMühle': 'EDM – aber nur das, was ich wirklich geil finde.',
  'Cinema': 'Richtig gute Filmsoundtracks, z. B. aus Oppenheimer oder Can You Hear the Music.',
  'Morgendlicher Sonnenuntergang': 'Aufsteh-Playlist für Motivation: gemütlicher Indie oder Pop mit Vibes, bei denen ich nicht liegen bleiben, sondern den Tag starten will. Passt auch zum Sonnenuntergang im Frühling und Sommer.',
  'Es Passiert': 'Pure Vorfreude: Heute Abend passiert endlich etwas, die Musik macht mich noch glücklicher und aufgedrehter. Beispiele: All Good Things (Come to an End), We Are the People, Fall for You (Hot Since 82 Remix).',
  'Homeclubbing': 'Party-Songs für die Homeparty: Katy Perry, typische Party-Pop-Hits, aber auch Songs, die einfach ballern.',
  'Bessere Radio': 'Mein Gute-Laune-Radiosender für den Tag: alles, was ich in so einem Radio spielen würde, aber nur gute Songs. Keine traurigen, keine zu entspannten. Hauptsächlich Pop und Indie.',
  'Mainy Musik': 'Meine spirituelle Tagesbewegung: geiler Vibe, geiles Gefühl, geile Musik. Viel Jay-Z, Rap allgemein, gute Kanye-West-Songs – Tracks, die mich bewegen und in geiler Laune halten. Beispiele: Nowhere to Go, 24K Magic, Firefly, Champions. Abends in der Stadt: Mainy Musik (Night edition).',
  'Downtown Shi': 'Mit dem Fahrrad einen Hügel runterfahren, am Ende ein Dorf mit Bergen rundherum: Indie, der in guten Momenten richtig trifft, atmosphärisch gut, aber nicht so energiegeladen wie Mainy Musik. Beispiele: Wir sind Helden, Smalltown Boy, When Am I Gonna Lose You, This Is the Life, Running Up That Hill, Wonderwall.',
  'Atmospherischer Zeitpunkt': '„Dreamcore Pop“ – fast nur Empire of the Sun und Songs mit genau diesem Klang.',
  'Stein-Schienen': 'Rock-Songs, und zwar richtig krasse.',
  'Mini-Rock': 'Wie Stein-Schienen, nur Indie-Rock. Beispiele: Lisztomania, Westcoast Collective, SS26, The Adults Are Talking.',
  'Night Drive': 'Unter dem Sternenhimmel im Cabrio oder auf einer Schaukel im Mondschein: sehr atmosphärisch und schwebend, natürlich (nicht elektronisch-magisch). Beispiele: Midnight Life, Astrothunder, Softcore, Under Your Spell, The Ride / I Really Want to Stay at Your House, Camaleón (Joalin).',
  'Neon-City': 'Alt-moderne Synthesizer-Songs: nachts mit dem Auto durch Japan, überall blaue Neonlichter. Darf auch härter und schneller sein, solange der Vibe stimmt. Beispiele: Memory Reboot, The Scarlet Empress, Simpsonwave, U Weren\'t Really Here I Miss U.',
  'After-Mood': 'Ein großes Ereignis ist vorbei und ich denke in Ruhe und schweigend daran zurück: leicht nostalgisch, angenehm, atmosphärisch. Bisher: Midnight (Coldplay), Wait (M83), Holocene (Bon Iver).',
  'Ouh shiiiii': 'Raus in die Nacht und der Song geht unglaublich hart: krasse Beats, schnellerer Rap, verzerrtes Autotune, nur noch mitviben. Gegenteil: ouhhh shit.. (düster, nachdenklich).',
  'ouhhh shit..': 'Nächtliche Vibes, aber traurig: nicht zum Weinen, sondern zum Nachdenken und Overthinken. Düster, leicht traurig, nicht gothic. Beispiele: 444 (Larkin), cheap (Sainté), all my friends (21 Savage).',
  'Electric and magic': 'Hauptsächlich Charli XCX: schwebend, elektronisch, magisch. Existiert, damit solche Songs nicht Night Drive verseuchen.',
  'Mainy Musik (Night edition)': 'Abends im frischen Outfit durch die Stadt laufen und mich geil fühlen: geile Beats, atmosphärisch, gute Laune. Beispiele: Relock (Lil Dreezy), Skeletons (Travis Scott), Should I B (Lil Yachty), Enough for Me (GRAHAM), Noble (F3miii adhd), the party.',
}

/** Namen vergleichbar machen: klein, nur Buchstaben/Ziffern, doppelte Buchstaben zusammen, „music“ = „musik“. */
export const norm = (s: string) => s.toLowerCase().replace(/music/g, 'musik').replace(/[^a-z0-9äöüß]/g, '').replace(/(.)\1+/g, '$1')

/** Zu einem Playlist-Namen die passende Regel: erst exakt (normalisiert), sonst eindeutiger Anfang (z. B. „Sensual Shi“ ↔ „Sensual-Shit“). */
export function ruleFor(name: string) {
  const n = norm(name), keys = Object.keys(RULES)
  const exact = keys.find(k => norm(k) === n)
  if (exact) return exact
  const pre = keys.filter(k => { const m = norm(k); return Math.min(m.length, n.length) >= 6 && (m.startsWith(n) || n.startsWith(m)) })
  return pre.length === 1 ? pre[0] : undefined
}

/** Einmal je Version: Regeln als Notizen ablegen. Eigene Notizen (aus dem Jarvis-Chat) bleiben als Ergänzung erhalten. */
export async function seedGuide() {
  if ((await kv.get<number>('guideV')) === GUIDE_VERSION) return
  const pls = (await (await db).getAll('playlists')).filter(p => p.ownedByMe || p.collaborative)
  if (!pls.length) return   // noch nicht eingelesen: beim nächsten Start
  const notes = await getNotes(), used = new Set<string>()
  for (const p of pls) {
    const k = ruleFor(p.name)
    if (!k || used.has(k)) continue
    used.add(k)
    const old = notes[p.id]
    if (!old?.includes(RULES[k])) await setNote(p.id, old ? `${RULES[k]}\nErgänzung: ${old}` : RULES[k])
  }
  await kv.set('guideSeed', { at: Date.now(), missing: Object.keys(RULES).filter(k => !used.has(k)) })
  await kv.set('guideV', GUIDE_VERSION)
}

// Selbsttest (nur im Entwicklungsmodus): Schreibweisen aus Spotify finden ihre Regel
if (import.meta.env.DEV) {
  const t: [string, string | undefined][] = [['Relaxde Mainy-Musik', 'Relaxde Mainy Music'], ['Mainy-Musik (Night-Edition)', 'Mainy Musik (Night edition)'], ['Mainy-Musik', 'Mainy Musik'],
    ['Ouh Shiiii', 'Ouh shiiiii'], ['ouhhh shit..', 'ouhhh shit..'], ['Sensual-Shit', 'Sensual Shi'], ['electric and magic', 'Electric and magic'], ['RandomShiiiish', undefined]]
  for (const [name, want] of t) console.assert(ruleFor(name) === want, 'ruleFor', name, ruleFor(name))
}
