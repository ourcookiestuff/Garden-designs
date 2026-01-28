// Canvas
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const PX_PER_METER = 10;
const dpr = window.devicePixelRatio || 1;

let widthMeters = 60;
let heightMeters = 50;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); } // ograniczanie wartości do przedziału

function resizeCanvas() {
  widthMeters = clamp(Number(document.getElementById("widthInput").value), 10, 75);
  heightMeters = clamp(Number(document.getElementById("heightInput").value), 10, 60);

  document.getElementById("widthInput").value = widthMeters;
  document.getElementById("heightInput").value = heightMeters;

  const widthPx = widthMeters * PX_PER_METER;
  const heightPx = heightMeters * PX_PER_METER;

  canvas.width = widthPx * dpr;
  canvas.height = heightPx * dpr;

  canvas.style.width = widthPx + "px";
  canvas.style.height = heightPx + "px";

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // rysowanie w normalnej skali
  ctx.clearRect(0, 0, widthPx, heightPx);
}

// nasłuchiwanie zmian rozmiaru
["click","keypress","change","input"].forEach(ev=>{
  document.getElementById("widthInput").addEventListener(ev, resizeCanvas);
  document.getElementById("heightInput").addEventListener(ev, resizeCanvas);
});
resizeCanvas();

// Slidery -> parametry
function readParamsFromUI() {
  const paths = Number(document.getElementById("sciezki-slider").value);     // 1..5
  const flowers = Number(document.getElementById("kwiatki-slider").value);   // 0..1
  const trees = Number(document.getElementById("drzewa-slider").value);      // 0..1
  const divisions = paths;
  return { divisions, paths, flowers, trees };
}

// Graf
/*
GRAMATYKA:
GARDEN → AREA + PATH_SYSTEM

AREA (depth>0) → AREA + AREA (podział)
AREA (depth=0) → GRASS_RECT
AREA (depth=0) → FLOWER_AREA
AREA (depth=0) → GRASS_RECT + n×TREE_CIRCLE
AREA (depth=0) → GRASS_RECT + WATER_CIRCLE/WATER_RECT

FLOWER_AREA → GRASS_RECT + 2×ROSE_BED
FLOWER_AREA → GRASS_RECT + FOUNTAIN + 4×TULIP_BED

PATH_SYSTEM → n×PATH_RECT (z granic stref)
*/
// etykiety wezłów
const Label = {
  // nieterminale
  GARDEN: "GARDEN",
  AREA: "AREA",
  PATH_SYSTEM: "PATH_SYSTEM",
  FLOWER_AREA: "FLOWER_AREA",

  // terminale
  GRASS_RECT: "GRASS_RECT",
  PATH_RECT: "PATH_RECT",
  TREE_CIRCLE: "TREE_CIRCLE",
  WATER_CIRCLE: "WATER_CIRCLE",
  WATER_RECT: "WATER_RECT",

  // kwiaty "na trawie"
  ROSE_BED: "ROSE_BED",
  TULIP_BED: "TULIP_BED",
  FOUNTAIN: "FOUNTAIN",
};

const NONTERMINALS = new Set([Label.GARDEN, Label.AREA, Label.PATH_SYSTEM, Label.FLOWER_AREA]);
function isNonterminal(l) { return NONTERMINALS.has(l); }

class Graph {
  constructor() {
    this.nodes = new Map(); // wierzchołki: id -> {id, label, attrs}, unikalne id, typ i dane geometryczne
    this.edges = []; // krawędzie: {a, b, type}
    this._id = 1; 
  }
  addNode(label, attrs) {
    const id = this._id++;
    this.nodes.set(id, { id, label, attrs: { ...attrs } });
    return id;
  }
  getNode(id) { return this.nodes.get(id); }
  removeNode(id) {
    this.nodes.delete(id);
    this.edges = this.edges.filter(e => e.a !== id && e.b !== id);
  }
  listNodes() { return [...this.nodes.values()]; }
  addEdge(a,b,type="rel", attrs=null) {
    const e = {a,b,type, ...(attrs ? attrs : {})};
    this.edges.push(e);
    return e;
  }
}

