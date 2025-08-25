import {
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import JSZip from "jszip";
import type { CSSProperties } from "react"; // ← type‑only import fixes TS with verbatimModuleSyntax

/**
 * Quick‑start:
 * ```tsx
 * <AvatarPlayer manifestUrl="/cdn/intro_avatar/manifest.json" />
 * ```
 *
 * Manifest JSON expected format (keys are case‑sensitive):
 * ```json
 * {
 *   "basePath": "/cdn/intro_avatar/",        // optional helper to prepend to relative assets
 *   "frames": ["0001.jpg", "0002.jpg", ...],
 *   "fps": 25,                                 // optional – defaults to 25
 *   "width": 640,                              // optional – canvas width override
 *   "height": 360,                             // optional – canvas height override
 *   "audio": "audio.ogg",                     // URL (relative or absolute)
 *   "zip": "frames.zip"                        // OPTIONAL – if present, all frames are inside this zip
 * }
 * ```
 *
 * ‼️  This component **pre‑loads** every frame into memory before starting playback; ideal for
 *     ≤ 400 frames @ 640×360. For longer clips switch to streaming spritesheets or HLS.
 */
export interface AvatarPlayerProps {
  /** URL pointing to the manifest JSON */
  manifestUrl: string;
  /** Frames per second. If omitted, value from manifest or 25. */
  fps?: number;
  /** CSS‑class for the wrapping div */
  className?: string;
  /** Inline styles for the wrapping div */
  style?: CSSProperties;
  /** Force a canvas width (px). If undefined uses manifest width or first frame natural width. */
  canvasWidth?: number;
  /** Auto‑repeat when reaches the last frame */
  loop?: boolean;
  /** Called once everything is buffered and ready to play */
  onReady?: () => void;
  /** Called when playback ends (and loop === false) */
  onEnd?: () => void;
  /** Generic fatal error handler */
  onError?: (err: unknown) => void;
}

interface Manifest {
  basePath: string;
  frames: string[];
  fps?: number;
  width?: number;
  height?: number;
  audio: string;
  zip?: string;
}





const MAX_CONCURRENT_REQUESTS = 8; // primitive throttling

export default function AvatarPlayer({
  manifestUrl,
  fps: fpsProp,
  className,
  style,
  canvasWidth,
  loop = false,
  onReady,
  onEnd,
  onError,
}: AvatarPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null); // ✓ provide initial value to satisfy TS
  const [isReady, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const framesRef = useRef<(ImageBitmap | HTMLImageElement)[]>([]);
  const manifestRef = useRef<Manifest | null>(null);
  const startTimeRef = useRef<number>(0);
  const currentFrameRef = useRef<number>(0);

  /**
   * draw current frame to canvas
   */



  const drawFrame = useCallback((index: number) => {
  const frame = framesRef.current[index];
  const ctx = canvasRef.current?.getContext("2d");
  if (!ctx || !frame) return;

  // Limpia el canvas antes de dibujar
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Dibuja la imagen escalada a todo el canvas
  ctx.drawImage(frame as CanvasImageSource, 0, 0, ctx.canvas.width, ctx.canvas.height);
}, []);


  /**
   * RAF loop – keeps video in sync with audio
   */
  const tick = useCallback(() => {
    const manifest = manifestRef.current;
    if (!manifest) return;

    const fps = fpsProp || manifest.fps || 25;
    const elapsed = (performance.now() - startTimeRef.current) / 1000; // seconds
    let frameIdx = Math.floor(elapsed * fps);

    if (frameIdx >= framesRef.current.length) {
      if (loop) {
        frameIdx = frameIdx % framesRef.current.length;
        if (audioRef.current && audioRef.current.ended) {
          audioRef.current.currentTime = 0;
          audioRef.current.play();
        }
      } else {
        drawFrame(framesRef.current.length - 1);
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        onEnd?.();
        return;
      }
    }

    if (frameIdx !== currentFrameRef.current) {
      currentFrameRef.current = frameIdx;
      drawFrame(frameIdx);
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [drawFrame, fpsProp, loop, onEnd]);

  /**
   * Fetch + decompress .zip if provided; otherwise fetch each frame
   */


  const loadFrames = useCallback(
    async (manifest: Manifest) => {
      const { basePath = "", frames, zip } = manifest;

      const base =
        basePath.length > 0
          ? new URL(basePath, window.location.origin).href
          : manifestUrl
            ? new URL(manifestUrl, window.location.origin).href
            : window.location.origin;

      if (zip) {
        const zipUrl = new URL(zip, base).href;
        const resp = await fetch(zipUrl);
        const blob = await resp.blob();
        const jszip = await JSZip.loadAsync(blob);
        const orderedNames = frames; // keep manifest order
        const bitmaps: (ImageBitmap | HTMLImageElement)[] = [];
        for (const name of orderedNames) {
          const file = jszip.file(name);
          if (!file) throw new Error(`Missing ${name} inside ZIP`);
          const fileBlob = await file.async("blob");
          const bmp = await createBitmap(fileBlob);
          bitmaps.push(bmp);
        }
        return bitmaps;
      }

      const queue: string[] = frames.map((fname) => new URL(fname, base).href);
      const results: (ImageBitmap | HTMLImageElement)[] = new Array(queue.length);

      let index = 0;
      async function worker() {
        while (index < queue.length) {
          const i = index++;
          const bmp = await fetch(queue[i])
            .then((r) => r.blob())
            .then(createBitmap);
          results[i] = bmp;
        }
      }

      await Promise.all(
        Array.from(
          { length: Math.min(MAX_CONCURRENT_REQUESTS, queue.length) },
          () => worker()
        )
      );

      return results;
    },
    [manifestUrl]
  );




  /**
   * top‑level effect: fetch manifest → load frames → prep audio → play
   */
  useEffect(() => {
    let isMounted = true;


    async function setup() {
      try {
        // 1. Manifest
        const manifest: Manifest = await fetch(manifestUrl).then((r) => r.json());
        if (!isMounted) return;
        manifestRef.current = manifest;

        // 2. Canvas sizing
        const width = canvasWidth || manifest.width || 1280;
        const height = manifest.height || (width * 9) / 16; // fallback 16:9
        if (canvasRef.current) {
          // Tamaño real del canvas (pixeles)
          canvasRef.current.width = width;
          canvasRef.current.height = height;

          // Tamaño CSS igual al tamaño real para evitar escalados
          canvasRef.current.style.width = `${width}px`;
          canvasRef.current.style.height = `${height}px`;

          // Opcional: display block para evitar espacio extra debajo
          canvasRef.current.style.display = "block";
        }

        // 3. Frames
        framesRef.current = await loadFrames(manifest);
        if (!isMounted) return;

        // 4. Audio
        const base =
          manifest.basePath && manifest.basePath.length > 0
            ? new URL(manifest.basePath, window.location.origin).href
            : manifestUrl
              ? new URL(manifestUrl, window.location.origin).href
              : window.location.origin;

        const audioUrl = new URL(manifest.audio, base).href;
        audioRef.current = new Audio(audioUrl);

        await new Promise<void>((resolve, reject) => {
          if (!audioRef.current) return reject("Audio no existe");
          const audio = audioRef.current;
          const onCanPlayThrough = () => {
            audio.removeEventListener("canplaythrough", onCanPlayThrough);
            resolve();
          };
          audio.addEventListener("canplaythrough", onCanPlayThrough);
          audio.load();
        });
        await audioRef.current.play();

        // 5. Ready!
        startTimeRef.current = performance.now();
        drawFrame(0);
        rafRef.current = requestAnimationFrame(tick);
        setReady(true);
        onReady?.();
      } catch (err) {
        if (isMounted) onError ? onError(err) : console.error(err);
      }
    }

    setup();

    return () => {
      isMounted = false;
      // cleanup
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      audioRef.current?.pause();
      framesRef.current.forEach((f) => {
        if (
          "close" in f &&
          typeof (f as unknown as { close: () => void }).close === "function"
        ) {
          (f as unknown as { close: () => void }).close();
        }
      });
      framesRef.current = [];
    };
  }, [manifestUrl, canvasWidth, loadFrames, drawFrame, tick, onReady, onError]);

  async function handleStart() {
    try {
      await audioRef.current?.play();
      startTimeRef.current = performance.now();
      rafRef.current = requestAnimationFrame(tick);
      setStarted(true);
    } catch (err) {
      console.error(err);
    }
  }


  return (
    <div className={className} style={style}>
      {!started ? (
        <button onClick={handleStart}>Iniciar avatar</button>
      ) : (
        <canvas ref={canvasRef} />
      )}
    </div>
  );
}



/** Utility – create bitmap or HTMLImage as fallback */
async function createBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    // @ts-ignore – TS may not know ImageBitmap is in window
    return await createImageBitmap(blob);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}


