import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CameraIcon, StopIcon, VideoIcon, XCircleIcon } from "./icons";
import { useT } from "./i18n";

type Mode = "photo" | "video";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

type ZoomCaps = { min: number; max: number } | null;

function touchDist(a: Touch, b: Touch) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
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
  const pinchRef = useRef<{ active: boolean; startDist: number; startZoom: number }>({
    active: false,
    startDist: 0,
    startZoom: 1,
  });

  const [mode, setMode] = useState<Mode>("photo");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    zoomRef.current = zoom;
    const video = videoRef.current;
    if (video && !hwZoomRef.current) {
      video.style.transform = `scale(${zoom})`;
    }
  }, [zoom]);

  async function applyZoom(next: number) {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    zoomRef.current = clamped;
    setZoom(clamped);

    const track = streamRef.current?.getVideoTracks()[0];
    const caps = hwZoomRef.current;
    if (track && caps) {
      const hw = caps.min + ((clamped - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * (caps.max - caps.min);
      try {
        await track.applyConstraints({ advanced: [{ zoom: hw } as unknown as MediaTrackConstraintSet] });
        if (videoRef.current) videoRef.current.style.transform = "";
        return;
      } catch {
        /* fall through to digital zoom */
      }
    }
    if (videoRef.current) videoRef.current.style.transform = `scale(${clamped})`;
  }

  useEffect(() => {
    let cancelled = false;

    async function start() {
      setError("");
      setReady(false);
      hwZoomRef.current = null;
      zoomRef.current = 1;
      setZoom(1);
      // Soft constraints — avoid forcing 1080p which fails on some Ultra / fold sensors.
      const attempts: MediaStreamConstraints[] = [
        {
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: mode === "video",
        },
        {
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: mode === "video",
        },
        { video: { facingMode: "environment" }, audio: mode === "video" },
        { video: true, audio: mode === "video" },
      ];

      let lastErr: unknown;
      for (const constraints of attempts) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = stream;
          const track = stream.getVideoTracks()[0];
          const caps = track?.getCapabilities?.() as MediaTrackCapabilities & { zoom?: { min: number; max: number } };
          if (caps?.zoom && typeof caps.zoom.min === "number" && caps.zoom.max > caps.zoom.min) {
            hwZoomRef.current = { min: caps.zoom.min, max: caps.zoom.max };
          }
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.style.transform = "";
            await videoRef.current.play();
          }
          setReady(true);
          return;
        } catch (e) {
          lastErr = e;
        }
      }

      const e = lastErr as { name?: string };
      setError(
        e?.name === "NotAllowedError"
          ? t("Camera access was blocked. Allow the camera for this site in your browser settings.")
          : t("Couldn't open the camera on this device.")
      );
    }

    start();
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
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [mode]);

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
    const z = hwZoomRef.current ? 1 : zoomRef.current;
    const sw = vw / z;
    const sh = vh / z;
    const sx = (vw - sw) / 2;
    const sy = (vh - sh) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    canvas.getContext("2d")!.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
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
    const recOpts: MediaRecorderOptions = { mimeType: mime };
    if (typeof MediaRecorder !== "undefined") {
      // Prefer ~6–8 Mbps when the browser honors it.
      (recOpts as MediaRecorderOptions & { videoBitsPerSecond?: number }).videoBitsPerSecond = 7_000_000;
    }
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
          <button type="button" className="btn primary" onClick={onClose}>
            {t("Close")}
          </button>
        </div>
      ) : (
        <>
          <div ref={stageRef} className="camera-stage">
            <video ref={videoRef} className="camera-video" playsInline muted autoPlay />
            {ready && zoom > 1.02 && <div className="camera-zoom-hint">{zoom.toFixed(1)}×</div>}
          </div>
          <div className="camera-controls">
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
          </div>
        </>
      )}
    </div>,
    document.body
  );
}