function rebuildAdjacencyEdges(g, thickness = 10) {
  // 1) usuń stare adjacent (żeby nie dublować)
  g.edges = g.edges.filter(e => e.type !== "adjacent");

  // 2) zbieranie końcowych prostokątów terenu
  // (te węzły które mają attrs {x,y,w,h} i nie są PATH_SYSTEM)
  const sectorLabels = new Set([
    Label.AREA, Label.GRASS_RECT, Label.FLOWER_AREA
  ]);
  const sectors = g.listNodes().filter(n => sectorLabels.has(n.label));

  // pomocniczo:
  const EPS = 1e-6;
  function overlapLen(a1, a2, b1, b2) {
    return Math.min(a2, b2) - Math.max(a1, b1);
  }

  function borderBetweenRects(A, B) {
    const ax2 = A.x + A.w, ay2 = A.y + A.h; // prawa i dolna krawędź A
    const bx2 = B.x + B.w, by2 = B.y + B.h; // prawa i dolna krawędź B

    // B po prawej A
    if (Math.abs(ax2 - B.x) < EPS) {
      const ov = overlapLen(A.y, ay2, B.y, by2);
      if (ov > 4) return snapRect10({ x: ax2 - thickness/2, y: Math.max(A.y, B.y), w: thickness, h: ov });
    }
    // B po lewej A
    if (Math.abs(bx2 - A.x) < EPS) {
      const ov = overlapLen(A.y, ay2, B.y, by2);
      if (ov > 4) return snapRect10({ x: A.x - thickness/2, y: Math.max(A.y, B.y), w: thickness, h: ov });
    }
    // B pod A
    if (Math.abs(ay2 - B.y) < EPS) {
      const ov = overlapLen(A.x, ax2, B.x, bx2);
      if (ov > 4) return snapRect10({ x: Math.max(A.x, B.x), y: ay2 - thickness/2, w: ov, h: thickness });
    }
    // B nad A
    if (Math.abs(by2 - A.y) < EPS) {
      const ov = overlapLen(A.x, ax2, B.x, bx2);
      if (ov > 4) return snapRect10({ x: Math.max(A.x, B.x), y: A.y - thickness/2, w: ov, h: thickness });
    }

    return null;
  }

  // 3) dla każdej pary sektorów sprawdź, czy mają wspólną granicę
  for (let i = 0; i < sectors.length; i++) {
    for (let j = i + 1; j < sectors.length; j++) {
      const A = sectors[i].attrs;
      const B = sectors[j].attrs;

      const border = borderBetweenRects(A, B);
      if (!border) continue;

      // const len = Math.max(border.w, border.h);
      // if (len < 5) continue;

      // dodaj krawędzie w obie strony
      g.addEdge(sectors[i].id, sectors[j].id, "adjacent", { border });
      g.addEdge(sectors[j].id, sectors[i].id, "adjacent", { border });
    }
  }
}

function pick(arr) { return arr[Math.floor(Math.random()*arr.length)]; } // losowy wybór z tablicy
function randInt(a,b) { return a + Math.floor(Math.random()*(b-a+1)); } // losowa liczba całkowita z przedziału [a,b]

// Dzielenie prostokątów
function splitRect(rect, mode) {
  const {x,y,w,h} = rect;

  if (mode === "V50_A") { // PIONOWO 50/50
    return [{x,y,w:w*0.5,h},{x:x+w*0.5,y,w:w*0.5,h}];
  }
  if (mode === "V60_40") {  // PIONOWO 60/40
    return [{x,y,w:w*0.6,h},{x:x+w*0.6,y,w:w*0.4,h}];
  }
  if (mode === "V40_60") {  // PIONOWO 40/60
    return [{x,y,w:w*0.4,h},{x:x+w*0.4,y,w:w*0.6,h}];
  }
  if (mode === "H50_A") { // POZIOMO 50/50
    return [{x,y,w,h:h*0.5},{x,y:y+h*0.5,w,h:h*0.5}];
  }
  if (mode === "H60_40") {  // POZIOMO 60/40
    return [{x,y,w,h:h*0.6},{x,y:y+h*0.6,w,h:h*0.4}];
  }
  return [{x,y,w,h:h*0.4},{x,y:y+h*0.4,w,h:h*0.6}]; // POZIOMO 40/60
}

