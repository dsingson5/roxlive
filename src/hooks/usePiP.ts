import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Picture-in-Picture mini window via canvas → captureStream → <video> PiP.
 *
 * This path works on BOTH desktop and mobile (Document PiP is desktop-only),
 * giving a borderless, movable OS window that floats over other apps — so the
 * user can watch YouTube etc. while still seeing their live metrics. We draw a
 * compact dashboard onto a hidden canvas each frame from a caller-supplied
 * paint function and stream it into the PiP video.
 */

export type PaintFn = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

export function pipSupported(): boolean {
  return typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled;
}

export function usePiP(paintRef: React.MutableRefObject<PaintFn>) {
  const [active, setActive] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const drawTimer = useRef<number | null>(null);

  const W = 640;
  const H = 360;

  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    paintRef.current(ctx, W, H);
    // paintRef is a stable ref; .current is read at call time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(async () => {
    if (drawTimer.current !== null) {
      clearInterval(drawTimer.current);
      drawTimer.current = null;
    }
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
    } catch {
      /* ignore */
    }
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) {
      video.current.srcObject = null;
      video.current.remove();
      video.current = null;
    }
    canvas.current = null;
    setActive(false);
  }, []);

  const start = useCallback(async () => {
    if (!pipSupported()) return false;
    // (re)create canvas + video
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    canvas.current = c;
    draw(); // paint one frame before capture so PiP opens populated

    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.style.position = "fixed";
    v.style.left = "-9999px";
    v.width = W;
    v.height = H;
    document.body.appendChild(v);
    video.current = v;

    const s = (c as HTMLCanvasElement).captureStream(12);
    stream.current = s;
    v.srcObject = s;

    try {
      await v.play();
      await v.requestPictureInPicture();
      setActive(true);
      v.addEventListener("leavepictureinpicture", () => void stop(), { once: true });
      drawTimer.current = window.setInterval(draw, 200); // ~5 fps refresh
      return true;
    } catch {
      await stop();
      return false;
    }
  }, [draw, stop]);

  const toggle = useCallback(() => (active ? void stop() : void start()), [active, start, stop]);

  useEffect(() => () => void stop(), [stop]);

  return { active, supported: pipSupported(), start, stop, toggle };
}
