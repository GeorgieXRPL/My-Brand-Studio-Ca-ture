import { useEffect, useRef, useState } from "react";

// Camera QR scanner built on the BarcodeDetector API (Chrome on Android).
export function isScanSupported(): boolean {
  return "BarcodeDetector" in window && Boolean(navigator.mediaDevices?.getUserMedia);
}

export default function QrScanner({
  onResult,
  onClose,
}: {
  onResult: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;

    if (!isScanSupported()) {
      setError("QR scanning isn't supported in this browser. Enter the hub details manually instead.");
      return;
    }

    const detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();

        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(video);
            if (codes.length > 0) {
              onResult(codes[0].rawValue as string);
              return;
            }
          } catch {
            /* detection can fail on early frames - keep trying */
          }
          timer = window.setTimeout(tick, 250);
        };
        tick();
      } catch {
        setError("Camera unavailable. Allow camera access, or enter the hub details manually.");
      }
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <div className="scan-overlay" role="dialog" aria-label="Scan setup code">
      {error ? (
        <div className="scan-error">
          <p>{error}</p>
          <button className="btn block" onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        <>
          <video ref={videoRef} className="scan-video" playsInline muted />
          <div className="scan-frame" aria-hidden="true" />
          <div className="scan-hint">Point at the QR code in your hub terminal</div>
          <button className="btn scan-close" onClick={onClose}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