// zaokrąglanie prostokątów do 10, by było równo
function snapRect10(r){
  return {
    x: Math.round(r.x/10)*10,
    y: Math.round(r.y/10)*10,
    w: Math.round(r.w/10)*10,
    h: Math.round(r.h/10)*10
  };
}

function chooseSplitMode(R){
  if (R.w > R.h * 1.3) return pick(["V50_A","V50_A","V60_40","V40_60"]);  // jeżeli bardziej poziomy, dziel pionowo
  if (R.h > R.w * 1.3) return pick(["H50_A","H50_A","H60_40","H40_60"]);  // jeżeli bardziej pionowy, dziel poziomo
  return pick(["V50_A","V60_40","V40_60","H50_A","H60_40","H40_60"]);
}

function sharedBorderRect(a, b, thickness){
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;

  if (Math.abs(ax2 - b.x) < 1e-6) {
    const y1 = Math.max(a.y, b.y), y2 = Math.min(ay2, by2);
    if (y2 > y1) return { x: ax2 - thickness/2, y: y1, w: thickness, h: (y2 - y1) };
  }
  if (Math.abs(bx2 - a.x) < 1e-6) {
    const y1 = Math.max(a.y, b.y), y2 = Math.min(ay2, by2);
    if (y2 > y1) return { x: a.x - thickness/2, y: y1, w: thickness, h: (y2 - y1) };
  }
  if (Math.abs(ay2 - b.y) < 1e-6) {
    const x1 = Math.max(a.x, b.x), x2 = Math.min(ax2, bx2);
    if (x2 > x1) return { x: x1, y: ay2 - thickness/2, w: (x2 - x1), h: thickness };
  }
  if (Math.abs(by2 - a.y) < 1e-6) {
    const x1 = Math.max(a.x, b.x), x2 = Math.min(ax2, bx2);
    if (x2 > x1) return { x: x1, y: a.y - thickness/2, w: (x2 - x1), h: thickness };
  }
  return null;
}

// Kolizje / geometria
function circleInsideRect(c,r) {
  return (c.x - c.r >= r.x) && (c.x + c.r <= r.x+r.w) && (c.y - c.r >= r.y) && (c.y + c.r <= r.y+r.h);
}
function circleIntersectsCircle(a,b) {
  const dx = a.x-b.x, dy = a.y-b.y;
  const rr = a.r + b.r;
  return dx*dx + dy*dy <= rr*rr;
}

// Wybór terminala dla AREA
function pickAreaTerminalType(params){
  // wagi prawdopodobieństwa 
  const wGrass   = 0.55; 
  const wFlowers = 0.08 + 0.55 * params.flowers;
  const wTrees   = 0.10 + 0.55 * params.trees;
  const wWater   = 0.06 + 0.12 * (1 - (params.paths-2)/5);
  const sum = wGrass + wFlowers + wTrees + wWater;

  // ruletka
  let r = Math.random() * sum;
  if ((r -= wGrass)   <= 0) return "GRASS";
  if ((r -= wFlowers) <= 0) return "FLOWERS";
  if ((r -= wTrees)   <= 0) return "TREES";
  return "WATER";
}

