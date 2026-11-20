/*
 * Swell wave field.
 * Layered sine waves that drift sideways (flow) while their height swells and
 * recedes on slow, offset cycles (ebb). The pointer gently nudges the phase so
 * the surface feels alive without touching React/DOM state: everything lives
 * in plain variables and one requestAnimationFrame loop.
 */
(function () {
  "use strict";

  var canvas = document.getElementById("waves");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var colorScheme = window.matchMedia("(prefers-color-scheme: light)");

  var width = 0, height = 0, dpr = 1;
  var rgb = "127 214 194";
  var alphaScale = 1;

  // Back layers are tall and slow, front layers are low and quick.
  var layers = [
    { base: 0.60, amp: 0.085, len: 1.35, speed: 0.050, ebb: 0.050, drift: 0.0, fill: 0.10, line: 0.22 },
    { base: 0.65, amp: 0.075, len: 1.05, speed: -0.070, ebb: 0.065, drift: 1.3, fill: 0.12, line: 0.28 },
    { base: 0.71, amp: 0.065, len: 0.85, speed: 0.090, ebb: 0.080, drift: 2.4, fill: 0.15, line: 0.34 },
    { base: 0.77, amp: 0.055, len: 0.70, speed: -0.115, ebb: 0.095, drift: 3.6, fill: 0.19, line: 0.42 },
    { base: 0.83, amp: 0.045, len: 0.55, speed: 0.140, ebb: 0.110, drift: 4.9, fill: 0.24, line: 0.55 },
    { base: 0.90, amp: 0.035, len: 0.42, speed: -0.170, ebb: 0.130, drift: 6.1, fill: 0.30, line: 0.70 }
  ];

  var TAU = Math.PI * 2;
  var time = 0;
  var last = 0;
  var pointer = 0;       // -1..1, eased toward target
  var pointerTarget = 0;
  var rafId = 0;

  function readColors() {
    var styles = getComputedStyle(document.documentElement);
    var v = styles.getPropertyValue("--wave-rgb").trim();
    if (v) rgb = v;
    var a = parseFloat(styles.getPropertyValue("--wave-alpha"));
    alphaScale = isNaN(a) ? 1 : a;
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function waveY(layer, i, x, t) {
    var k = (x / width) * TAU / layer.len;
    var phase = t * layer.speed * TAU + layer.drift + pointer * 0.8;

    // Ebb and flow: height breathes between 35% and 100%.
    var tide = 0.675 + 0.325 * Math.sin(t * layer.ebb * TAU + layer.drift * 1.7);

    // Whole sea level rises and falls very slowly.
    var level = Math.sin(t * 0.035 * TAU + i * 0.6) * 0.012;

    var y =
      Math.sin(k + phase) +
      0.45 * Math.sin(k * 1.9 - phase * 1.3 + i) +
      0.2 * Math.sin(k * 3.1 + phase * 0.7 - i * 2);

    return (layer.base + level) * height + y * layer.amp * height * tide;
  }

  function rgba(a) {
    return "rgb(" + rgb + " / " + (a * alphaScale).toFixed(3) + ")";
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    var step = width < 640 ? 6 : 4;

    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (var x = 0; x <= width + step; x += step) {
        ctx.lineTo(x, waveY(layer, i, x, time));
      }
      ctx.lineTo(width, height);
      ctx.closePath();

      var top = (layer.base - layer.amp * 1.6) * height;
      var grad = ctx.createLinearGradient(0, top, 0, height);
      grad.addColorStop(0, rgba(layer.fill));
      grad.addColorStop(1, rgba(layer.fill * 0.15));
      ctx.fillStyle = grad;
      ctx.fill();

      // Crest line, drawn on the same path points.
      ctx.beginPath();
      for (var cx = 0; cx <= width + step; cx += step) {
        var cy = waveY(layer, i, cx, time);
        if (cx === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
      }
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = rgba(layer.line);
      ctx.stroke();
    }
  }

  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    time += dt;
    pointer += (pointerTarget - pointer) * Math.min(dt * 2.5, 1);
    draw();
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    cancelAnimationFrame(rafId);
    if (reduceMotion.matches) {
      time = 6;           // a pleasant, fixed frame
      pointer = 0;
      draw();
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
  colorScheme.addEventListener("change", function () { readColors(); draw(); });

  readColors();
  resize();
  start();
})();
