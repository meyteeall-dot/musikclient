// Shader 1:1 aus Druckpunkt (Liquid Glass). Hintergrund-Farbwelten + Linse mit Brechung, Dispersion, Lichtring.
export const GL_FULL_VS = `#version 300 es
void main(){ vec2 v = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(v * 2. - 1., 0., 1.); }`;

export const GL_BG_FS = `#version 300 es
precision highp float;
uniform vec2 uRes, uPar; uniform float uT, uHot, uTF; uniform int uTA, uTB; uniform vec3 uGlow;
out vec4 o;
float lay(vec2 b, vec2 c, vec2 r){ vec2 d = (b - c) / r; return exp(-dot(d, d) * 2.); }
// kantengeglättete Formen: d < 0 ist innen; Breite der Glättung = ein Bildpunkt
float fill(float d){ float w = fwidth(d) * .75 + 1e-5; return 1. - smoothstep(-w, w, d); }
float line(float d, float th){ return fill(abs(d) - th); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// 0 Farbe: weiche Farbwolken
vec3 tColor(vec2 uv, vec2 b){
  vec3 col = mix(vec3(.05,.10,.32), vec3(.01,.03,.12), smoothstep(0., 1., uv.y));
  col = mix(col, vec3(.10,.45,1.),  .90 * lay(b, vec2(.12,.10), vec2(.60,.32)));
  col = mix(col, vec3(.58,.28,1.),  .75 * lay(b, vec2(.95,.32), vec2(.45,.38)));
  col = mix(col, vec3(.08,.85,.95), .70 * lay(b, vec2(.05,.70), vec2(.42,.30)));
  col = mix(col, vec3(1.,.52,.16),  .85 * lay(b, vec2(.88,.90), vec2(.55,.32)));
  col = mix(col, vec3(1.,.80,.35),  .45 * lay(b, vec2(.40,.55), vec2(.30,.18)));
  return col * (1. + .14 * sin(b.x * 7. + b.y * 4. + uT * .15));
}
// 1 Schwarz-Weiß: Schwarz mit weißen Flächen und Bändern, scharfe Kanten für Regenbogensäume im Glas
vec3 tBW(vec2 uv, vec2 b){
  float m = mix(.035, .07, smoothstep(0., 1., uv.y));
  m = mix(m, .92, smoothstep(.56, .5, length((b - vec2(.08, .1)) / vec2(.42, .26))));
  m = mix(m, .85, smoothstep(.56, .5, length((b - vec2(1., .9)) / vec2(.5, .3))));
  m = mix(m, .55, smoothstep(.56, .5, length((b - vec2(.95, .38)) / vec2(.2, .14))));
  float st = fract(b.x * 1.6 - b.y * 1.1 + .35);
  m = mix(m, .9, smoothstep(0., .012, st) * (1. - smoothstep(.05, .062, st)));
  return vec3(m);
}
// 2 Porzellan: gedämpftes Elfenbein, kräftig hellblaue Malerei nur an den Rändern, damit die Mitte ruhig bleibt:
//   großer Teller unten links angeschnitten (Rosette, Blattkranz, Zackenborte), Blütenzweig am rechten Rand
vec3 tPorcelain(vec2 uv, vec2 b){
  float asp = uRes.x / uRes.y;
  vec2 p = vec2(b.x * asp, b.y);
  vec3 col = mix(vec3(.9, .895, .875), vec3(.83, .838, .845), smoothstep(0., 1., uv.y));
  col *= 1. - .13 * smoothstep(.3, .85, length((uv - vec2(.5, .45)) * vec2(1., .75)));
  vec3 cob = vec3(.1, .4, .92), wash = vec3(.6, .75, .98);
  float ink = 0., wsh = 0.;
  // Teller: gleiche Malerei wie zuvor, aber 1,25-fach und in die Ecke gerückt
  vec2 d = (p - vec2(-.12, 1.1)) / 1.1; float r = length(d), an = atan(d.y, d.x);
  float pr = .1 * (.5 + .5 * pow(abs(cos(an * 4.)), .7));
  wsh = max(wsh, fill(r - pr)); ink = max(ink, line(r - pr, .0018));
  ink = max(ink, line(r - .135, .0022));
  float sa = mod(an + .3927, .7854) - .3927;
  float leaf = length(vec2(r - .175, sa * r) * vec2(1., 2.3)) - .03;
  wsh = max(wsh, fill(leaf)); ink = max(ink, line(leaf, .0015));
  float outer = .272 + .014 * cos(an * 20.);
  float band = fill(max(.243 - r, r - outer));
  float dt = length(vec2(r - .257, (fract(an * 20. / 6.2832 + .5) - .5) * 6.2832 / 20. * r)) - .0062;
  ink = max(ink, band * (1. - fill(dt)));
  ink = max(ink, line(r - .302, .0016));
  // Blütenzweig am rechten Rand: geschwungene Ranke mit drei Blüten und Blättern
  float yv = clamp((p.y - .64) / .26, 0., 1.);
  float vx = asp + .01 - .07 * sin(yv * 3.1416) - .03 * yv;              // Ranke als Kurve x(y)
  float onv = step(.64, p.y) * step(p.y, .9);
  ink = max(ink, line(p.x - vx, .0022) * onv);
  for (int k = 0; k < 3; k++){
    float fk = float(k), ty = .68 + fk * .085;
    vec2 c = vec2(asp + .01 - .07 * sin((ty - .64) / .26 * 3.1416) - .03 * (ty - .64) / .26 - .035 + fk * .012, ty);
    vec2 q = p - c; float fr = length(q), fa = atan(q.y, q.x);
    float flower = fr - .026 * (.62 + .38 * cos(fa * 5. + fk));
    wsh = max(wsh, fill(flower)); ink = max(ink, max(line(flower, .0016), fill(fr - .006)));
    vec2 lq = q - vec2(.03, -.02); lq = mat2(.8, .6, -.6, .8) * lq;     // Blatt neben jeder Blüte
    float lf = length(lq * vec2(1., 2.2)) - .016;
    wsh = max(wsh, fill(lf)); ink = max(ink, line(lf, .0013));
  }
  col = mix(col, wash, wsh * .75);
  col = mix(col, cob, clamp(ink, 0., 1.));
  col += .03 * lay(uv, vec2(.25, .15), vec2(.35, .2));                    // Glanz der Glasur
  return col;
}
// 3 Tiefsee: dunkles Petrol, wandernde Lichtnetze (Kaustiken) und Lichtstrahlen von oben
vec3 tSea(vec2 uv, vec2 b){
  // Lichtnetz nach dem bekannten kachelbaren Wasser-Shader: stabil nur in diesem Koordinatenbereich
  float asp = uRes.x / uRes.y; vec2 p = mod(vec2(b.x * asp, b.y) * 6.2832 * 1.4, 6.2832) - 250.;
  vec3 col = mix(vec3(.0, .16, .22), vec3(.0, .02, .05), smoothstep(0., 1., uv.y));
  float t = uT * .35, c = 1.; vec2 i = p;
  for (int n = 0; n < 4; n++){
    float tt = t * (1. - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1. / length(vec2(p.x / (sin(i.x + tt) / .005), p.y / (cos(i.y + tt) / .005)));
  }
  c = 1.17 - pow(c / 4., 1.4);
  col += vec3(.25, 1., .92) * clamp(pow(abs(c), 8.), 0., 1.) * (.85 - uv.y * .55);
  float ray = pow(max(0., sin(b.x * 11. + uT * .04) * sin(b.x * 5.3 - uT * .03 + 1.7)), 4.);
  return col + vec3(.15, .6, .6) * ray * (1. - uv.y) * .35;
}
// 4 Sonnenuntergang: Violett über Pink zu Orange, Retro-Sonne mit Streifen, Wolkenschleier
vec3 tSunset(vec2 uv, vec2 b){
  float asp = uRes.x / uRes.y, y = b.y;
  vec3 col = mix(vec3(.2, .06, .4), vec3(.9, .28, .52), smoothstep(0., .55, y));
  col = mix(col, vec3(1., .55, .22), smoothstep(.45, .8, y));
  col = mix(col, vec3(1., .8, .42), smoothstep(.78, 1., y));
  float r = length((b - vec2(.6, .66)) * vec2(asp, 1.));
  col += vec3(1., .55, .3) * exp(-r * 6.) * .45;
  float cut = step(.66, y) * line(fract((y - .66) * 18.) - .5, min(.45, (y - .66) * 3.5));
  col = mix(col, vec3(1., .9, .55), fill(r - .12) * (1. - cut));
  for (int k = 0; k < 3; k++){
    float fk = float(k), yc = .36 + fk * .11 + .02 * sin(b.x * 5. + fk * 2. + uT * .08);
    col = mix(col, mix(vec3(.55, .16, .45), vec3(1., .62, .5), fk / 2.), line(y - yc, .005 + .004 * sin(b.x * 9. + fk)) * .75);
  }
  return col;
}
// 5 Aurora: Nachthimmel mit Sternen, grüne und violette Lichtvorhänge mit Strahlen
vec3 tAurora(vec2 uv, vec2 b){
  vec3 col = mix(vec3(.02, .04, .1), vec3(.0, .01, .03), smoothstep(0., 1., uv.y));
  vec2 sp = gl_FragCoord.xy / 3.; float h = hash(floor(sp));
  col += step(.993, h) * (1. - smoothstep(0., .5, length(fract(sp) - .5))) * (.6 + .4 * sin(uT * 2. + h * 50.)) * .8;
  for (int k = 0; k < 2; k++){
    float fk = float(k);
    float y0 = .44 - fk * .15 + .07 * sin(b.x * 3. + uT * .15 + fk * 2.) + .03 * sin(b.x * 8. - uT * .1);
    float dy = y0 - b.y;   // > 0 oberhalb der hellen Unterkante
    float cur = smoothstep(-.004, .006, dy) * exp(-max(dy, 0.) * (5. + fk * 3.));
    float rays = .55 + .45 * sin(b.x * 70. + sin(b.x * 11. + uT * .2) * 5.);
    col += (k == 0 ? vec3(.25, 1., .6) : vec3(.6, .35, 1.)) * cur * rays * .9;
  }
  return col;
}
// 6 Neon: fast Schwarz, scharfe Leuchtröhren in Pink und Cyan mit Schein
vec3 tNeon(vec2 uv, vec2 b){
  float asp = uRes.x / uRes.y; vec2 p = vec2(b.x * asp, b.y);
  vec3 col = mix(vec3(.05, .01, .08), vec3(.01, 0., .02), uv.y);
  vec3 pink = vec3(1., .25, .65), cyan = vec3(.12, .9, 1.);
  float d1 = abs(b.y - (.3 + .07 * sin(b.x * 6. + uT * .25)));
  float d2 = abs(length(p - vec2(.68 * asp, .62)) - .14);
  float d3 = abs(b.x - b.y * .6 - .05 + .02 * sin(uT * .2));
  float d4 = abs(b.y - (.86 + .03 * sin(b.x * 9. - uT * .2)));
  col += pink * (line(d1, .0028) * 1.1 + exp(-d1 * 70.) * .45);
  col += cyan * (line(d2, .0028) * 1.1 + exp(-d2 * 70.) * .45);
  col += cyan * (line(d3, .0022) + exp(-d3 * 80.) * .35);
  col += pink * (line(d4, .0022) + exp(-d4 * 80.) * .35);
  return col;
}
vec3 theme(int id, vec2 uv, vec2 b){
  if (id == 1) return tBW(uv, b);
  if (id == 2) return tPorcelain(uv, b);
  if (id == 3) return tSea(uv, b);
  if (id == 4) return tSunset(uv, b);
  if (id == 5) return tAurora(uv, b);
  if (id == 6) return tNeon(uv, b);
  return tColor(uv, b);
}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; uv.y = 1. - uv.y;
  float s = sin(uT * .11), a = s * .12, cs = cos(a), sn = sin(a);
  vec2 b = mat2(cs, sn, -sn, cs) * (uv - .5 + uPar * .025) + .5 + s * vec2(.04, .03);
  vec3 col = theme(uTB, uv, b);
  if (uTF < .999) col = mix(theme(uTA, uv, b), col, uTF);   // weich von der alten in die neue Farbwelt
  col = mix(col, uGlow, uHot * .6 * lay(b, vec2(.5, .6), vec2(.5, .4)));
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - .5) / 255.;   // gegen Farbstufen
  o = vec4(col, 1.);
}`;

