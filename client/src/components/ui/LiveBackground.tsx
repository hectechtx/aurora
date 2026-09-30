import { useEffect, useRef } from "react";

// A living-galaxy background — dependency-free, single canvas, sits fixed
// behind the whole app (see AppShell). It layers slow-drifting nebula clouds
// under a dense field of twinkling stars, with a handful of brighter glowing
// stars, all blended additively so overlaps bloom like real deep-space imagery.
// Drawn mostly in the theme's hues plus a couple of galaxy tones. Honors
// prefers-reduced-motion by drawing a single static frame.
export function LiveBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const cv = canvas;
    const ctx = context;

    const styles = getComputedStyle(document.documentElement);
    const primary = (styles.getPropertyValue("--primary") || "220 90% 60%").trim();
    const accent = (styles.getPropertyValue("--accent") || "280 80% 65%").trim();
    // A galaxy palette: the theme's two hues plus magenta/indigo/teal so the
    // nebula reads as deep space rather than a flat two-tone wash.
    const nebulaHues = [primary, accent, "320 80% 60%", "255 85% 62%", "190 85% 55%"];

    let width = 0, height = 0, t = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    type Star = { x: number; y: number; r: number; base: number; tw: number; phase: number; drift: number };
    type Neb = { x: number; y: number; vx: number; vy: number; r: number; c: string };
    type Hero = { x: number; y: number; r: number; c: string; phase: number };
    let stars: Star[] = [];
    let nebulae: Neb[] = [];
    let heroes: Hero[] = [];

    function resize() {
      width = cv.clientWidth;
      height = cv.clientHeight;
      cv.width = width * dpr;
      cv.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const starCount = Math.min(420, Math.round((width * height) / 3200));
      stars = Array.from({ length: starCount }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.2 + 0.3,
        base: Math.random() * 0.5 + 0.25,
        tw: Math.random() * 0.5 + 0.3,          // twinkle amount
        phase: Math.random() * Math.PI * 2,
        drift: (Math.random() - 0.5) * 0.04,     // gentle sideways drift
      }));

      nebulae = Array.from({ length: 6 }, (_, i) => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.09,
        vy: (Math.random() - 0.5) * 0.09,
        r: Math.min(width, height) * (0.3 + Math.random() * 0.25),
        c: nebulaHues[i % nebulaHues.length],
      }));

      heroes = Array.from({ length: Math.min(18, Math.round(starCount / 22)) }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.4 + 1,
        c: Math.random() > 0.5 ? primary : accent,
        phase: Math.random() * Math.PI * 2,
      }));
    }

    function drawNebulae() {
      ctx.globalCompositeOperation = "lighter";
      for (const n of nebulae) {
        n.x += n.vx; n.y += n.vy;
        if (n.x < -n.r) n.x = width + n.r; if (n.x > width + n.r) n.x = -n.r;
        if (n.y < -n.r) n.y = height + n.r; if (n.y > height + n.r) n.y = -n.r;
        // Slow breathing so the clouds feel alive, not static gradients.
        const pulse = 0.16 + 0.05 * Math.sin(t * 0.0006 + n.x * 0.01);
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
        g.addColorStop(0, `hsl(${n.c} / ${pulse})`);
        g.addColorStop(1, `hsl(${n.c} / 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
      }
      ctx.globalCompositeOperation = "source-over";
    }

    function draw() {
      ctx.clearRect(0, 0, width, height);
      drawNebulae();

      ctx.globalCompositeOperation = "lighter";
      // Twinkling starfield.
      for (const s of stars) {
        s.x += s.drift;
        if (s.x < 0) s.x = width; if (s.x > width) s.x = 0;
        const a = Math.max(0, s.base + s.tw * Math.sin(t * 0.002 + s.phase));
        ctx.fillStyle = `hsl(0 0% 100% / ${a})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Brighter glowing "hero" stars in the theme hues.
      for (const h of heroes) {
        const a = 0.5 + 0.5 * Math.sin(t * 0.0016 + h.phase);
        ctx.shadowColor = `hsl(${h.c} / 0.9)`;
        ctx.shadowBlur = 10;
        ctx.fillStyle = `hsl(${h.c} / ${0.5 + 0.4 * a})`;
        ctx.beginPath();
        ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "source-over";
    }

    resize();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { draw(); return; }

    let raf = 0;
    const loop = () => { t += 16; draw(); raf = requestAnimationFrame(loop); };
    loop();
    window.addEventListener("resize", resize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
    />
  );
}
