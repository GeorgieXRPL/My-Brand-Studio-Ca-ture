import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CameraIcon, StopIcon, SwitchCameraIcon, VideoIcon, XCircleIcon } from "./icons";
import { useT } from "./i18n";
import { enableAudioTracks, liveAudioTracks, requestMicrophone } from "./mic";

type Mode = "photo" | "video";
type Facing = "user" | "environment";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

type ZoomCaps = { min: number; max: number } | null;

function touchDist(a: Touch, b: Touch) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function defaultFacing(): Facing {
  if (typeof navigator === "undefined") return "user";
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "environment" : "user";
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function isFrontTrack(track: MediaStreamTrack | undefined, requested: Facing): boolean {
  const mode = track?.getSettings?.().facingMode;
  if (mode === "user" || mode === "environment") return mode === "user";
  return requested === "user";
}

async function pickDeviceId(want: Facing): Promise<string | null> {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    if (!cams.length) return null;
    const hit = cams.find((d) => {
      const n = d.label.toLowerCase();
      if (!n) return false;
      return want === "user"
        ? /front|user|face|facetime|webcam/.test(n)
        : /back|rear|environment|wide|ultra/.test(n);
    });
    return hit?.deviceId || null;
  } catch {
    return null;
  }
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
  const facingRef = useRef<Facing>(defaultFacing());
  const frontRef = useRef(facingRef.current === "user");
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

  facingRef.current = facing;

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
      stopStream(streamRef.current);
      streamRef.current = null;
      // iOS will not switch lenses unless the previous tracks are fully released.
      await new Promise((r) => window.setTimeout(r, 40));
      if (cancelled) return;

      const wantAudio = mode === "video";
      const want = facing;
      const deviceId = await pickDeviceId(want);
      const videoOnly: MediaStreamConstraints[] = [];
      if (deviceId) videoOnly.push({ video: { deviceId: { exact: deviceId } }, audio: false });
      videoOnly.push(
        {
          video: { facingMode: { ideal: want }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        },
        {
          video: { facingMode: { ideal: want }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        },
        { video: { facingMode: { ideal: want } }, audio: false },
        { video: true, audio: false }
      );
      const attempts: MediaStreamConstraints[] = wantAudio
        ? [
            ...videoOnly.map((c) => ({ ...c, audio: true })),
            ...videoOnly.map((c) => ({
              ...c,
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            })),
            ...videoOnly,
          ]
        : videoOnly;

      let lastErr: unknown;
      let stream: MediaStream | null = null;
      for (const constraints of attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (e) {
          lastErr = e;
        }
      }

      if (stream && wantAudio && !liveAudioTracks(stream).length) {
        try {
          const mic = await requestMicrophone();
          for (const t of mic.getAudioTracks()) stream.addTrack(t);
        } catch {
          /* record picture without sound */
        }
      }

      if (stream) {
        try {
          if (cancelled) {
            stopStream(stream);
            return;
          }
          enableAudioTracks(stream);
          streamRef.current = stream;
          setHasMic(!wantAudio || liveAudioTracks(stream).length > 0);
          const track = stream.getVideoTracks()[0];
          frontRef.current = isFrontTrack(track, want);
          const caps = track?.getCapabilities?.() as MediaTrackCapabilities & {
            zoom?: { min: number; max: number };
          };
          if (caps?.zoom && typeof caps.zoom.min === "number" && caps.zoom.max > caps.zoom.min) {
            hwZoomRef.current = { min: caps.zoom.min, max: caps.zoom.max };
          }
          const video = videoRef.current;
          if (video) {
            video.srcObject = stream;
            video.muted = true;
            video.playsInline = true;
            video.setAttribute("playsinline", "true");
            applyPreviewTransform();
            await video.play();
          }
          try {
            const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
            setCanFlip(cams.length > 1);
          } catch {
            setCanFlip(true);
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
          ? t("Camera or microphone was blocked. Allow both for this site in your browser settings.")
          : t("Couldn't open the camera on this device.")
      );
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
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, [mode, facing, t]);

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

  function flipCamera() {
    if (recording) return;
    setFacing((cur) => (cur === "user" ? "environment" : "user"));
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
            {ready && mode === "video" && !hasMic && (
              <div className="camera-mic-warn">{t("Microphone is off. Allow it for this site to record sound.")}</div>
            )}
          </div>
          <div className="camera-controls">
            <span className="camera-controls-slot" />
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
                <button
                  type="button"
                  className="camera-flip"
                  aria-label={t("Switch camera")}
                  disabled={!ready || recording}
                  onClick={flipCamera}
                >
                  <SwitchCameraIcon size={22} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>,
    document.body
  );
}
