"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import jsQR from "jsqr";
import { interpretScan } from "@/lib/scan";
import { Notice } from "@/components/ui";

/**
 * Reads a QuietPay QR code with the camera (on this device only; nothing is uploaded) and goes
 * where it points: Send for a username, personal link or address, Pay for a payment request.
 */
export function ScanFlow() {
  const router = useRouter();
  const video = useRef<HTMLVideoElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const frame = useRef<number | null>(null);
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState("");

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setOn(false);
  }, []);
  useEffect(() => stop, [stop]);

  const go = useCallback(
    (text: string) => {
      const r = interpretScan(text, window.location.host);
      if (r.kind === "error") {
        setError(r.message);
        return false;
      }
      stop();
      if (r.kind === "send") router.push(`/send?to=${encodeURIComponent(r.to)}`);
      else window.location.href = `/pay#${r.code}`;
      return true;
    },
    [router, stop],
  );

  async function start() {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      stream.current = s;
      const v = video.current!;
      v.srcObject = s;
      await v.play();
      setOn(true);
      let last = "";
      const tick = () => {
        const c = canvas.current;
        if (c && v.readyState >= 2 && v.videoWidth) {
          const w = Math.min(640, v.videoWidth);
          const h = Math.round((v.videoHeight / v.videoWidth) * w);
          c.width = w;
          c.height = h;
          const ctx = c.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(v, 0, 0, w, h);
          const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
          if (code?.data && code.data !== last) {
            last = code.data;
            if (go(code.data)) return;
          }
        }
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    } catch {
      setError("The camera isn't available. Allow camera access for this site, or paste the link below.");
      stop();
    }
  }

  return (
    <div className="mx-auto max-w-xl px-4 pt-6 sm:px-6">
      <h1 className="mb-6 font-display text-[2rem] font-bold leading-[1.08] tracking-[-0.03em] text-snow sm:text-[2.6rem]">Scan</h1>
      <div className="panel space-y-5 p-5 sm:p-7">
        <div className="relative aspect-square w-full overflow-hidden rounded-[1.25rem] border border-harbor bg-deep">
          <video ref={video} className={`h-full w-full object-cover ${on ? "" : "hidden"}`} playsInline muted aria-label="Camera" />
          {!on && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
              <p className="text-sm text-haze">Point your camera at a QuietPay QR code.</p>
              <button type="button" className="btn btn-primary" onClick={() => void start()}>
                Start camera
              </button>
            </div>
          )}
          {on && <div aria-hidden className="pointer-events-none absolute inset-[18%] rounded-2xl border-2 border-snow/80" />}
          <canvas ref={canvas} className="hidden" />
        </div>
        {on && (
          <button type="button" className="btn btn-quiet w-full" onClick={stop}>
            Stop camera
          </button>
        )}
        {error && <Notice tone="bad">{error}</Notice>}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            go(paste);
          }}
        >
          <label htmlFor="scan-paste" className="block text-sm font-medium text-snow">
            Or paste a link, @username or address
          </label>
          <input
            id="scan-paste"
            className="field font-mono text-base sm:text-xs"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <button type="submit" className="btn w-full" disabled={!paste.trim()}>
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
