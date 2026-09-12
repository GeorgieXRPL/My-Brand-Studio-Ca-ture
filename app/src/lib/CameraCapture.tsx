import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CameraIcon, StopIcon, SwitchCameraIcon, VideoIcon, XCircleIcon } from "./icons";
import { useT } from "./i18n";
import { enableAudioTracks, liveAudioTracks, requestMicrophone } from "./mic";

type Mode = "photo" | "video";
type Facing = "user" | "environment";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const FACING_KEY = "bs.cameraFacing";

type ZoomCaps = { min: number; max: number } | null;

function isPhone() {
  return typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

function isAppleMobile() {
  return typeof navigator !== "undefined" && /iP(hone|ad)|Macintosh/.test(navigator.userAgent) && "ontouchend" in document;
}

function defaultFacing(): Facing {
  if (typeof navigator === "undefined") return "user";
  try {
    const saved = sessionStorage.getItem(FACING_KEY);
    if (saved === "user" || saved === "environment") return saved;
  } catch {
    /* ignore */
  }
  return isPhone() ? "environment" : "user";
}

function rememberFacing(facing: Facing) {
  try {
    sessionStorage.setItem(FACING_KEY, facing);
  } catch {
    /* ignore */
  }
}

function touchDist(a: Touch, b: Touch) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function facingFromTrack(track: MediaStreamTrack | undefined, requested: Facing): Facing {
  const mode = track?.getSettings?.().facingMode;
  if (mode === "user" || mode === "environment") return mode;
  const label = (track?.label || "").toLowerCase();
  if (!label) return requested;
  if (/front|face|facetime/.test(label) && !/back|rear/.test(label)) return "user";
  if (/back|rear/.test(label) && !/front/.test(label)) return "environment";
  return requested;
}

function streamLooksLike(stream: MediaStream, want: Facing): boolean {
  const track = stream.getVideoTracks()[0];
  const mode = track?.getSettings?.().facingMode;
  const label = (track?.label || "").toLowerCase();
  if (!mode && !label) return true;
  return facingFromTrack(track, want) === want;
}

async function pickDeviceId(want: Facing): Promise<string | null> {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    let best: { id: string; score: number } | null = null;
    for (const cam of cams) {
      const n = cam.label.toLowerCase();
      if (!n) continue;
      let score = 0;
      if (want === "user") {
        if (/front|face|facetime/.test(n) && !/back|rear/.test(n)) score = 10;
        else if (/webcam|user/.test(n) && !/back|rear|desk/.test(n)) score = 5;
      } else if (!/front|face|facetime/.test(n)) {
        if (/back camera|rear camera/.test(n)) score = 10;
        else if (/back|rear/.test(n)) score = /ultra|telephoto/.test(n) ? 4 : /wide|dual|triple/.test(n) ? 7 : 8;
      }
      if (score && (!best || score > best.score)) best = { id: cam.deviceId, score };
    }
    return best?.id || null;
  } catch {
    return null;
  }
}

async function openCamera(want: Facing, wantAudio: boolean): Promise<MediaStream> {
  const deviceId = await pickDeviceId(want);
  const videos: MediaTrackConstraints[] = [{ facingMode: { exact: want } }, { facingMode: want }];
  if (deviceId) {
    videos.push({ deviceId: { exact: deviceId }, facingMode: { exact: want } });
    videos.push({ deviceId: { exact: deviceId } });
  }
  videos.push({ facingMode: { ideal: want }, width: { ideal: 1280 }, height: { ideal: 720 } });
  videos.push({ facingMode: { ideal: want } });

  const audioOpts: Array<boolean | MediaTrackConstraints> = wantAudio
    ? [true, { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, false]
    : [false];

  let lastErr: unknown;
  for (const audio of audioOpts) {
    for (const video of videos) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video, audio });
        if (!streamLooksLike(stream, want)) {
          stopStream(stream);
          continue;
        }
        return stream;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error("no camera");
}

