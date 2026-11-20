/*
 * Novaworks nova field.
 *
 * Scene, back to front:
 *   1. starfield with twinkle + pointer parallax, and an occasional meteor
 *   2. a breathing nova (glow, orbit rings, orbiting bodies)
 *   3. a perspective ridge-field: ~34 receding wave lines that occlude each other.
 *      Each row mixes broad swells, sharp "ridged" peaks (1 - |sin|), and a
 *      shockwave that radiates out of the nova. A slow tide term makes the
 *      ridges ebb and surge, and rare glitch shears add an edgy flicker.
 *
 * Everything runs in one requestAnimationFrame loop with plain variables
 * (no DOM or framework state). Reduced motion renders one still frame.
 */
(function () {
  "use strict";

  var canvas = document.getElementById("waves");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var TAU = Math.PI * 2;
  var ROWS = 34;

  var width = 0, height = 0, dpr = 1;
  var rgb = "91 140 255";
  var bg = "#040814";

  var time = 0, last = 0, rafId = 0;
  var pointer = 0, pointerTarget = 0;

  // Layout (recomputed on resize)
  var horizon = 0, novaX = 0, novaY = 0, novaR = 0, narrow = false;

  // ---------- deterministic random so the sky is stable between loads ----------
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var rand = mulberry32(20260);
  var stars = [];
  for (var s = 0; s < 220; s++) {
    stars.push({
      x: rand(), y: Math.pow(rand(), 1.4) * 0.62,
      r: rand() < 0.08 ? 1.6 : rand() < 0.4 ? 1.1 : 0.7,
      a: 0.25 + rand() * 0.6,
      tw: 0.4 + rand() * 1.6,
      ph: rand() * TAU,
      par: 2 + rand() * 10
    });
  }

  var meteor = null;
  var nextMeteor = 4;
  var glitch = null;
  var nextGlitch = 6;

  var BOTTOM_K = 1.08; // ridge-field bottom edge as a multiple of viewport height

  // ---------- the face ----------
  // A face built from the same contour-line language as the ocean: a depth map
  // (skull, brows, nose, lips, chin, wet hair) is sliced into fine horizontal
  // lines, each pushed upward by its depth. It is drawn between two water rows,
  // so the rows in front hide whatever is still submerged.
  //
  // What makes it feel alive rather than carved:
  //   - open eyes that blink, glance around and follow the pointer
  //   - an expression that changes with the story (calm, startled gasp, strain)
  //   - slight asymmetry, a head that turns toward its gaze, breathing
  //   - water running down the skin
  var face = { h: 0, w: 0, chinY: 0, row: 0, zc: 0, u: 0, amp: 0, n: 0, db: 0, sp: 0, cx: 0, cy: 0 };
  var FS = 96, FA0 = -0.96, FDA = 1.92 / (FS - 1);  // samples across each line
  var FB0 = -0.99, FB1 = 1.95;                      // head top to neck, in face units
  var faceGrid = new Float32Array(0);
  var fxs = new Float32Array(FS + 2), fys = new Float32Array(FS + 2), fsh = new Float32Array(FS + 2);
  var fbk = new Uint8Array(FS + 2);
  var E = 0, prevE = 0, disturb = 0;                // emergence 0..1 and water disturbance

  // Live state read by the depth map and the eyes
  var life = { eye: 0, blink: 0, brow: 0, furrow: 0, mouth: 0, wide: 0, gx: 0, gy: 0 };
  var mouse = { x: 0, y: 0, active: 0 };
  var blinkT = -1, nextBlink = 6;
  var glanceUntil = 0, glanceX = 0, glanceY = 0, nextGlance = 5;
  var runners = [], nextRunner = 0;

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function clampN(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function sstep(a, b, x) { var t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
  function easeIO(x) {
    x = clamp01(x);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }
  function bump(p, c, w) { var d = (p - c) / w; return Math.exp(-d * d); }

  // One cycle: lurk below, breach slowly, hold, then get pulled back under.
  var CYCLE = 22;
  function emergence(t) {
    var p = t % CYCLE;
    if (p < 3) return 0;
    if (p < 10) return easeIO((p - 3) / 7);
    if (p < 12.5) return 1 + 0.012 * Math.sin(((p - 10) / 2.5) * Math.PI);
    if (p < 18) {
      var k = (p - 12.5) / 5.5;
      // a brief struggle against the pull, then it gives way
      var tug = 0.045 * Math.sin(k * Math.PI * 3) * Math.sin(k * Math.PI);
      return Math.max(0, 1 - easeIO(k) + tug);
    }
    return 0;
  }

  // Expression, blink and gaze for this moment of the story.
  function updateLife(t, dt) {
    var p = t % CYCLE;
    life.eye = sstep(0.6, 0.8, E);                          // eyes open as they clear the water

    var gasp = bump(p, 8.7, 0.9);                           // mouth clears the surface: a sharp breath in
    var strain = bump(p, 13.4, 1.5);                        // being dragged back down
    var breath = 0.5 + 0.5 * Math.sin(t * 1.7);
    life.brow = 0.55 * bump(p, 8.9, 1.2) + 0.4 * strain;    // lifted: surprise, then fear
    life.furrow = 0.7 * strain;
    life.mouth = clamp01(0.75 * gasp + 0.5 * strain + 0.1 * breath * life.eye);
    life.wide = 0.3 * strain + 0.15 * gasp;                 // eyes widen

    // blink
    if (blinkT < 0 && t > nextBlink && life.eye > 0.9) blinkT = 0;
    if (blinkT >= 0) {
      blinkT += dt;
      var kb = blinkT / 0.2;
      if (kb >= 1) {
        blinkT = -1; life.blink = 0;
        nextBlink = t + 2.2 + Math.random() * 3.6;
        if (Math.random() < 0.18) nextBlink = t + 0.25;     // occasional double blink
      } else {
        life.blink = Math.sin(kb * Math.PI);
      }
    }

    // gaze: first up at the nova, then at the viewer, then down at what is pulling it
    var tx = 0, ty;
    if (p < 10) ty = -0.45 + 0.45 * sstep(0.8, 1, E);
    else if (p < 12.5) ty = 0.05;
    else ty = 0.05 + 0.65 * sstep(12.5, 14, p);

    // and it follows the pointer while one is moving around
    if (mouse.active > 0.02) {
      var fx = clampN((mouse.x - face.cx) / (width * 0.45), -1, 1);
      var fy = clampN((mouse.y - (face.cy - face.h * 0.55)) / (height * 0.45), -1, 1);
      var w = clamp01(mouse.active) * (p < 12.5 ? 0.9 : 0.4);
      tx += (fx - tx) * w;
      ty += (fy - ty) * w;
    }
    mouse.active = Math.max(0, mouse.active - dt / 5);

    // an idle glance now and then
    if (t > nextGlance) {
      glanceUntil = t + 0.5 + Math.random() * 0.8;
      glanceX = (Math.random() - 0.5) * 1.1;
      glanceY = (Math.random() - 0.5) * 0.5;
      nextGlance = t + 2.5 + Math.random() * 3.5;
    }
    if (t < glanceUntil && mouse.active < 0.3) { tx += glanceX; ty += glanceY; }

    var follow = Math.min(dt * 8, 1);
    life.gx += (clampN(tx, -1, 1) - life.gx) * follow;
    life.gy += (clampN(ty, -1, 1) - life.gy) * follow;

    // droplets running down the skin
    if (E < 0.4) {
      runners.length = 0;
    } else {
      if (E > 0.7 && t > nextRunner && runners.length < 7) {
        runners.push({ a: (Math.random() - 0.5) * 1.2, b: -0.95, v: 0.16 + Math.random() * 0.2 });
        nextRunner = t + 0.3 + Math.random() * 0.8;
      }
      for (var i = runners.length - 1; i >= 0; i--) {
        var r = runners[i];
        r.b += r.v * dt * (1 + Math.max(0, r.b) * 0.6);
        if (r.b > 1.05) runners.splice(i, 1);
      }
    }
  }

  function gau(a, b, ca, cb, sa, sb, amp) {
    var db = (b - cb) / sb;
    if (db > 2.6 || db < -2.6) return 0;
    var da = (a - ca) / sa;
    return amp * Math.exp(-(da * da) - db * db);
  }
  function gau2(a, b, ca, cb, sa, sb, amp) {
    return gau(a, b, ca, cb, sa, sb, amp) + gau(a, b, -ca, cb, sa, sb, amp);
  }
  // symmetric pair with a little imbalance: real faces are not mirror images
  function gau2a(a, b, ca, cb, sa, sb, amp, asym) {
    return gau(a, b, ca, cb, sa, sb, amp * (1 + asym)) + gau(a, b, -ca, cb, sa, sb, amp * (1 - asym));
  }

  function headHw(b) {
    if (b <= -1 || b >= 1) return 0;
    return Math.pow(Math.sqrt(1 - b * b), 0.6) * (0.95 - 0.22 * sstep(-0.2, 1, b));
  }
  function neckHw(b) {
    if (b < 0.55) return 0;
    return (0.40 + 0.14 * sstep(1.0, 1.45, b) + 0.42 * sstep(1.4, 1.95, b)) * sstep(0.55, 0.95, b);
  }
  function hwAt(b) { return Math.max(headHw(b), neckHw(b)); }

  // Depth toward the viewer at (a, b): a across, b down, roughly -1..1 over the head.
  function faceD(a, b, yaw) {
    var hw = hwAt(b);
    if (hw <= 0) return 0;
    var n = a / hw;
    if (n <= -1 || n >= 1) return 0;
    var edge = 1 - n * n;
    var headF = b < 1 ? Math.pow(1 - b * b, 0.2) : 0;
    var d = 0.40 * Math.sqrt(edge) * (0.5 + 0.5 * headF);
    if (b > 1.02) return d;

    var af = a + yaw, f = 0;
    var o = life.eye, br = life.brow, fu = life.furrow, mo = life.mouth;

    // forehead and brows (one brow sits a touch higher than the other)
    f += gau(af, b, 0, -0.55, 0.45, 0.18, 0.05);
    f += gau2a(af, b, 0.38, -0.30 - 0.05 * br, 0.26, 0.08, 0.085, 0.10);
    f += gau(af, b, 0, -0.28, 0.12, 0.07, 0.05);                  // glabella
    f += gau(af, b, 0, -0.24, 0.05, 0.10, -0.08 * fu);            // furrow between the brows

    // eyes: shallow sockets when open, soft bags beneath
    f += gau2(af, b, 0.40, -0.14, 0.18, 0.07, -0.13 * (1 - 0.7 * o));
    f += gau2(af, b, 0.40, -0.08, 0.17, 0.04, -0.06 * (1 - o));
    f += gau2(af, b, 0.40, -0.01, 0.16, 0.035, 0.03);

    // nose
    f += gau(af, b, 0, -0.04, 0.075, 0.26, 0.17);                 // bridge
    f += gau(af, b, 0, 0.20, 0.11, 0.09, 0.17);                   // tip
    f += gau2(af, b, 0.14, 0.24, 0.07, 0.06, 0.06);               // nostril wings
    f += gau2(af, b, 0.08, 0.28, 0.04, 0.04, -0.07);              // nostrils

    // cheeks and the folds beside the mouth
    f += gau2(af, b, 0.50, 0.0, 0.20, 0.13, 0.07);                // cheekbones
    f += gau2(af, b, 0.55, 0.35, 0.15, 0.15, -0.04);              // hollows
    f += gau2(af, b, 0.27, 0.34, 0.05, 0.13, -0.035);             // nasolabial folds

    // mouth: lips part and the corner pulls when it gasps
    f += gau(af, b, 0, 0.36, 0.05, 0.06, -0.03);                  // philtrum
    f += gau(af, b, 0, 0.44 - 0.02 * mo, 0.20, 0.045, 0.07);      // upper lip
    f += gau(af, b, 0, 0.50, 0.22, 0.03 + 0.03 * mo, -0.10 - 0.14 * mo); // mouth line / opening
    f += gau(af, b, 0, 0.57 + 0.03 * mo, 0.17, 0.05, 0.075);      // lower lip
    f += gau(af, b, 0, 0.66, 0.15, 0.04, -0.04);                  // under-lip dip
    f += gau(af, b, 0, 0.78, 0.20, 0.10, 0.09);                   // chin

    var res = d + f * sstep(0, 0.45, edge);

    // wet hair: a heavier mass above an uneven hairline and down the temples,
    // with strand texture that catches the light
    var hl = -0.55 + 0.05 * Math.sin(af * 8 + 1);
    var hair = Math.max(sstep(hl + 0.06, hl - 0.06, b), sstep(0.78, 0.94, Math.abs(n)) * sstep(0.25, -0.15, b));
    if (hair > 0) {
      res += hair * Math.sqrt(edge) * (0.05 + 0.014 * Math.sin(af * 46 + 3.5 * Math.sin(b * 7 + af * 2.5)));
    }
    return res;
  }

  // ---------- setup ----------
  function readColors() {
    var styles = getComputedStyle(document.documentElement);
    var v = styles.getPropertyValue("--wave-rgb").trim();
    if (v) rgb = v;
    var b = styles.getPropertyValue("--bg").trim();
    if (b) bg = b;
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    narrow = width < 768;
    horizon = height * (narrow ? 0.62 : 0.58);
    novaX = width * (narrow ? 0.5 : 0.74);
    novaR = Math.min(width, height) * (narrow ? 0.05 : 0.055);
    novaY = horizon - novaR * 2.1;

    // face size and the water row it rises through (chin about 20% down the field)
    var bottom = height * BOTTOM_K;
    face.h = Math.min(height * (narrow ? 0.26 : 0.32), width * (narrow ? 0.6 : 0.5));
    face.w = face.h * 0.78;
    face.row = Math.round(Math.pow(0.2, 1 / 2.15) * (ROWS - 1));
    face.zc = face.row / (ROWS - 1);
    face.amp = height * (0.008 + 0.15 * Math.pow(face.zc, 1.85));
    var rowY = horizon + (bottom - horizon) * Math.pow(face.zc, 2.15);
    face.chinY = rowY + face.amp * 0.15;
    face.u = novaX / width;
    face.sp = Math.max(3.2, Math.min(5, face.h / 84));
    face.db = face.sp / (face.h * 0.5);
    face.n = Math.floor((FB1 - FB0) / face.db) + 1;
    faceGrid = new Float32Array(face.n * FS);
    draw();
  }

  function rgba(a) {
    return "rgb(" + rgb + " / " + a.toFixed(3) + ")";
  }

  // ---------- 1. sky ----------
  function drawStars(t) {
    for (var i = 0; i < stars.length; i++) {
      var st = stars[i];
      var x = st.x * width + pointer * st.par;
      var y = st.y * height;
      var a = st.a * (0.65 + 0.35 * Math.sin(t * st.tw + st.ph));
      ctx.fillStyle = "rgb(214 228 255 / " + a.toFixed(3) + ")";
      ctx.fillRect(x, y, st.r, st.r);
    }
  }

  function drawMeteor(dt) {
    if (!meteor) {
      if (time > nextMeteor) {
        meteor = {
          x: width * (0.1 + Math.random() * 0.6),
          y: height * (0.04 + Math.random() * 0.22),
          vx: width * 0.55, vy: height * 0.18, life: 0
        };
      }
      return;
    }
    meteor.life += dt;
    meteor.x += meteor.vx * dt;
    meteor.y += meteor.vy * dt;
    var k = meteor.life / 1.1;
    if (k >= 1) { meteor = null; nextMeteor = time + 6 + Math.random() * 8; return; }
    var a = Math.sin(k * Math.PI);
    var len = 0.16;
    var g = ctx.createLinearGradient(meteor.x, meteor.y, meteor.x - meteor.vx * len, meteor.y - meteor.vy * len);
    g.addColorStop(0, "rgb(235 242 255 / " + (0.9 * a).toFixed(3) + ")");
    g.addColorStop(1, "rgb(" + rgb + " / 0)");
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(meteor.x, meteor.y);
    ctx.lineTo(meteor.x - meteor.vx * len, meteor.y - meteor.vy * len);
    ctx.stroke();
  }

  // ---------- 2. nova ----------
  function drawNova(t) {
    var breathe = 0.85 + 0.15 * Math.sin(t * 0.55);
    var px = novaX + pointer * 14;

    // wide halo
    var halo = ctx.createRadialGradient(px, novaY, 0, px, novaY, novaR * 11 * breathe);
    halo.addColorStop(0, rgba(0.55));
    halo.addColorStop(0.18, rgba(0.22));
    halo.addColorStop(0.5, rgba(0.07));
    halo.addColorStop(1, rgba(0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, width, horizon + novaR * 2);

    // orbit rings (tilted ellipses) with a body on each
    var tilt = -0.32;
    var rings = [
      { rx: novaR * 3.4, ry: novaR * 0.8, sp: 0.42, a: 0.34 },
      { rx: novaR * 5.6, ry: novaR * 1.2, sp: -0.27, a: 0.24 },
      { rx: novaR * 8.4, ry: novaR * 1.7, sp: 0.16, a: 0.16 }
    ];
    ctx.lineWidth = 1;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      ctx.strokeStyle = rgba(r.a);
      ctx.beginPath();
      ctx.ellipse(px, novaY, r.rx, r.ry, tilt, 0, TAU);
      ctx.stroke();

      var ang = t * r.sp * TAU * 0.5 + i * 2.1;
      var ex = Math.cos(ang) * r.rx, ey = Math.sin(ang) * r.ry;
      var bx = px + ex * Math.cos(tilt) - ey * Math.sin(tilt);
      var by = novaY + ex * Math.sin(tilt) + ey * Math.cos(tilt);
      ctx.fillStyle = "rgb(225 236 255 / 0.9)";
      ctx.beginPath();
      ctx.arc(bx, by, 2.2 - i * 0.4, 0, TAU);
      ctx.fill();
    }

    // core
    var core = ctx.createRadialGradient(px, novaY, 0, px, novaY, novaR * 1.5);
    core.addColorStop(0, "rgb(245 249 255 / 1)");
    core.addColorStop(0.35, "rgb(170 200 255 / 0.95)");
    core.addColorStop(1, rgba(0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(px, novaY, novaR * 1.5, 0, TAU);
    ctx.fill();

    // four-point flare
    var fl = novaR * (5.5 + 1.2 * Math.sin(t * 0.8));
    var fh = ctx.createLinearGradient(px - fl, 0, px + fl, 0);
    fh.addColorStop(0, rgba(0)); fh.addColorStop(0.5, "rgb(220 234 255 / 0.85)"); fh.addColorStop(1, rgba(0));
    ctx.fillStyle = fh;
    ctx.fillRect(px - fl, novaY - 0.5, fl * 2, 1);
    var fv = ctx.createLinearGradient(0, novaY - fl * 0.5, 0, novaY + fl * 0.5);
    fv.addColorStop(0, rgba(0)); fv.addColorStop(0.5, "rgb(220 234 255 / 0.7)"); fv.addColorStop(1, rgba(0));
    ctx.fillStyle = fv;
    ctx.fillRect(px - 0.5, novaY - fl * 0.5, 1, fl);
  }

  // ---------- 3. ridge field ----------
  // zc: row depth 0 (horizon) to 1 (nearest). u: 0..1 across the screen.
  function ridge(u, zc, t, ou) {
    var tide = 0.5 + 0.5 * Math.sin(t * 0.32 + zc * 2.4);          // ebb and surge
    var swell = Math.sin(u * TAU * 1.25 + zc * 6.5 - t * 0.7);      // broad travelling swell
    var peaks = 1 - Math.abs(Math.sin(u * TAU * 2.7 - zc * 4.2 + t * 0.38 + 1.3)) - 0.45; // sharp crests
    var spikes = Math.pow(Math.max(0, Math.sin(u * TAU * 5.3 + zc * 9 - t * 0.9)), 6) * 0.38;

    // shockwave rolling out of the nova toward the viewer
    var dx = (u - ou) * (width / height) * 1.4;
    var dz = (zc - 0.02) * 1.1;
    var d = Math.sqrt(dx * dx + dz * dz);
    var wave = Math.sin(d * 15 - t * 2.1) * Math.exp(-d * 2.1) * 1.15;

    // the water parts around the rising face (dip, raised rim) and rings out
    // from it while it moves
    var crown = 0;
    if (E > 0.003 || disturb > 0.003) {
      var fx = (u - face.u) * (width / height) * 1.4;
      var fz = (zc - face.zc) * 1.4;
      var fd = Math.sqrt(fx * fx + fz * fz);
      if (fd < 1.3) {
        var rim = (fd - 0.30) / 0.12;
        crown = E * (-0.35 * Math.exp(-(fd / 0.22) * (fd / 0.22)) + 0.5 * Math.exp(-rim * rim));
        crown += Math.sin(fd * 24 - t * 2.6) * Math.exp(-fd * 3.0) * disturb * 1.1;
      }
    }

    return swell * 0.42 + peaks * (0.5 + 0.5 * tide) + spikes * tide + wave + crown;
  }

  // ---------- the face, drawn between two water rows ----------
  var SHADE_CUTS = [0.42, 0.56, 0.68, 0.8];

  // One open (or blinking) eye. side: -1 for the left eye, +1 for the right.
  // Coordinates are in the face's local space.
  function drawEye(ex, ey, ew, eh, open, side, vis) {
    var inX = ex - side * ew, outX = ex + side * ew;
    var inY = ey + eh * 0.18, outY = ey - eh * 0.12;
    var h = eh * open;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (open < 0.07) {
      // lid shut: one soft curve
      ctx.beginPath();
      ctx.moveTo(inX, inY);
      ctx.quadraticCurveTo(ex, ey + eh * 0.3, outX, outY);
      ctx.strokeStyle = "rgb(190 215 255 / " + (0.7 * vis).toFixed(3) + ")";
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.restore();
      return;
    }

    var span = outX - inX;
    var upper = new Path2D();
    upper.moveTo(inX, inY);
    upper.bezierCurveTo(inX + span * 0.3, ey - h * 1.4, inX + span * 0.75, ey - h * 1.25, outX, outY);
    var lower = new Path2D();
    lower.moveTo(outX, outY);
    lower.bezierCurveTo(inX + span * 0.7, ey + h * 1.0, inX + span * 0.3, ey + h * 0.95, inX, inY);
    var eye = new Path2D();
    eye.addPath(upper);
    eye.addPath(lower);
    eye.closePath();

    ctx.save();
    ctx.clip(eye);

    // sclera: dim and cool, darker toward the corners so it sits in the socket
    var sg = ctx.createRadialGradient(ex, ey, 0, ex, ey, ew * 1.05);
    sg.addColorStop(0, "rgb(222 234 255 / " + (0.72 * vis).toFixed(3) + ")");
    sg.addColorStop(0.7, "rgb(150 180 235 / " + (0.6 * vis).toFixed(3) + ")");
    sg.addColorStop(1, "rgb(60 90 160 / " + (0.55 * vis).toFixed(3) + ")");
    ctx.fillStyle = sg;
    ctx.fillRect(ex - ew * 1.2, ey - eh * 2.5, ew * 2.4, eh * 5);

    // iris and pupil, shifted by gaze
    var ix = ex + life.gx * ew * 0.4;
    var iy = ey + life.gy * eh * 0.55 + eh * 0.05;
    var ir = ew * 0.4;
    var ig = ctx.createRadialGradient(ix, iy, ir * 0.15, ix, iy, ir);
    ig.addColorStop(0, "rgb(130 182 255 / " + (0.98 * vis).toFixed(3) + ")");
    ig.addColorStop(0.55, "rgb(62 112 232 / " + (0.98 * vis).toFixed(3) + ")");
    ig.addColorStop(1, "rgb(16 34 100 / " + (0.98 * vis).toFixed(3) + ")");
    ctx.fillStyle = ig;
    ctx.beginPath();
    ctx.arc(ix, iy, ir, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgb(2 6 18 / " + (0.96 * vis).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(ix, iy, ir * (0.4 + 0.12 * life.wide * 3), 0, TAU);   // pupils open wider in fear
    ctx.fill();

    // catchlights
    ctx.fillStyle = "rgb(255 255 255 / " + (0.95 * vis).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(ix - ir * 0.36, iy - ir * 0.4, ir * 0.2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgb(255 255 255 / " + (0.5 * vis).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(ix + ir * 0.3, iy + ir * 0.35, ir * 0.1, 0, TAU);
    ctx.fill();

    // shadow cast by the upper lid
    var lg = ctx.createLinearGradient(0, ey - h * 1.3, 0, ey + h * 0.2);
    lg.addColorStop(0, "rgb(2 6 18 / " + (0.7 * vis).toFixed(3) + ")");
    lg.addColorStop(1, "rgb(2 6 18 / 0)");
    ctx.fillStyle = lg;
    ctx.fillRect(ex - ew * 1.2, ey - eh * 2.5, ew * 2.4, eh * 3);
    ctx.restore();

    // lids
    ctx.strokeStyle = "rgb(205 224 255 / " + (0.9 * vis).toFixed(3) + ")";
    ctx.lineWidth = 1.5;
    ctx.stroke(upper);
    ctx.strokeStyle = "rgb(150 185 245 / " + (0.45 * vis).toFixed(3) + ")";
    ctx.lineWidth = 0.9;
    ctx.stroke(lower);
    ctx.strokeStyle = "rgb(205 224 255 / " + (0.7 * vis).toFixed(3) + ")";
    ctx.lineWidth = 1.2;
    ctx.beginPath();                                                // a hint of lash at the outer corner
    ctx.moveTo(outX, outY);
    ctx.lineTo(outX + side * ew * 0.1, outY - eh * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  function drawFace(t) {
    if (E < 0.003) return;
    var H = face.h, half = face.w * 0.5, n = face.n;
    var yaw = life.gx * 0.1 + Math.sin(t * 0.23) * 0.04 + 0.02;     // turns slightly toward what it watches
    var off = (1 - E) * H * 1.35;                                   // how far below the surface
    var cx = novaX + pointer * 14 + Math.sin(t * 0.31) * 5 * E;
    var cy = face.chinY + off + Math.sin(t * 1.7) * 1.4 * E;        // breathing
    var tilt = -0.06 * (1 - E) + Math.sin(t * 0.27) * 0.016 + life.gx * 0.025;
    var vis = Math.min(1, E * 2.4) * 0.8;
    var relief = H * 0.17;
    face.cx = cx;
    face.cy = cy;

    // soft light behind the head
    var hy = cy - H * 0.5, hr = H * 1.0;
    var hg = ctx.createRadialGradient(cx, hy, 0, cx, hy, hr);
    hg.addColorStop(0, rgba(0.2 * vis));
    hg.addColorStop(1, rgba(0));
    ctx.fillStyle = hg;
    ctx.fillRect(cx - hr, hy - hr, hr * 2, hr * 2);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tilt);

    // 1. depth grid
    var i, j, k;
    for (j = 0; j < n; j++) {
      var bj = FB0 + j * face.db;
      for (i = 0; i < FS; i++) faceGrid[j * FS + i] = faceD(FA0 + i * FDA, bj, yaw);
    }

    // 2. contour lines, top to bottom; each fills a band so lower lines hide upper ones
    var leftPts = [], rightPts = [];
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 0.9;
    var strokes = [
      rgba(0.2 * vis),
      rgba(0.42 * vis),
      "rgb(120 165 255 / " + (0.62 * vis).toFixed(3) + ")",
      "rgb(175 208 255 / " + (0.82 * vis).toFixed(3) + ")",
      "rgb(230 241 255 / " + (0.97 * vis).toFixed(3) + ")"
    ];
    for (j = 0; j < n; j++) {
      var b = FB0 + j * face.db;
      var hw = hwAt(b);
      if (hw <= 0.01) continue;
      var yBase = (b - 1) * H * 0.5;

      var m = 0;
      fxs[m] = -hw * half; fys[m] = yBase; fsh[m] = 0.6; m++;
      for (i = 0; i < FS; i++) {
        var a = FA0 + i * FDA;
        if (a <= -hw || a >= hw) continue;
        var idx = j * FS + i;
        var d = faceGrid[idx];
        var dx = (faceGrid[j * FS + Math.min(FS - 1, i + 1)] - faceGrid[j * FS + Math.max(0, i - 1)]) / (2 * FDA);
        var dy = ((j < n - 1 ? faceGrid[idx + FS] : d) - (j > 0 ? faceGrid[idx - FS] : d)) / (2 * face.db);
        var nx = -dx * 1.3, ny = -dy * 1.3;
        var sh = (nx * -0.45 + ny * -0.55 + 0.7) / Math.sqrt(nx * nx + ny * ny + 1);
        fxs[m] = a * half; fys[m] = yBase - d * relief; fsh[m] = sh; m++;
      }
      fxs[m] = hw * half; fys[m] = yBase; fsh[m] = 0.6; m++;
      if (m < 4) continue;

      leftPts.push(fxs[0], fys[0]);
      rightPts.push(fxs[m - 1], fys[m - 1]);

      // band that hides the lines behind this one
      var shift = face.sp * 1.7;
      ctx.beginPath();
      ctx.moveTo(fxs[0], fys[0]);
      for (k = 1; k < m; k++) ctx.lineTo(fxs[k], fys[k]);
      for (k = m - 1; k >= 0; k--) ctx.lineTo(fxs[k], fys[k] + shift);
      ctx.closePath();
      ctx.fillStyle = "rgb(6 12 28)";
      ctx.fill();

      // shade the segments into a few brightness bands, then stroke each band once
      for (k = 0; k < m - 1; k++) {
        var s = (fsh[k] + fsh[k + 1]) * 0.5;
        fbk[k] = s < SHADE_CUTS[0] ? 0 : s < SHADE_CUTS[1] ? 1 : s < SHADE_CUTS[2] ? 2 : s < SHADE_CUTS[3] ? 3 : 4;
      }
      for (var bk = 0; bk < 5; bk++) {
        ctx.beginPath();
        var any = false;
        for (k = 0; k < m - 1; k++) {
          if (fbk[k] !== bk) continue;
          ctx.moveTo(fxs[k], fys[k]);
          ctx.lineTo(fxs[k + 1], fys[k + 1]);
          any = true;
        }
        if (any) { ctx.strokeStyle = strokes[bk]; ctx.stroke(); }
      }
    }

    // 3. eyes, laid on the skin where the depth map puts them
    var ea = 0.4, eb = -0.13;
    var eyeY = (eb - 1) * H * 0.5;
    var ew = half * 0.2, eh = ew * 0.46;
    var open = Math.min(1.25, life.eye * (1 - life.blink) * (1 + life.wide));
    if (life.eye > 0.01) {
      drawEye(-ea * half, eyeY - faceD(-ea, eb, yaw) * relief, ew, eh, open, -1, vis);
      drawEye(ea * half, eyeY - faceD(ea, eb, yaw) * relief, ew, eh, open, 1, vis);
    }

    // 4. water running down the face
    for (i = 0; i < runners.length; i++) {
      var r = runners[i];
      for (k = 0; k < 7; k++) {
        var rb = r.b - k * 0.04;
        var rhw = hwAt(rb);
        if (rb < -0.95 || Math.abs(r.a) > rhw * 0.92) continue;
        var rx = r.a * half;
        var ry = (rb - 1) * H * 0.5 - faceD(r.a, rb, yaw) * relief;
        var ra = (1 - k / 7) * 0.85 * vis;
        ctx.fillStyle = "rgb(225 238 255 / " + ra.toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(rx, ry, k === 0 ? 1.7 : 1.1 * (1 - k / 9), 0, TAU);
        ctx.fill();
      }
    }

    // 5. a faint rim so the silhouette reads against the dark
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgb(190 215 255 / " + (0.3 * vis).toFixed(3) + ")";
    ctx.beginPath();
    for (k = 0; k < leftPts.length; k += 2) {
      if (k === 0) ctx.moveTo(leftPts[k], leftPts[k + 1]); else ctx.lineTo(leftPts[k], leftPts[k + 1]);
    }
    ctx.stroke();
    ctx.beginPath();
    for (k = 0; k < rightPts.length; k += 2) {
      if (k === 0) ctx.moveTo(rightPts[k], rightPts[k + 1]); else ctx.lineTo(rightPts[k], rightPts[k + 1]);
    }
    ctx.stroke();

    ctx.restore();
  }

  function drawField(t, dt) {
    var ou = novaX / width + pointer * 0.07;
    var step = width < 640 ? 7 : 5;
    var count = Math.ceil((width + 40) / step) + 1;
    var bottom = height * BOTTOM_K;

    // glitch scheduling: a short horizontal shear across a few rows
    if (!reduceMotion.matches) {
      if (!glitch && time > nextGlitch) {
        glitch = { from: 6 + Math.floor(Math.random() * 18), n: 2 + Math.floor(Math.random() * 3),
                   shift: (Math.random() < 0.5 ? -1 : 1) * (10 + Math.random() * 22), t: 0 };
      }
      if (glitch) {
        glitch.t += dt;
        if (glitch.t > 0.16) { glitch = null; nextGlitch = time + 5 + Math.random() * 7; }
      }
    }

    // horizon glow line
    var hg = ctx.createLinearGradient(0, 0, width, 0);
    hg.addColorStop(0, rgba(0)); hg.addColorStop(0.5, rgba(0.35)); hg.addColorStop(1, rgba(0));
    ctx.fillStyle = hg;
    ctx.fillRect(0, horizon - 0.5, width, 1);

    for (var r = 0; r < ROWS; r++) {
      // the face sits between the rows behind it and the rows that hide its submerged part
      if (r === face.row) drawFace(t);
      var z = r / (ROWS - 1);
      var y0 = horizon + (bottom - horizon) * Math.pow(z, 2.15);
      var amp = height * (0.008 + 0.15 * Math.pow(z, 1.85));
      var shear = 0;
      if (glitch && r >= glitch.from && r < glitch.from + glitch.n) shear = glitch.shift;

      var curve = new Path2D();
      for (var i = 0; i < count; i++) {
        var x = -20 + i * step;
        var u = (x + shear) / width;
        var y = y0 - ridge(u, z, t, ou) * amp;
        if (i === 0) curve.moveTo(x, y); else curve.lineTo(x, y);
      }

      // occlude whatever is behind this row
      var fillPath = new Path2D(curve);
      fillPath.lineTo(width + 20, bottom + 40);
      fillPath.lineTo(-20, bottom + 40);
      fillPath.closePath();
      ctx.fillStyle = bg;
      ctx.fill(fillPath);

      // soft under-glow then crisp line, brighter toward the viewer
      var a = 0.12 + 0.88 * Math.pow(z, 1.15);
      ctx.lineJoin = "miter";
      ctx.lineWidth = 1 + z * 4.5;
      ctx.strokeStyle = rgba(a * 0.12);
      ctx.stroke(curve);
      ctx.lineWidth = 0.8 + z * 1.2;
      ctx.strokeStyle = shear ? "rgb(210 228 255 / " + (a).toFixed(3) + ")" : rgba(a);
      ctx.stroke(curve);
    }

    // settle the bottom edge into the dark so the footer stays readable
    var fade = ctx.createLinearGradient(0, height * 0.88, 0, height);
    fade.addColorStop(0, "rgb(4 8 20 / 0)");
    fade.addColorStop(1, "rgb(4 8 20 / 0.92)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, height * 0.88, width, height * 0.12);
  }

  // ---------- frame ----------
  function draw(dt) {
    dt = dt || 0;
    var t = time;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    drawStars(t);
    if (!reduceMotion.matches) drawMeteor(dt);
    drawNova(t);
    drawField(t, dt);
  }

  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    time += dt;
    pointer += (pointerTarget - pointer) * Math.min(dt * 2.5, 1);

    prevE = E;
    E = emergence(time);
    var vel = dt > 0 ? Math.abs(E - prevE) / dt : 0;           // how fast it is moving through the water
    disturb += (Math.min(vel, 0.5) * 2.2 - disturb * 0.7) * dt;
    if (disturb < 0) disturb = 0;
    updateLife(time, dt);
    draw(dt);
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    cancelAnimationFrame(rafId);
    meteor = null; glitch = null;
    if (reduceMotion.matches) {
      time = 9.5; pointer = 0;
      E = 0.85; disturb = 0;                                    // still frame: face mostly risen
      life.eye = 1; life.gx = 0; life.gy = 0.05;                 // eyes open, looking at the viewer
      draw(0);
      return;
    }
    E = emergence(time);
    last = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", function (e) {
    pointerTarget = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = 1;
  }, { passive: true });
  reduceMotion.addEventListener("change", start);

  readColors();
  resize();
  start();
})();