// Produkcje
const productions = {
  [Label.GARDEN]: [
    function P_G1(g, id, params) {
      const n = g.getNode(id);  // weź wierzchołek GARDEN
      const R = n.attrs;  // jego prostokąt {x, y, w, h}
      g.removeNode(id); // usuń GARDEN z grafu

      // Dodanie dwóch nowych wierzchołków
      const areaId = g.addNode(Label.AREA, {...R, depth: params.divisions});
      const pathId = g.addNode(Label.PATH_SYSTEM, {...R, intensity: params.paths});
      //g.addEdge(areaId, pathId, "contains");
    }
  ],

  [Label.PATH_SYSTEM]: [
    function P_PS_fromEdges(g, id, params) {
      const n = g.getNode(id);
      const R = n.attrs;
      g.removeNode(id);

      // zbierz unikalne granice z krawędzi adjacent
      const seen = new Set();
      const borders = [];

      for (const e of g.edges) {
        if (e.type !== "adjacent") continue;
        if (!e.border) continue;

        const b = snapRect10(e.border);
        const k = `${b.x}|${b.y}|${b.w}|${b.h}`; // deduplikacja (bo masz 2 krawędzie na jedną granicę)

        if (seen.has(k)) continue;
        seen.add(k);

        // filtr mikrusów
        // const len = Math.max(b.w, b.h);
        // if (len < 20) continue;

        borders.push(b);
      }

      // ramka ogrodu
      // const t = 10;
      // g.addNode(Label.PATH_RECT, {x:R.x, y:R.y, w:R.w, h:t});
      // g.addNode(Label.PATH_RECT, {x:R.x, y:R.y+R.h-t, w:R.w, h:t});
      // g.addNode(Label.PATH_RECT, {x:R.x, y:R.y, w:t, h:R.h});
      // g.addNode(Label.PATH_RECT, {x:R.x+R.w-t, y:R.y, w:t, h:R.h});

      // ścieżka na KAŻDEJ granicy sektorów
      for (const b of borders) {
        const rect = { ...b };

        rect.x = clamp(rect.x, R.x, R.x + R.w - rect.w);
        rect.y = clamp(rect.y, R.y, R.y + R.h - rect.h);

        g.addNode(Label.PATH_RECT, rect);
      }
    }
  ],

  [Label.AREA]: [
    function P_A1_split(g, id, params) {
      const n = g.getNode(id);
      const depth = n.attrs.depth ?? 0;
      if (depth <= 0) return;

      const R = n.attrs;
      const mode = chooseSplitMode(R);  // wybieranie sposobu podziału
      const [r1, r2] = splitRect(R, mode);  // sposób podziału

      // czy części nie są za małe
      if (Math.min(r1.w,r1.h) < 35 || Math.min(r2.w,r2.h) < 35) return;

      g.removeNode(id); // usuń stary wierzchołek
      // dodaj dwa nowe (depth - 1)
      const a1 = g.addNode(Label.AREA, {...r1, depth: depth-1});
      const a2 = g.addNode(Label.AREA, {...r2, depth: depth-1});

      const thickness = (Math.random() < 0.7) ? 10 : 15;
      let border = sharedBorderRect(r1, r2, thickness);

      if (border) {
        border = snapRect10(border);

        // wywal bardzo krótkie odcinki (żeby nie było śmieci)
        const len = Math.max(border.w, border.h);
        if (len < 20) border = null;
      }

      g.addEdge(a1, a2, "adjacent", border ? { border } : null);
      g.addEdge(a2, a1, "adjacent", border ? { border } : null);
    },

    function P_A2_toTerminal(g, id, params) {
      const n = g.getNode(id);
      const R = n.attrs;
      const depth = n.attrs.depth ?? 0;

      // produkcja tylko dla depth = 0
      if (depth > 0) return;

      // g.removeNode(id);
      const kind = pickAreaTerminalType(params);  // losowanie typu terenu

      if (kind === "GRASS") {
        n.label = Label.GRASS_RECT;
        delete n.attrs.depth;
        return;
      }

      if (kind === "FLOWERS") {
        n.label = Label.FLOWER_AREA;   // dalej nieterminal, ale wciąż TEN SAM węzeł
        delete n.attrs.depth;
        return;
      }

      if (kind === "TREES") {
        // podłoże = trawa
        n.label = Label.GRASS_RECT;
        delete n.attrs.depth;

        // ile drzew zależy od powierzchni
        const maxTrees = clamp(Math.floor((R.w*R.h)/6000), 3, 16);
        const placed = []; // już posadzone drzewa

        // sadzenie drzew
        for (let i=0;i<maxTrees;i++){
          let ok = false;

          // 20 prób znalezienia dobrego miejsca
          for (let t=0;t<20 && !ok;t++) {
            const rr = 25 + randInt(-6, 12);  // promień 19-37
            const x = R.x + randInt(rr, Math.max(rr, Math.floor(R.w - rr)));
            const y = R.y + randInt(rr, Math.max(rr, Math.floor(R.h - rr)));
            const c = {x,y,r:rr};

            // czy w obszarze?
            if (!circleInsideRect(c, R)) continue;

            // czy koliduje z innym drzewem?
            let hit = false;
            for (const p of placed) { if (circleIntersectsCircle(c,p)) { hit=true; break; } }
            if (hit) continue;

            // jeżeli ok to można posadzić
            placed.push(c);
            g.addNode(Label.TREE_CIRCLE, c);
            ok = true;
          }
        }
        return;
      }

      // WATER - 3 warianty
      n.label = Label.GRASS_RECT;
      delete n.attrs.depth;

      // środek obszaru
      const cx = R.x + R.w/2 + randInt(-Math.floor(R.w/10), Math.floor(R.w/10));
      const cy = R.y + R.h/2 + randInt(-Math.floor(R.h/10), Math.floor(R.h/10));

      const featureType = randInt(0, 1);  // wybór typu: 0, 1
      if (featureType === 0){
        // STAW OKRĄGŁY
        const r = clamp(Math.min(R.w,R.h)*0.30, 35, 80);
        const pond = {x:cx, y:cy, r};
        g.addNode(Label.WATER_CIRCLE, pond);
      } else {
        // STAW PROSTOKĄTNY
        const r = clamp(Math.min(R.w,R.h)*0.18, 30, 65);
        const xa = cx + r*0.55, xb = cx - r*0.55;
        const c1 = {x:xa, y:cy, r};
        const c2 = {x:xb, y:cy, r};
        const link = {x: xb, y: cy - r, w: (xa-xb), h: 2*r};
        g.addNode(Label.WATER_CIRCLE, c1);
        g.addNode(Label.WATER_CIRCLE, c2);
        g.addNode(Label.WATER_RECT, link);
      } 
    }
  ],

  // KWIATY: trawa tłem + kompozycja rabat
  [Label.FLOWER_AREA]: [
    // wariant 1: 2 rabaty z różami NA TRAWIE
    function P_F1_roses(g, id) {
      const n = g.getNode(id);
      const R = n.attrs;
      n.label = Label.GRASS_RECT;

      // margines od krawędzi
      const pad = 10;
      const inner = { x:R.x+pad, y:R.y+pad, w:R.w-2*pad, h:R.h-2*pad };

      const vertical = Math.random() < 0.5; // pionowy czy poziomy podział
      if (vertical) {
        // dwie rabaty obok siebie
        g.addNode(Label.ROSE_BED, { x:inner.x, y:inner.y, w:inner.w/2-5, h:inner.h });
        g.addNode(Label.ROSE_BED, { x:inner.x+inner.w/2+5, y:inner.y, w:inner.w/2-5, h:inner.h });
      } else {
        // dwie rabaty jedna nad drugą
        g.addNode(Label.ROSE_BED, { x:inner.x, y:inner.y, w:inner.w, h:inner.h/2-5 });
        g.addNode(Label.ROSE_BED, { x:inner.x, y:inner.y+inner.h/2+5, w:inner.w, h:inner.h/2-5 });
      }
    },

    // wariant 2: fontanna + 4 rabaty tulipanów na trawie
    function P_F2_fountain(g, id) {
      const n = g.getNode(id);
      const R = n.attrs;
      n.label = Label.GRASS_RECT;

      const pad = 10;
      const inner = { x:R.x+pad, y:R.y+pad, w:R.w-2*pad, h:R.h-2*pad };

      // fontanna w środku
      const cx = inner.x + inner.w/2;
      const cy = inner.y + inner.h/2;
      const fr = Math.max(18, Math.min(inner.w, inner.h) * 0.12);

      g.addNode(Label.FOUNTAIN, { x:cx, y:cy, r:fr });

      const t = 10;   // grubość ścieżki w środku

      // margines od ścieżek, żeby rabaty nie nachodziły
      const gap = 8;

      const leftX = inner.x;
      const rightX = cx + t/2 + gap;
      const botY = inner.y;
      const topY = cy + t/2 + gap;

      const leftW = (cx - t/2) - inner.x - gap;
      const rightW = (inner.x + inner.w) - (cx + t/2) - gap;
      const botH = (cy - t/2) - inner.y - gap;
      const topH = (inner.y + inner.h) - (cy + t/2) - gap;

      g.addNode(Label.TULIP_BED, { x:leftX, y:botY, w:leftW, h:botH }); // Lewa-dolna 
      g.addNode(Label.TULIP_BED, { x:rightX, y:botY, w:rightW, h:botH }); // Prawa-dolna
      g.addNode(Label.TULIP_BED, { x:leftX, y:topY, w:leftW, h:topH }); // lewa-górna
      g.addNode(Label.TULIP_BED, { x:rightX, y:topY, w:rightW, h:topH }); // Prawa-górna
    }
  ]
};

