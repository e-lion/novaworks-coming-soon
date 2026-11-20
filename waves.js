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
 * Every so often the ocean forms a face. It is not a separate object: it is a
 * depth relief that the ocean's own lines are pushed into.
 *   - the waves calm in a soft patch and the surface is displaced upward by the
 *     face's depth map, so the existing rows bulge into a face
 *   - extra fine contour lines fade in between the rows, only where the face is,
 *     so the water "densifies" into detail
 *   - it resolves out of coarse pixel steps (digital emergence), with a scan
 *     sweep passing over it, and dissolves back the same way
 *   - nearer wave lines still pass in front of it, hiding what is submerged
 *
 * Everything runs in one requestAnimationFrame loop with plain variables.
 * Reduced motion renders one still frame.
 */
(function () {
  "use strict";

  var canvas = document.getElementById("waves");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var TAU = Math.PI * 2;
  var ROWS = 34;
  var BOTTOM_K = 1.08; // ridge-field bottom edge as a multiple of viewport height

  var width = 0, height = 0, dpr = 1;
  var rgb = "91 140 255";
  var bg = "#040814";

  var time = 0, last = 0, rafId = 0;
  var pointer = 0, pointerTarget = 0;

  // Layout (recomputed on resize)
  var horizon = 0, bottomY = 0, novaX = 0, novaY = 0, novaR = 0, narrow = false;

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

  // ---------- the face: state ----------
  var face = { h: 0, w: 0, top: 0, cx: 0, eyeY: 0, u: 0, zc: 0, sp: 0, db: 0, n: 0 };
  var FS = 96, FA0 = -0.96, FDA = 1.92 / (FS - 1);  // samples across each fine line
  var FB0 = -0.99, FB1 = 1.95;                      // head top to shoulders, in face units
  var faceGrid = new Float32Array(0);
  var fxs = new Float32Array(FS + 2), fys = new Float32Array(FS + 2);
  var fsh = new Float32Array(FS + 2), fef = new Float32Array(FS + 2), fbk = new Uint8Array(FS + 2);
  var E = 0, prevE = 0, disturb = 0;                // emergence 0..1 and water disturbance

  // per-frame face parameters (set by prepFace)
  var Ee = 0, Ef = 0, Qd = 0, fyaw = 0, frelief = 0, scanF = 0, scanAmt = 0;

  // Live state read by the depth map and the eye glints
  var life = { eye: 0, blink: 0, brow: 0, furrow: 0, mouth: 0, wide: 0, gx: 0, gy: 0 };
  var mouse = { x: 0, y: 0, active: 0 };
  var blinkT = -1, nextBlink = 6;
  var glanceUntil = 0, glanceX = 0, glanceY = 0, nextGlance = 5;

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function clampN(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function sstep(a, b, x) { var t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
  function easeIO(x) {
    x = clamp01(x);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }
  function bump(p, c, w) { var d = (p - c) / w; return Math.exp(-d * d); }

  // One cycle: calm, the surface rises into a face, it lingers, then dissolves back.
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
    life.eye = sstep(0.6, 0.8, E);

    var gasp = bump(p, 8.7, 0.9);
    var strain = bump(p, 13.4, 1.5);
    var breath = 0.5 + 0.5 * Math.sin(t * 1.7);
    life.brow = 0.55 * bump(p, 8.9, 1.2) + 0.4 * strain;
    life.furrow = 0.7 * strain;
    life.mouth = clamp01(0.75 * gasp + 0.5 * strain + 0.1 * breath * life.eye);
    life.wide = 0.3 * strain + 0.15 * gasp;

    if (blinkT < 0 && t > nextBlink && life.eye > 0.9) blinkT = 0;
    if (blinkT >= 0) {
      blinkT += dt;
      var kb = blinkT / 0.2;
      if (kb >= 1) {
        blinkT = -1; life.blink = 0;
        nextBlink = t + 2.2 + Math.random() * 3.6;
        if (Math.random() < 0.18) nextBlink = t + 0.25;
      } else {
        life.blink = Math.sin(kb * Math.PI);
      }
    }

    // gaze: up at the nova, then at the viewer, then down at what is pulling it under
    var tx = 0, ty;
    if (p < 10) ty = -0.45 + 0.45 * sstep(0.8, 1, E);
    else if (p < 12.5) ty = 0.05;
    else ty = 0.05 + 0.65 * sstep(12.5, 14, p);

    if (mouse.active > 0.02) {
      var fx = clampN((mouse.x - face.cx) / (width * 0.45), -1, 1);
      var fy = clampN((mouse.y - face.eyeY) / (height * 0.45), -1, 1);
      var w = clamp01(mouse.active) * (p < 12.5 ? 0.9 : 0.4);
      tx += (fx - tx) * w;
      ty += (fy - ty) * w;
    }
    mouse.active = Math.max(0, mouse.active - dt / 5);

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
  }

  // ---------- the face: depth map ----------
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
    return (0.40 + 0.14 * sstep(1.0, 1.2, b) + 0.5 * sstep(1.15, 1.6, b)) * sstep(0.55, 0.95, b);
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

    // eyes: sockets, softer when open, with bags beneath
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

    // mouth: lips part when it gasps
    f += gau(af, b, 0, 0.36, 0.05, 0.06, -0.03);                  // philtrum
    f += gau(af, b, 0, 0.44 - 0.02 * mo, 0.20, 0.045, 0.07);      // upper lip
    f += gau(af, b, 0, 0.50, 0.22, 0.03 + 0.03 * mo, -0.10 - 0.14 * mo); // mouth line / opening
    f += gau(af, b, 0, 0.57 + 0.03 * mo, 0.17, 0.05, 0.075);      // lower lip
    f += gau(af, b, 0, 0.66, 0.15, 0.04, -0.04);                  // under-lip dip
    f += gau(af, b, 0, 0.78, 0.20, 0.10, 0.09);                   // chin

    var res = d + f * sstep(0, 0.45, edge);

    // wet hair: heavier mass above an uneven hairline and down the temples,
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
    bottomY = height * BOTTOM_K;
    novaX = width * (narrow ? 0.5 : 0.74);
    novaR = Math.min(width, height) * (narrow ? 0.05 : 0.055);
    novaY = horizon - novaR * 2.1;

    // The face lies in the ocean itself: head top just below the horizon,
    // chin and shoulders running down into the foreground.
    face.h = Math.min(height * (narrow ? 0.28 : 0.36), width * (narrow ? 0.58 : 0.5));
    face.w = face.h * 0.78;
    face.top = horizon + height * 0.012;
    face.cx = novaX;
    face.eyeY = face.top + (-0.13 + 1) * face.h * 0.5;
    face.u = novaX / width;
    var zMid = clamp01((face.top + face.h * 0.5 - horizon) / (bottomY - horizon));
    face.zc = Math.pow(zMid, 1 / 2.15);
    face.sp = Math.max(2.8, Math.min(4.4, face.h / 72));
    face.db = face.sp / (face.h * 0.5);
    var bEnd = Math.min(FB1, (height + 12 - face.top) / (face.h * 0.5) - 1);
    face.n = Math.max(0, Math.floor((bEnd - FB0) / face.db) + 1);
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

    // rings spreading out from the face while it forms and dissolves
    var ring = 0;
    if (disturb > 0.003) {
      var fx = (u - face.u) * (width / height) * 1.4;
      var fz = (zc - face.zc) * 1.4;
      var fd = Math.sqrt(fx * fx + fz * fz);
      if (fd < 1.3) ring = Math.sin(fd * 24 - t * 2.6) * Math.exp(-fd * 3.0) * disturb * 1.1;
    }

    return swell * 0.42 + peaks * (0.5 + 0.5 * tide) + spikes * tide + wave + ring;
  }

  // ---------- the face: how it bends the ocean ----------
  // Parameters shared by everything that draws the face this frame.
  function prepFace(t) {
    Ee = Math.pow(E, 1.1) * (1 + 0.025 * Math.sin(t * 1.7) * sstep(0.6, 1, E)); // relief, with a breath
    Ef = sstep(0.1, 0.45, E);                                                     // fine lines fade in
    Qd = 0.16 * Math.pow(1 - clamp01(E), 1.6);                                    // pixel size of the digital steps
    fyaw = life.gx * 0.1 + Math.sin(t * 0.23) * 0.04 + 0.02;
    frelief = face.h * 0.17;
    scanF = -1.15 + 3.2 * E;                                                      // sweep position, follows emergence both ways
    scanAmt = sstep(0.04, 0.14, E) * (1 - sstep(0.9, 1, E));
    face.cx = novaX + pointer * 14;
    face.eyeY = face.top + (-0.13 + 1) * face.h * 0.5;
  }

  // The waves calm in a soft patch around the face, so the relief reads cleanly.
  function calmAt(x, y) {
    if (E < 0.003) return 0;
    var dx = (x - face.cx) / (face.w * 0.9);
    if (dx > 1.4 || dx < -1.4) return 0;
    var dy = (y - (face.top + face.h * 0.95)) / (face.h * 1.15);
    var rr = Math.sqrt(dx * dx + dy * dy);
    return E * (1 - sstep(0.55, 1.2, rr));
  }

  // How far (px, upward) the face pushes the surface at a point of a coarse wave row.
  function faceDisp(x, y) {
    if (Ee < 0.003) return 0;
    var a = (x - face.cx) / (face.w * 0.5);
    if (a <= -1 || a >= 1) return 0;
    var b = (y - face.top) / (face.h * 0.5) - 1;
    if (b <= -1 || b > FB1) return 0;
    if (Qd > 0.012) { a = (Math.floor(a / Qd) + 0.5) * Qd; b = (Math.floor(b / Qd) + 0.5) * Qd; }
    return Ee * faceD(a, b, fyaw) * frelief;
  }

  // Depth for every fine line, once per frame. Steps in pixel blocks while it resolves.
  function fillFaceGrid() {
    var n = face.n, i, j;
    for (j = 0; j < n; j++) {
      var bj = FB0 + j * face.db;
      if (Qd > 0.012) bj = (Math.floor(bj / Qd) + 0.5) * Qd;
      for (i = 0; i < FS; i++) {
        var a = FA0 + i * FDA;
        if (Qd > 0.012) a = (Math.floor(a / Qd) + 0.5) * Qd;
        faceGrid[j * FS + i] = faceD(a, bj, fyaw);
      }
    }
  }

  // Fine contour line j: it follows the same waves as everything else, flattened
  // where the face forms, then pushed up by the depth map.
  var FINE_ALPHA = [0.07, 0.18, 0.33, 0.52, 0.74, 0.95];
  function drawFineLine(j, t, ou) {
    var H = face.h, half = face.w * 0.5, n = face.n;
    var b = FB0 + j * face.db;
    var hw = hwAt(b);
    if (hw <= 0.01) return;
    var yb = face.top + (b + 1) * H * 0.5;
    var z = Math.pow(clamp01((yb - horizon) / (bottomY - horizon)), 1 / 2.15);
    var amp = height * (0.008 + 0.15 * Math.pow(z, 1.85));
    var i, k;

    var m = 0;
    // left silhouette endpoint, then the interior samples, then the right endpoint
    for (i = -1; i <= FS; i++) {
      var a, d, sh;
      if (i === -1) { a = -hw; d = 0; sh = 0.6; }
      else if (i === FS) { a = hw; d = 0; sh = 0.6; }
      else {
        a = FA0 + i * FDA;
        if (a <= -hw || a >= hw) continue;
        var idx = j * FS + i;
        d = faceGrid[idx];
        var dx = (faceGrid[j * FS + Math.min(FS - 1, i + 1)] - faceGrid[j * FS + Math.max(0, i - 1)]) / (2 * FDA);
        var dy = ((j < n - 1 ? faceGrid[idx + FS] : d) - (j > 0 ? faceGrid[idx - FS] : d)) / (2 * face.db);
        var nx = -dx * 1.3, ny = -dy * 1.3;
        sh = (nx * -0.45 + ny * -0.55 + 0.7) / Math.sqrt(nx * nx + ny * ny + 1);
      }
      var x = face.cx + a * half;
      var ocean = ridge(x / width, z, t, ou) * amp * (1 - 0.9 * calmAt(x, yb));
      fxs[m] = x;
      fys[m] = yb - ocean - Ee * d * frelief;
      fsh[m] = sh;
      var edge = 1 - (a / hw) * (a / hw);
      fef[m] = sstep(0, 0.35, edge);
      m++;
    }
    if (m < 4) return;

    // band that hides what is behind this line (fades in with the face)
    var shift = face.sp * 1.7;
    ctx.beginPath();
    ctx.moveTo(fxs[0], fys[0]);
    for (k = 1; k < m; k++) ctx.lineTo(fxs[k], fys[k]);
    for (k = m - 1; k >= 0; k--) ctx.lineTo(fxs[k], fys[k] + shift);
    ctx.closePath();
    ctx.fillStyle = "rgb(4 8 20 / " + (Ef * 0.96).toFixed(3) + ")";
    ctx.fill();

    // brightness per segment: lit slopes glow, the scan sweep flares, edges fade into the waves
    var scan = Math.exp(-Math.pow((b - scanF) / 0.06, 2)) * scanAmt;
    var flick = 1 - (1 - E) * 0.55 * (Math.sin(t * 23 + j * 12.9898) > 0.6 ? 1 : 0);  // digital flicker while unresolved
    for (k = 0; k < m - 1; k++) {
      var shade = clamp01(((fsh[k] + fsh[k + 1]) * 0.5 - 0.35) / 0.6);
      var ed = (fef[k] + fef[k + 1]) * 0.5;
      var v = ((0.4 + 0.6 * shade) * ed + scan * 0.85) * flick;
      fbk[k] = Math.min(5, Math.floor(clamp01(v) * 5.999));
    }
    ctx.lineWidth = 0.9;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (var bk = 0; bk < 6; bk++) {
      ctx.beginPath();
      var any = false;
      for (k = 0; k < m - 1; k++) {
        if (fbk[k] !== bk) continue;
        ctx.moveTo(fxs[k], fys[k]);
        ctx.lineTo(fxs[k + 1], fys[k + 1]);
        any = true;
      }
      if (!any) continue;
      var al = FINE_ALPHA[bk] * Ef;
      ctx.strokeStyle = bk === 5 ? "rgb(190 216 255 / " + al.toFixed(3) + ")"
        : bk === 4 ? "rgb(122 170 255 / " + al.toFixed(3) + ")"
        : rgba(al);
      ctx.stroke();
    }
  }

  // Two small lights where the eyes are; they blink and follow the pointer.
  function drawGlints() {
    var open = Math.min(1.2, life.eye * (1 - life.blink) * (1 + life.wide));
    if (open < 0.06 || Ef < 0.05) return;
    var half = face.w * 0.5, ea = 0.4, eb = -0.13;
    var yEye = face.top + (eb + 1) * face.h * 0.5;
    for (var s = -1; s <= 1; s += 2) {
      var x = face.cx + s * ea * half + life.gx * half * 0.035;
      var y = yEye - Ee * faceD(s * ea, eb, fyaw) * frelief + life.gy * half * 0.02;
      var r = half * 0.1;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgb(205 226 255 / " + (0.6 * open * Ef).toFixed(3) + ")");
      g.addColorStop(1, rgba(0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.fillStyle = "rgb(240 247 255 / " + (0.95 * Math.min(1, open) * Ef).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.1, half * 0.017), 0, TAU);
      ctx.fill();
    }
  }

  function drawField(t, dt) {
    var ou = novaX / width + pointer * 0.07;
    var step = width < 640 ? 7 : 5;
    var count = Math.ceil((width + 40) / step) + 1;
    var bottom = bottomY;

    prepFace(t);
    var faceOn = E > 0.02 && face.n > 0;
    if (faceOn) fillFaceGrid();
    var nextFine = 0;
    var glintsDone = false;
    var eyeLine = Math.round((-0.13 - FB0) / face.db);
    var fcalm = face.w * 0.9 * 1.4;

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
      var z = r / (ROWS - 1);
      var y0 = horizon + (bottom - horizon) * Math.pow(z, 2.15);
      var amp = height * (0.008 + 0.15 * Math.pow(z, 1.85));
      var shear = 0;
      if (glitch && r >= glitch.from && r < glitch.from + glitch.n) shear = glitch.shift;

      // fine face lines that sit behind this row are drawn first (nearer rows hide their lower parts)
      if (faceOn) {
        while (nextFine < face.n && face.top + (FB0 + nextFine * face.db + 1) * face.h * 0.5 < y0) {
          drawFineLine(nextFine, t, ou);
          if (!glintsDone && nextFine >= eyeLine) { drawGlints(); glintsDone = true; }
          nextFine++;
        }
      }

      var near = faceOn && y0 > face.top - face.h * 0.2;
      var curve = new Path2D();
      var dimPaths = null, hwr = 0;
      if (near && Ef > 0.03) {
        // where this row crosses the head, how far the silhouette reaches (px from the centre line)
        var bRow = (y0 - face.top) / (face.h * 0.5) - 1;
        if (bRow > -1 && bRow < FB1) hwr = hwAt(bRow) * face.w * 0.5;
        if (hwr > 3) dimPaths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      }
      var prevX = 0, prevY = 0;
      for (var i = 0; i < count; i++) {
        var x = -20 + i * step;
        var u = (x + shear) / width;
        var h = ridge(u, z, t, ou) * amp;
        if (near && x > face.cx - fcalm && x < face.cx + fcalm) {
          h = h * (1 - 0.9 * calmAt(x, y0)) + faceDisp(x, y0);
        }
        var y = y0 - h;
        if (i === 0) curve.moveTo(x, y); else curve.lineTo(x, y);
        if (dimPaths && i > 0) {
          // sort each segment into one of four brightness steps by distance inside the silhouette
          var dd = Math.abs((prevX + x) * 0.5 - face.cx);
          var f = sstep(hwr * 0.85, hwr * 1.25, dd);
          var kp = Math.round(f * 3);
          dimPaths[kp].moveTo(prevX, prevY);
          dimPaths[kp].lineTo(x, y);
        }
        prevX = x; prevY = y;
      }

      // occlude whatever is behind this row
      var fillPath = new Path2D(curve);
      fillPath.lineTo(width + 20, bottom + 40);
      fillPath.lineTo(-20, bottom + 40);
      fillPath.closePath();
      ctx.fillStyle = bg;
      ctx.fill(fillPath);

      // soft under-glow then crisp line, brighter toward the viewer.
      // Where the face is, the coarse row steps back so the fine lines carry the features.
      var a = 0.12 + 0.88 * Math.pow(z, 1.15);
      ctx.lineJoin = "miter";
      var lineCol = shear ? "rgb(210 228 255 / " + a.toFixed(3) + ")" : rgba(a);
      if (!dimPaths) {
        ctx.lineWidth = 1 + z * 4.5;
        ctx.strokeStyle = rgba(a * 0.12);
        ctx.stroke(curve);
        ctx.lineWidth = 0.8 + z * 1.2;
        ctx.strokeStyle = lineCol;
        ctx.stroke(curve);
      } else {
        for (var pi = 0; pi < 4; pi++) {
          var am = (1 - 0.82 * Ef) + (0.82 * Ef) * (pi / 3);
          ctx.lineWidth = 1 + z * 4.5;
          ctx.strokeStyle = rgba(a * 0.12 * am);
          ctx.stroke(dimPaths[pi]);
          ctx.lineWidth = 0.8 + z * 1.2;
          ctx.strokeStyle = rgba(a * am);
          ctx.stroke(dimPaths[pi]);
        }
      }
    }

    // settle the bottom edge into the dark so the footer stays readable
    var fade = ctx.createLinearGradient(0, height * 0.92, 0, height);
    fade.addColorStop(0, "rgb(4 8 20 / 0)");
    fade.addColorStop(1, "rgb(4 8 20 / 0.8)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, height * 0.92, width, height * 0.08);
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
    var vel = dt > 0 ? Math.abs(E - prevE) / dt : 0;           // how fast the surface is changing
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
      E = 0.85; disturb = 0;                                    // still frame: face mostly formed
      life.eye = 1; life.gx = 0; life.gy = 0.05;                 // eyes lit, looking at the viewer
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