export default function CameraCapture({
  onCapture,
  onClose,
}: {
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const aliveRef = useRef(true);
  const zoomRef = useRef(1);
  const hwZoomRef = useRef<ZoomCaps>(null);
  const frontRef = useRef(defaultFacing() === "user");
  const pinchRef = useRef<{ active: boolean; startDist: number; startZoom: number }>({
    active: false,
    startDist: 0,
    startZoom: 1,
  });

  const [mode, setMode] = useState<Mode>("photo");
  const [facing, setFacing] = useState<Facing>(defaultFacing);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [canFlip, setCanFlip] = useState(true);
  const [hasMic, setHasMic] = useState(true);

  function previewTransform(): string {
    const mirror = frontRef.current ? "scaleX(-1)" : "";
    const z = !hwZoomRef.current && zoomRef.current > 1.01 ? `scale(${zoomRef.current})` : "";
    return [mirror, z].filter(Boolean).join(" ");
  }

  function applyPreviewTransform() {
    const video = videoRef.current;
    if (video) video.style.transform = previewTransform();
  }

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    zoomRef.current = zoom;
    applyPreviewTransform();
  }, [zoom]);

  async function applyZoom(next: number) {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    zoomRef.current = clamped;
    setZoom(clamped);

    const track = streamRef.current?.getVideoTracks()[0];
    const caps = hwZoomRef.current;
    if (track && caps && !frontRef.current) {
      const hw = caps.min + ((clamped - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * (caps.max - caps.min);
      try {
        await track.applyConstraints({
          advanced: [{ zoom: hw } as unknown as MediaTrackConstraintSet],
        });
        applyPreviewTransform();
        return;
      } catch {
        /* fall through to digital zoom */
      }
    }
    applyPreviewTransform();
  }

  useEffect(() => {
    let cancelled = false;

    async function start() {
      setError("");
      setReady(false);
      hwZoomRef.current = null;
      zoomRef.current = 1;
      setZoom(1);
      const video = videoRef.current;
      if (video) video.srcObject = null;
      stopStream(streamRef.current);
      streamRef.current = null;
      // iOS keeps the previous lens until tracks are fully released.
      await new Promise((r) => window.setTimeout(r, isAppleMobile() ? 280 : 80));
      if (cancelled) return;

      const wantAudio = mode === "video";
      const want = facing;

      let stream: MediaStream;
      try {
        stream = await openCamera(want, wantAudio);
      } catch (lastErr) {
        if (cancelled) return;
        const e = lastErr as { name?: string };
        setError(
          e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError"
            ? t("Camera access was blocked. Allow the camera for this site in your browser settings.")
            : want === "user"
              ? t("Couldn't switch to the selfie camera.")
              : t("Couldn't switch to the rear camera.")
        );
        return;
      }

      if (stream && wantAudio && !liveAudioTracks(stream).length) {
        try {
          const mic = await requestMicrophone();
          for (const track of mic.getAudioTracks()) stream.addTrack(track);
        } catch {
          /* record picture without sound */
        }
      }

      try {
        if (cancelled) {
          stopStream(stream);
          return;
        }
        enableAudioTracks(stream);
        streamRef.current = stream;
        setHasMic(!wantAudio || liveAudioTracks(stream).length > 0);
        const track = stream.getVideoTracks()[0];
        const actual = facingFromTrack(track, want);
        frontRef.current = actual === "user";
        rememberFacing(actual);
        const caps = track?.getCapabilities?.() as MediaTrackCapabilities & {
          zoom?: { min: number; max: number };
        };
        if (caps?.zoom && typeof caps.zoom.min === "number" && caps.zoom.max > caps.zoom.min) {
          hwZoomRef.current = { min: caps.zoom.min, max: caps.zoom.max };
        }
        const node = videoRef.current;
        if (node) {
          node.srcObject = stream;
          node.muted = true;
          node.playsInline = true;
          node.setAttribute("playsinline", "true");
          applyPreviewTransform();
          await node.play();
        }
        try {
          const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
          setCanFlip(isPhone() || cams.length > 1);
        } catch {
          setCanFlip(true);
        }
        setReady(true);
      } catch (e) {
        stopStream(stream);
        if (cancelled) return;
        const err = e as { name?: string };
        setError(
          err?.name === "NotAllowedError"
            ? t("Camera access was blocked. Allow the camera for this site in your browser settings.")
            : t("Couldn't open the camera on this device.")
        );
      }
    }

    void start();
    return () => {
      cancelled = true;
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }
      const node = videoRef.current;
      if (node) node.srcObject = null;
      stopStream(streamRef.current);
      streamRef.current = null;
    };
    // Restart only when the user changes photo/video or selfie/rear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, facing]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) {
        pinchRef.current.active = false;
        return;
      }
      e.preventDefault();
      pinchRef.current = {
        active: true,
        startDist: touchDist(e.touches[0], e.touches[1]),
        startZoom: zoomRef.current,
      };
    };

    const onMove = (e: TouchEvent) => {
      if (!pinchRef.current.active || e.touches.length !== 2) return;
      e.preventDefault();
      const ratio = touchDist(e.touches[0], e.touches[1]) / Math.max(pinchRef.current.startDist, 1);
      void applyZoom(pinchRef.current.startZoom * ratio);
    };

    const onEnd = () => {
      pinchRef.current.active = false;
    };

    stage.addEventListener("touchstart", onStart, { passive: false });
    stage.addEventListener("touchmove", onMove, { passive: false });
    stage.addEventListener("touchend", onEnd);
    stage.addEventListener("touchcancel", onEnd);
    return () => {
      stage.removeEventListener("touchstart", onStart);
      stage.removeEventListener("touchmove", onMove);
      stage.removeEventListener("touchend", onEnd);
      stage.removeEventListener("touchcancel", onEnd);
    };
  }, [ready]);

  function snapPhoto() {
    const video = videoRef.current;
    if (!video || !ready) return;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const z = hwZoomRef.current && !frontRef.current ? 1 : zoomRef.current;
    const sw = vw / z;
    const sh = vh / z;
    const sx = (vw - sw) / 2;
    const sy = (vh - sh) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (frontRef.current) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob || !aliveRef.current) return;
        onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }));
        onClose();
      },
      "image/jpeg",
      0.92
    );
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const mime = MediaRecorder.isTypeSupported("video/mp4")
      ? "video/mp4"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm";
    enableAudioTracks(stream);
    const recOpts: MediaRecorderOptions = { mimeType: mime, videoBitsPerSecond: 7_000_000 };
    if (liveAudioTracks(stream).length) recOpts.audioBitsPerSecond = 128_000;
    const rec = new MediaRecorder(stream, recOpts);
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      if (!aliveRef.current) return;
      const blob = new Blob(chunksRef.current, { type: mime });
      const ext = mime.includes("mp4") ? "mp4" : "webm";
      onCapture(new File([blob], `video-${Date.now()}.${ext}`, { type: mime.split(";")[0] }));
      onClose();
    };
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  function setLens(next: Facing) {
    if (recording || next === facing) return;
    setFacing(next);
    rememberFacing(next);
  }

  function flipCamera() {
    setLens(facing === "user" ? "environment" : "user");
  }

  return createPortal(
    <div className="camera-overlay" role="dialog" aria-label={t("Camera")}>
      <div className="camera-top">
        <button type="button" className="btn ghost sm icon-only" aria-label={t("Close camera")} onClick={onClose}>
          <XCircleIcon size={22} />
        </button>
        <div className="seg-row camera-modes">
          <button type="button" className={`seg ${mode === "photo" ? "on" : ""}`} onClick={() => !recording && setMode("photo")}>
            <CameraIcon size={15} /> {t("Photo")}
          </button>
          <button type="button" className={`seg ${mode === "video" ? "on" : ""}`} onClick={() => !recording && setMode("video")}>
            <VideoIcon size={15} /> {t("Video")}
          </button>
        </div>
      </div>

      {error ? (
        <div className="camera-error">
          <p>{error}</p>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={() => setFacing((cur) => (cur === "user" ? "environment" : "user"))}>
              {facing === "user" ? t("Try rear") : t("Try selfie")}
            </button>
            <button type="button" className="btn primary" onClick={onClose}>
              {t("Close")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div ref={stageRef} className="camera-stage">
            <video ref={videoRef} className="camera-video" playsInline muted autoPlay />
            {ready && (
              <div className="camera-lens" aria-hidden="true">
                {facing === "user" ? t("Selfie") : t("Rear")}
              </div>
            )}
            {ready && zoom > 1.02 && <div className="camera-zoom-hint">{zoom.toFixed(1)}×</div>}
            {ready && mode === "video" && !hasMic && (
              <div className="camera-mic-warn">{t("Microphone is off. Allow it for this site to record sound.")}</div>
            )}
            {!ready && !error && <div className="camera-switching">{t("Switching camera…")}</div>}
          </div>
          <div className="camera-controls">
            <div className="camera-controls-slot">
              {canFlip && (
                <button
                  type="button"
                  className={`camera-flip ${facing === "user" ? "selfie" : ""}`}
                  aria-label={t("Switch camera")}
                  disabled={!ready || recording}
                  onClick={flipCamera}
                >
                  <SwitchCameraIcon size={22} />
                </button>
              )}
            </div>
            {mode === "photo" ? (
              <button type="button" className="camera-shutter" aria-label={t("Take photo")} onClick={snapPhoto} disabled={!ready} />
            ) : recording ? (
              <button type="button" className="camera-shutter recording" aria-label={t("Stop recording")} onClick={stopRecording}>
                <StopIcon size={28} />
              </button>
            ) : (
              <button
                type="button"
                className="camera-shutter"
                aria-label={t("Start recording")}
                onClick={startRecording}
                disabled={!ready}
              >
                <span className="rec-dot" />
              </button>
            )}
            <div className="camera-controls-slot">
              {canFlip && (
                <div className="camera-lens-seg" role="group" aria-label={t("Switch camera")}>
                  <button
                    type="button"
                    className={`chip-btn ${facing === "environment" ? "on" : ""}`}
                    disabled={!ready || recording}
                    onClick={() => setLens("environment")}
                  >
                    {t("Rear")}
                  </button>
                  <button
                    type="button"
                    className={`chip-btn ${facing === "user" ? "on" : ""}`}
                    disabled={!ready || recording}
                    onClick={() => setLens("user")}
                  >
                    {t("Selfie")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>,
    document.body
  );
}