export const GL_LENS_VS = `#version 300 es
uniform vec2 uRes; uniform vec4 uR; uniform float uM;
out vec2 vP;
const vec2 Q[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(1,1), vec2(-1,-1), vec2(1,1), vec2(-1,1));
void main(){
  vec2 p = uR.xy + Q[gl_VertexID] * (uR.zw + uM);   // uM: Platz für Verformung
  vP = p;
  gl_Position = vec4(p.x / uRes.x * 2. - 1., 1. - p.y / uRes.y * 2., 0., 1.);
}`;

/* Glas-Schleim: Die Form ist ein Distanzfeld, das vor dem Auswerten verbogen wird.
   Zug (uJ) zieht die Umgebung des Ankerpunkts mit, Quellen (uS) bläht auf, Welle (uW) kräuselt die Oberfläche.
   Brechung, Lichtring und Kaustik hängen an der verbogenen Form. */
export const GL_LENS_FS = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform vec4 uR; uniform vec3 uP; uniform float uDpr; uniform sampler2D uBg; uniform vec3 uGlowC; uniform float uLight;
uniform vec4 uW;    // Welle: Ursprung relativ zur Mitte (xy), Radius der Front (z), Stärke (w)
uniform vec4 uGlass; uniform float uTint;   // Regler: Lichtbrechung, Milchglas, Regenbogen, Glanz; Färbung
uniform vec4 uClip; // Scrollbereich (links, oben, rechts, unten): außerhalb kein Glas, am Rand 14 px Verlauf
// Index 0 ist dieses Glas, danach die Nachbarn, mit denen es verschmelzen kann.
uniform vec4 uNR[8];  // Mitte, halbe Größe
uniform vec4 uNJ[8];  // Zug: Anker relativ zur Mitte (xy), Verschiebung (zw)
uniform vec4 uNQ[8];  // Eckenradius, Quellen-Skalierung, Reichweite des Zugs, Kantenbreite
uniform vec4 uNG[8];  // Druck-Leuchten: Position, Stärke; w: Brücken-Reichweite dieses Glases
uniform int uSelf;    // welcher Eintrag dieses Glas ist
uniform vec4 uBA[4];  // Glasfäden zwischen gebundenen Tropfen: Endpunkt a (xy), b (zw)
uniform vec4 uBR[4];  // Fadenradius, Übergangs-Reichweite
uniform int uNB;
uniform int uNN; uniform float uK;   // Anzahl, Verschmelz-Reichweite
in vec2 vP; out vec4 o;

