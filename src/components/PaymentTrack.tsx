/**
 * Hero art: payments as glowing cubes travelling a winding track, each heading to its own stop.
 * Pure SVG, black and white, coloured through theme variables so it works in light and dark.
 */
const TRACK =
  "M -60 492 C 70 470 150 430 250 432 C 360 434 420 470 520 452 C 620 434 650 360 590 322 C 530 284 430 316 360 300 C 280 282 270 220 330 190 C 390 160 500 176 560 150 C 610 128 620 92 600 60";

/** Isometric cube centred on (x, y): top, left and right faces. */
function Cube({ x, y, s, lit = false }: { x: number; y: number; s: number; lit?: boolean }) {
  const w = s * 0.87;
  const top = `${x},${y - s / 2} ${x + w},${y} ${x},${y + s / 2} ${x - w},${y}`;
  const left = `${x - w},${y} ${x},${y + s / 2} ${x},${y + s * 1.5} ${x - w},${y + s}`;
  const right = `${x + w},${y} ${x},${y + s / 2} ${x},${y + s * 1.5} ${x + w},${y + s}`;
  return (
    <g>
      {lit && <circle cx={x} cy={y + s * 0.6} r={s * 2.3} style={{ fill: "var(--qp-art-glow)" }} filter="url(#qp-blur)" />}
      <polygon points={left} style={{ fill: "var(--qp-art-cube)", fillOpacity: lit ? 0.62 : 0.28 }} />
      <polygon points={right} style={{ fill: "var(--qp-art-cube)", fillOpacity: lit ? 0.82 : 0.42 }} />
      <polygon points={top} style={{ fill: "var(--qp-art-cube)", fillOpacity: lit ? 1 : 0.6 }} />
      <polyline points={`${x - w},${y} ${x},${y + s / 2} ${x + w},${y}`} fill="none" style={{ stroke: "var(--qp-art-edge)" }} strokeWidth="0.8" />
      <line x1={x} y1={y + s / 2} x2={x} y2={y + s * 1.5} style={{ stroke: "var(--qp-art-edge)" }} strokeWidth="0.8" />
    </g>
  );
}

const CUBES = [
  { x: 90, y: 442, s: 15 },
  { x: 241, y: 415, s: 17, lit: true },
  { x: 393, y: 435, s: 15 },
  { x: 545, y: 430, s: 16, lit: true },
  { x: 606, y: 321, s: 14 },
  { x: 460, y: 288, s: 15, lit: true },
  { x: 312, y: 264, s: 14 },
  { x: 370, y: 164, s: 13 },
  { x: 523, y: 149, s: 12, lit: true },
];

export function PaymentTrack({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="-40 10 720 520" className={className} aria-hidden>
      <defs>
        <filter id="qp-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <linearGradient id="qp-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.15" />
          <stop offset="0.35" stopColor="#fff" stopOpacity="1" />
        </linearGradient>
        <mask id="qp-fade-mask">
          <rect x="-40" y="10" width="720" height="520" fill="url(#qp-fade)" />
        </mask>
      </defs>
      <g mask="url(#qp-fade-mask)">
        {/* Track: a wide band with bright rails and a dashed centre line. */}
        <path d={TRACK} fill="none" style={{ stroke: "var(--qp-art-rail)" }} strokeWidth="64" strokeLinecap="round" />
        <path d={TRACK} fill="none" style={{ stroke: "var(--qp-art-track)" }} strokeWidth="60" strokeLinecap="round" />
        <path d={TRACK} fill="none" style={{ stroke: "var(--qp-art-rail)" }} strokeWidth="44" strokeLinecap="round" strokeOpacity="0.35" />
        <path d={TRACK} fill="none" style={{ stroke: "var(--qp-art-track)" }} strokeWidth="42" strokeLinecap="round" />
        <path d={TRACK} fill="none" style={{ stroke: "var(--qp-art-rail)" }} strokeWidth="1.2" strokeDasharray="3 9" strokeOpacity="0.55" />
        {CUBES.map((c) => (
          <Cube key={`${c.x}-${c.y}`} {...c} />
        ))}
      </g>
    </svg>
  );
}