// Silnik gramatyki
class GrammarEngine {
  constructor(params) {
    this.params = params;
    this.g = new Graph();
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    this.g.addNode(Label.GARDEN, { x:10, y:10, w:W-20, h:H-20 });
  }

  step() {
    const nonterms = this.g.listNodes().filter(n => isNonterminal(n.label)); // zbieranie wszystkich nieterminali
    if (nonterms.length === 0) return false;

    // 1) AREA najpierw
    const areas = nonterms.filter(n => n.label === Label.AREA);
    if (areas.length) {
      const chosen = pick(areas);
      const depth = chosen.attrs.depth ?? 0;
      if (depth > 0) productions[Label.AREA][0](this.g, chosen.id, this.params); // dzielenie
      else productions[Label.AREA][1](this.g, chosen.id, this.params); // zamiana na terminal
      return true;
    }

    // 2) Potem FLOWER_AREA 
    const flowerAreas = nonterms.filter(n => n.label === Label.FLOWER_AREA);
    if (flowerAreas.length) {
      const chosen = pick(flowerAreas);
      pick(productions[Label.FLOWER_AREA])(this.g, chosen.id, this.params);
      return true;
    }

    // 3) Potem PATH_SYSTEM
    const paths = nonterms.filter(n => n.label === Label.PATH_SYSTEM);
    if (paths.length) {
      rebuildAdjacencyEdges(this.g, 10);
      productions[Label.PATH_SYSTEM][0](this.g, paths[0].id, this.params);
      return true;
    }

    // 4) Reszta
    const chosen = pick(nonterms);
    const prods = productions[chosen.label] || [];
    if (!prods.length) return false;
    pick(prods)(this.g, chosen.id, this.params);
    return true;
  }

