/**
 * Night city hero art, generated deterministically (seeded) so server and client markup match.
 * Echoes the reference design's blue-lit skyline without shipping a photo.
 */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Tower {
  x: number;
  w: number;
  h: number;
  spire: boolean;
  windows: { x: number; y: number; o: number }[];
}

function towers(seed: number, count: number, baseY: number, minH: number, maxH: number, focus: number, litRate: number): Tower[] {
  const r = rng(seed);
  const out: Tower[] = [];
  let x = -20;
  for (let i = 0; i < count && x < 1460; i++) {
    const w = 22 + Math.floor(r() * 46);
    // Taller toward the focal point, like a downtown core.
    const d = Math.abs(x + w / 2 - focus) / 720;
    const h = Math.floor(minH + (maxH - minH) * Math.max(0.12, 1 - d) * (0.45 + r() * 0.55));
    const windows: Tower["windows"] = [];
    for (let wy = baseY - h + 10; wy < baseY - 6; wy += 7) {
      for (let wx = x + 4; wx < x + w - 4; wx += 6) {
        if (r() < litRate) windows.push({ x: wx, y: wy, o: 0.35 + r() * 0.65 });
      }
    }
    out.push({ x, w, h, spire: h > maxH * 0.72 && r() > 0.5, windows });
    x += w + Math.floor(r() * 10) - 2;
  }
  return out;
}

export function Skyline({ className = "" }: { className?: string }) {
  const base = 470;
  const far = towers(7, 80, base - 40, 60, 210, 760, 0.02);
  const mid = towers(21, 70, base - 12, 70, 300, 720, 0.07);
  const near = towers(42, 60, base, 40, 380, 700, 0.11);
  return (
    <svg viewBox="0 0 1440 520" preserveAspectRatio="xMidYMax slice" className={className} aria-hidden>
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0a2533" />
          <stop offset="0.55" stopColor="#123c4e" />
          <stop offset="0.8" stopColor="#1a5873" />
          <stop offset="1" stopColor="#0d3141" />
        </linearGradient>
        <radialGradient id="glow" cx="0.5" cy="0.92" r="0.6">
          <stop offset="0" stopColor="#5bb8ea" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#2f86b8" stopOpacity="0.18" />
          <stop offset="1" stopColor="#2f86b8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" stopColor="#061a23" stopOpacity="0" />
          <stop offset="1" stopColor="#061a23" stopOpacity="1" />
        </linearGradient>
        <linearGradient id="trail" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#5bb8ea" stopOpacity="0" />
          <stop offset="0.5" stopColor="#9fdcff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#5bb8ea" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="1440" height="520" fill="url(#sky)" />
      <rect width="1440" height="520" fill="url(#glow)" className="city-glow" />

      <g fill="#0f3646" opacity="0.85">
        {far.map((t, i) => (
          <rect key={i} x={t.x} y={base - 40 - t.h} width={t.w} height={t.h} />
        ))}
      </g>
      <g fill="#0b2b38">
        {mid.map((t, i) => (
          <g key={i}>
            <rect x={t.x} y={base - 12 - t.h} width={t.w} height={t.h} />
            {t.spire && <rect x={t.x + t.w / 2 - 1} y={base - 12 - t.h - 26} width={2} height={26} />}
          </g>
        ))}
      </g>
      <g fill="#7cc8f0">
        {mid.flatMap((t, i) => t.windows.map((w, j) => <rect key={`${i}-${j}`} x={w.x} y={w.y - 12} width={2} height={3} opacity={w.o * 0.6} />))}
      </g>
      <g fill="#072029">
        {near.map((t, i) => (
          <g key={i}>
            <rect x={t.x} y={base - t.h} width={t.w} height={t.h + 60} />
            {t.spire && <rect x={t.x + t.w / 2 - 1.5} y={base - t.h - 38} width={3} height={38} />}
          </g>
        ))}
      </g>
      <g fill="#bfe6ff">
        {near.flatMap((t, i) => t.windows.map((w, j) => <rect key={`${i}-${j}`} x={w.x} y={w.y} width={2} height={3} opacity={w.o} />))}
      </g>

      {/* Light trails along the avenues */}
      <g fill="none" stroke="url(#trail)" strokeLinecap="round">
        <path d="M -40 505 C 300 470, 620 488, 860 478 S 1300 455, 1500 470" strokeWidth="1.6" opacity="0.8" />
        <path d="M -40 515 C 360 492, 700 505, 980 494 S 1320 482, 1500 488" strokeWidth="1" opacity="0.55" />
        <path d="M 200 520 C 480 482, 640 470, 760 440" strokeWidth="0.9" opacity="0.5" />
      </g>
      <rect width="1440" height="520" fill="url(#fade)" />
    </svg>
  );
}
