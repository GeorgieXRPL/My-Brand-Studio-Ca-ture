// Thin wrapper around the Web Speech API (SpeechRecognition).
// Chrome / Edge on desktop, Chrome on Android, Safari on iOS 14.5+.
//
// iOS/Safari: SpeechRecognition will not prompt for the mic. Unlock with
// getUserMedia, then release the tracks before start().
// Desktop Chrome: start() must run in the same click as the button. Grabbing
// the mic with getUserMedia first steals the device and drops user activation,
// so the orb looks live but nothing is transcribed.

import { micErrorMessage, requestMicrophone } from "./mic";

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  onaudiostart?: ((e: any) => void) | null;
};

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function isVoiceSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export interface VoiceController {
  stop: () => void;
}

function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a + " " + b;
}

function wait(ms: number) {
  return new Promise((r) => window.setTimeout(r, ms));
}

function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

function needsMicUnlock(): boolean {
  const ua = navigator.userAgent;
  const iOS =
    /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const safari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox|CriOS|FxiOS/i.test(ua);
  return iOS || safari;
}

export function startlistening(
  handlers: {
    onTranscript: (finalText: string, interimText: string) => void;
    onError?: (message: string) => void;
    onEnd?: () => void;
  },
  opts?: { lang?: string }
): VoiceController {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    handlers.onError?.(
      "Voice input isn't supported in this browser. Use Chrome or Edge on a computer, Chrome on Android, or Safari on iPhone."
    );
    return { stop: () => {} };
  }

  let stopped = false;
  let committed = "";
  let active: SpeechRecognitionLike | null = null;
  const speechLang = opts?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "en-US";
  const continuous = !isAndroid();

  const beginSession = () => {
    if (stopped) return;
    const recognition = new Ctor();
    active = recognition;
    recognition.lang = speechLang;
    recognition.continuous = continuous;
    recognition.interimResults = true;
    if (typeof recognition.maxAlternatives === "number") recognition.maxAlternatives = 1;

    let sessionFinal = "";

    recognition.onresult = (event: any) => {
      sessionFinal = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const chunk = (event.results[i][0].transcript || "").trim();
        if (!chunk) continue;
        if (event.results[i].isFinal) {
          if (!sessionFinal.endsWith(chunk)) sessionFinal = join(sessionFinal, chunk);
        } else {
          interim += chunk + " ";
        }
      }
      handlers.onTranscript(join(committed, sessionFinal), interim.trim());
    };

    recognition.onerror = (e: any) => {
      const err = e?.error || "";
      if (err === "no-speech" || err === "aborted") return;
      if (err === "service-not-allowed" || err === "not-allowed" || err === "audio-capture") {
        handlers.onError?.(
          "Mic access was blocked. Allow Microphone for this site in the address bar (padlock or camera/mic icon)."
        );
      } else if (err === "network") {
        handlers.onError?.("Voice needs Chrome or Edge (not Chromium) and a network connection.");
      } else {
        handlers.onError?.(err || "Voice error");
      }
      stopped = true;
    };

    recognition.onend = () => {
      committed = join(committed, sessionFinal);
      sessionFinal = "";
      if (stopped) {
        handlers.onTranscript(committed, "");
        handlers.onEnd?.();
        return;
      }
      handlers.onTranscript(committed, "");
      window.setTimeout(() => beginSession(), continuous ? 80 : 120);
    };

    try {
      recognition.start();
    } catch {
      window.setTimeout(() => beginSession(), 150);
    }
  };

  if (needsMicUnlock()) {
    void (async () => {
      try {
        const stream = await requestMicrophone();
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        if (stopped) return;
        handlers.onError?.(micErrorMessage(e));
        handlers.onEnd?.();
        return;
      }
      if (stopped) return;
      await wait(80);
      if (stopped) return;
      beginSession();
    })();
  } else {
    beginSession();
  }

  return {
    stop: () => {
      stopped = true;
      try {
        active?.stop();
      } catch {
        handlers.onEnd?.();
      }
    },
  };
}