  run(maxSteps=1500) {
    for (let i=0; i<maxSteps; i++) {
      if (!this.step()) break;
    }
  }
}

// Rysowanie
function clearCanvas() {
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;
  ctx.clearRect(0, 0, W, H);
}

function drawGrassRect(r) {
  ctx.fillStyle = "#7ec850";
  ctx.fillRect(r.x, r.y, r.w, r.h);

  ctx.fillStyle = "rgba(95,166,60,0.5)";
  const dots = Math.floor((r.w*r.h) / 100);
  for (let i=0; i<dots; i++) {
    const x = r.x + Math.random()*r.w;
    const y = r.y + Math.random()*r.h;
    ctx.beginPath();
    ctx.arc(x, y, 1, 0, Math.PI*2);
    ctx.fill();
  }
}

function drawPathRect(r) {
  ctx.fillStyle = "#b0b0b0";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = "rgba(138,106,61,0.55)";
  const stones = Math.floor((r.w*r.h) / 1800);
  for (let i=0; i<stones; i++) {
    const x = r.x + Math.random()*r.w;
    const y = r.y + Math.random()*r.h;
    ctx.fillRect(x, y, 2, 2);
  }
}

// function drawBenchRect(r) {
//   ctx.fillStyle = "#8d6e63";
//   ctx.fillRect(r.x, r.y, r.w, r.h);
//   ctx.strokeStyle = "rgba(0,0,0,0.25)";
//   ctx.strokeRect(r.x, r.y, r.w, r.h);
// }

function drawWaterCircle(c) {
  ctx.fillStyle = "#6ec6ff";
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI*2);
  ctx.fill();

  ctx.strokeStyle = "rgba(79,163,209,0.8)";
  ctx.beginPath();
  ctx.moveTo(c.x - c.r*0.7, c.y);
  ctx.lineTo(c.x + c.r*0.7, c.y);
  ctx.stroke();
}

