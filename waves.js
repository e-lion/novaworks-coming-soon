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

    return swell * 0.42 + peaks * (0.5 + 0.5 * tide) + spikes * tide + wave;
  }

  function drawField(t, dt) {
    var ou = novaX / width + pointer * 0.07;
    var step = width < 640 ? 7 : 5;
    var count = Math.ceil((width + 40) / step) + 1;
    var bottom = height * 1.08;

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
    draw(dt);
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    cancelAnimationFrame(rafId);
    meteor = null; glitch = null;
    if (reduceMotion.matches) {
      time = 9.5; pointer = 0;
      draw(0);
      return;
    }
    last = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", function (e) {
    pointerTarget = (e.clientX / window.innerWidth) * 2 - 1;
  }, { passive: true });
  reduceMotion.addEventListener("change", start);

  readColors();
  resize();
  start();
})();