vec2 restN(vec2 p, int i){
  vec2 q = (p - uNR[i].xy) / uNQ[i].y, a = uNJ[i].xy / uNQ[i].y;
  return q - uNJ[i].zw * exp(-dot(q - a, q - a) / (uNQ[i].z * uNQ[i].z));
}
float sdN(vec2 p, int i){
  vec2 b = abs(restN(p, i)) - uNR[i].zw + uNQ[i].x;
  return length(max(b, 0.)) + min(max(b.x, b.y), 0.) - uNQ[i].x;
}
float smink(float a, float b, float k){ float h = max(k - abs(a - b), 0.) / k; return min(a, b) - h * h * k * .25; }
float seg(vec2 p, vec4 s){ vec2 pa = p - s.xy, ba = s.zw - s.xy; return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.)); }
// Tropfen berühren sich weich (uK), gebundene hängen an einem Glasfaden, der sich an beide anschmiegt
float box(vec2 p){
  float d = sdN(p, 0);
  for (int i = 1; i < uNN; i++) d = smink(d, sdN(p, i), uK);
  for (int j = 0; j < uNB; j++) d = smink(d, seg(p, uBA[j]) - uBR[j].x, uBR[j].y);
  return d;
}
vec3 bgAt(vec2 p){ return texture(uBg, vec2(p.x / uRes.x, 1. - p.y / uRes.y)).rgb; }
// Spektrum: Gewicht einer Wellenlänge t (0 = Rot … 1 = Violett) je Farbkanal; 7 Stützstellen addieren sich zu Weiß
vec3 spec(float t){ return clamp(1.5 - abs(t - vec3(.1, .45, .8)) * 4., 0., 1.); }
const int NW = 7;
vec2 bend(vec3 N, float ior, float T, float lim){
  vec3 r = refract(vec3(0., 0., -1.), N, 1. / ior);
  vec2 off = r.xy / max(-r.z, .2) * T;
  return off * min(1., lim / max(length(off), 1e-4));
}
void main(){
  float cdist = min(vP.y - uClip.y, uClip.w - vP.y);   // nur oben/unten: seitlich darf das Glas beim Wabbeln überstehen
  if (cdist <= 0.) discard;
  float clipA = smoothstep(0., 14. * uDpr, cdist);
  float d0 = box(vP);
  if (d0 > 3. * uDpr) discard;
  // Jeder Bildpunkt gehört dem nächsten Glas, sonst würde die Brücke doppelt gezeichnet (Toleranz gegen Löcher bei Gleichstand)
  float own = sdN(vP, uSelf), dmin = own;
  for (int i = 0; i < uNN; i++){ if (i == uSelf) continue; float e = sdN(vP, i); dmin = min(dmin, e); if (e < own - .05) discard; }
  float bf = smoothstep(0., 3. * uDpr, dmin - d0);   // 1 im Hals der Brücke, 0 im Tropfen selbst
  vec2 g = vec2(box(vP + vec2(1., 0.)) - box(vP - vec2(1., 0.)), box(vP + vec2(0., 1.)) - box(vP - vec2(0., 1.))) * .5;
  float gm = max(length(g), .05), d = d0 / gm;   // echte Distanz trotz Dehnung
  float cov = 1. - smoothstep(-uDpr, uDpr, d);
  if (cov <= 0.) discard;
  vec2 n2 = g / gm;
  // Wölbung und Kantenbreite über alle beteiligten Gläser gemischt: keine Naht in der Brücke
  vec2 dome = vec2(0.); float B = 0., ws = 0.;
  for (int i = 0; i < uNN; i++){
    float w = exp(-max(sdN(vP, i), 0.) / (12. * uDpr)) + 1e-4;
    dome += restN(vP, i) / max(uNR[i].z, uNR[i].w) * w; B += uNQ[i].w * w; ws += w;
  }
  dome *= .22 / ws; B /= ws;
  // im Faden: Kantenbreite = Fadendicke, damit er rund wie ein Zylinder wirkt
  float rb = B, sb = 1e9;
  for (int j = 0; j < uNB; j++){ float e = seg(vP, uBA[j]) - uBR[j].x; if (e < sb){ sb = e; rb = uBR[j].x; } }
  B = mix(B, max(rb * 1.15, 2. * uDpr), bf);
  float depth = max(-d, 0.), x = clamp(depth / B, 0., 1.), k = 1. - x;

  // Oberfläche: Viertelkreis am Rand, Lupen-Wölbung, Welle vom Finger
  vec2 rp = vP - uR.xy - uW.xy; float rr = length(rp), dr = rr - uW.z, lam = 15. * uDpr;
  float wave = uW.w * cos(dr / lam * 6.2832) * exp(-dr * dr / (lam * lam * 2.));
  vec2 tilt = n2 * k + dome * x + rp / max(rr, 1.) * wave * smoothstep(0., .4, x);
  vec3 N = normalize(vec3(tilt, sqrt(max(1. - k * k, 0.)) + .015));

  float T = B * 1.6 * (1. - .5 * bf) * uGlass.x, lim = B * 2.6;   // im Hals weichere Brechung; Regler Lichtbrechung
  // Spektrale Dispersion: jede Wellenlänge bricht anders (Rot schwach, Violett stark). Auf gleichmäßigen Flächen
  // ergeben sie zusammen wieder Weiß, an Kanten im Bild fächern sie zum Regenbogen auf.
  vec3 SPW = vec3(0.);
  for (int i = 0; i < NW; i++) SPW += spec(float(i) / float(NW - 1));
  vec3 refr;
  vec2 o0 = bend(N, 1.34, T, lim), o1 = bend(N, 1.72, T, lim);
  // Fächer höchstens 8 px breit: sonst werden die 7 Wellenlängen zu 7 versetzten Kopien (Treppenstufen) statt Verlauf
  vec2 oc = (o0 + o1) * .5, od = (o1 - o0) * .5; float sl = length(od) * 2.;
  if (sl > 8. * uDpr) od *= 8. * uDpr / sl;
  od *= uGlass.z;   // Regler Regenbogen
  o0 = oc - od; o1 = oc + od;
  if (length(o1 - o0) < .75){ refr = bgAt(vP + (o0 + o1) * .5); }   // innen: Farben fallen zusammen, eine Abtastung reicht
  else {
    refr = vec3(0.);
    for (int i = 0; i < NW; i++){ float t = float(i) / float(NW - 1); refr += bgAt(vP + mix(o0, o1, t)) * spec(t); }
    refr /= SPW;
  }
  if (uGlass.y > .01){   // Regler Milchglas: Hintergrund weichzeichnen und leicht milchig machen
    vec2 c0 = (o0 + o1) * .5; float rb = (6. + 22. * uGlass.y) * uDpr; vec3 acc = vec3(0.);
    for (int i = 0; i < 8; i++){ float an = float(i) * .7854; vec2 dd = vec2(cos(an), sin(an)) * rb; acc += bgAt(vP + c0 + dd) + bgAt(vP + c0 + dd * .45); }
    refr = mix(refr, acc / 16., min(1., uGlass.y * 1.4));
    refr = mix(refr, vec3(1.), .14 * uGlass.y * (1. - uLight));
  }
  float l = dot(refr, vec3(.299, .587, .114));
  refr = mix(vec3(l), refr, 1.2) * mix(1.05, 1., uLight) + .015 * (1. - uLight);   // auf hellem Grund nicht aufhellen, sonst grell

  float F = pow(1. - N.z, 3.);
  vec3 refl = bgAt(vP + n2 * (B * 2.2 + depth)) * mix(1.25, .97, uLight) + vec3(.55, .6, .7) * smoothstep(.2, -.9, n2.y) * .5 * (1. - uLight);
  vec3 col = mix(refr, refl, min(1., F * mix(.8, .5, uLight) * (1. - .9 * bf) * uGlass.w));   // dünner Hals spiegelt kaum

  vec2 L = normalize(vec2(-.6, -.8));
  float up = max(dot(n2, L), 0.), dn = max(dot(n2, -L), 0.);
  // Lichtring spektral zerlegt: jede Wellenlänge sitzt etwas anders, weißes Licht bekommt Regenbogensäume
  vec3 ring = vec3(0.);
  for (int i = 0; i < NW; i++){
    float t = float(i) / float(NW - 1), xs = x + (t - .5) * .09;
    ring += spec(t) * smoothstep(.10, .18, xs) * (1. - smoothstep(.22, .36, xs));
  }
  ring /= SPW;
  float lit = 1. - bf;   // Licht im Hals dämpfen, sonst wirkt die Brücke grell
  col += ring * lit * uGlass.w * (pow(up, 2.5) * 1.15 + pow(dn, 3.) * .45);
  col += refr * smoothstep(.02, .2, x) * (1. - smoothstep(.25, .65, x)) * pow(dn, 1.5) * 1.1 * lit;
  vec3 H = normalize(normalize(vec3(-.45, -.65, .6)) + vec3(0., 0., 1.));
  col += pow(max(dot(N, H), 0.), 120.) * 1.3 * lit * uGlass.w;

  for (int i = 0; i < uNN; i++){   // Leuchten fließt auch durch die Brücke ins Nachbarglas
    float gd = length(vP - uNG[i].xy) / max(uNR[i].z, uNR[i].w);
    col += uGlowC * uNG[i].z * (exp(-gd * gd * 3.) * 1.1 + .15 * (1. - smoothstep(-12. * uDpr, 12. * uDpr, sdN(vP, i))));
  }
  col = mix(col, col * .5 + uGlowC * .45, uTint * .7);   // Regler Färbung: Glas in der Akzentfarbe
  col *= 1. - uLight * .14 * pow(1. - x, 2.) * (1. - bf);   // heller Grund: Glas bekommt am Rand etwas Tiefe statt zu verschwinden
  col = mix(bgAt(vP), col, smoothstep(0., .12, x));   // Rand fließt in den Hintergrund
  o = vec4(col, cov * uP.z * clipA);
}`;