function drawWaterRect(r) {
  ctx.fillStyle = "#6ec6ff";
  ctx.fillRect(r.x, r.y, r.w, r.h);

  ctx.strokeStyle = "rgba(79,163,209,0.8)";
  ctx.beginPath();
  ctx.moveTo(r.x, r.y + r.h*0.5);
  ctx.lineTo(r.x + r.w, r.y + r.h*0.5);
  ctx.stroke();
}

function drawTreeCircle(c) {
  ctx.fillStyle = "rgba(46, 126, 50, 0.7)";
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI*2);
  ctx.fill();

  ctx.strokeStyle = "#1b4d1b";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.lineWidth = 1;

  ctx.fillStyle = "#1b4d1b";
  ctx.beginPath();
  ctx.arc(c.x, c.y, 3, 0, Math.PI*2);
  ctx.fill();
}

function drawRoseBed(r){
  ctx.fillStyle = "rgba(220,80,80,0.55)";
  ctx.fillRect(r.x, r.y, r.w, r.h);

  const count = Math.floor((r.w*r.h)/500);
  for (let i=0;i<count;i++){
    const R = 5; // promień dużego kwiatu
    const x = r.x + R + Math.random()*(r.w - 2*R);
    const y = r.y + R + Math.random()*(r.h - 2*R);

    ctx.fillStyle = "rgba(180,0,0,0.75)";
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = "rgba(255,200,200,0.9)";
    ctx.beginPath(); ctx.arc(x+1, y-1, 1, 0, Math.PI*2); ctx.fill();
  }
}

function drawTulipBed(r){
  ctx.fillStyle = "rgba(240,120,190,0.45)";
  ctx.fillRect(r.x, r.y, r.w, r.h);

  const count = Math.floor((r.w*r.h)/650);
  for (let i=0;i<count;i++){
    const x = r.x + Math.random()*r.w;
    const y = r.y + Math.random()*r.h;
    ctx.fillStyle = (Math.random()<0.5) ? "rgba(255,0,120,0.75)" : "rgba(255,180,0,0.75)";
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI*2); ctx.fill();
  }
}

function drawFountain(c){
  ctx.fillStyle = "#81d4fa";
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI*2);
  ctx.fill();

  ctx.strokeStyle = "#0288d1";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.lineWidth = 1;

  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r*0.55, 0, Math.PI*2);
  ctx.stroke();
}

function render(engine) {
  clearCanvas();
  const nodes = engine.g.listNodes(); // wszystkie węzły z grafu

  // WARSTWY: trawa -> rabaty -> woda -> ścieżki -> ławki -> drzewa
  const layer = (label) => {
    if (label === Label.GRASS_RECT) return 0;
    if (label === Label.ROSE_BED || label === Label.TULIP_BED) return 1;
    if (label === Label.WATER_CIRCLE || label === Label.WATER_RECT || label === Label.FOUNTAIN) return 2;
    if (label === Label.PATH_RECT) return 3;
    // if (label === Label.BENCH_RECT) return 4;
    if (label === Label.TREE_CIRCLE) return 5;

    return 9;
  };
  nodes.sort((a,b)=>layer(a.label)-layer(b.label));

  for (const n of nodes) {
    const a = n.attrs;
    switch (n.label) {
      case Label.GRASS_RECT: drawGrassRect(a); break;
      case Label.ROSE_BED: drawRoseBed(a); break;
      case Label.TULIP_BED: drawTulipBed(a); break;
      case Label.FOUNTAIN: drawFountain(a); break;
      case Label.PATH_RECT: drawPathRect(a); break;
      case Label.WATER_CIRCLE: drawWaterCircle(a); break;
      case Label.WATER_RECT: drawWaterRect(a); break;
      case Label.TREE_CIRCLE: drawTreeCircle(a); break;
    }
  }
}

// API UI
let engine = null;

function resetEngine() {
  resizeCanvas();
  const params = readParamsFromUI();
  engine = new GrammarEngine(params);
  render(engine);
}

function generateFull() {
  resetEngine();
  engine.run(100);
  render(engine);
}

document.getElementById("generateButton").addEventListener("click", generateFull);
document.getElementById("resetButton").addEventListener("click", resetEngine);

resetEngine();