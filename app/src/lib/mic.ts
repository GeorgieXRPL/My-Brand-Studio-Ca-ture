/** Prompt for microphone access. SpeechRecognition on iOS/PWA does not do this itself. */

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

export async function requestMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    const err = new Error("Microphone isn't available in this browser.");
    err.name = "NotSupportedError";
    throw err;
  }
  try {
    return await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
  } catch (first) {
    const name = (first as { name?: string })?.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
      throw first;
    }
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

export function liveAudioTracks(stream: MediaStream | null | undefined): MediaStreamTrack[] {
  return (stream?.getAudioTracks() || []).filter((t) => t.readyState === "live");
}

export function enableAudioTracks(stream: MediaStream) {
  for (const t of stream.getAudioTracks()) t.enabled = true;
}

export function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "Mic access was blocked. Allow the microphone for this site. On iPhone: Settings → Apps → Safari → Microphone, and turn on Dictation.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone found on this device.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The microphone is in use by another app. Close it and try again.";
  }
  return "Couldn't open the microphone.";
}
