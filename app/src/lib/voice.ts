// Thin wrapper around the Web Speech API (SpeechRecognition).
// Works in Chrome on Android and Safari on iOS 14.5+ (needs Siri & Dictation
// enabled in iOS Settings). Gracefully reports when unsupported.

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
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

// Android Chrome's continuous mode is buggy: it re-delivers already-final
// results with a reset resultIndex, duplicating the opening words over and
// over. Instead we run short NON-continuous sessions and auto-restart when
// each one ends, committing the finished text between sessions ourselves.
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
    handlers.onError?.("Voice input isn't supported in this browser. Use Chrome on Android or Safari on iPhone.");
    return { stop: () => {} };
  }

  let stopped = false;
  let committed = ""; // text finalized in previous sessions
  let active: SpeechRecognitionLike | null = null;
  const speechLang = opts?.lang || "en-US";

  const beginSession = () => {
    if (stopped) return;
    const recognition = new Ctor();
    active = recognition;
    recognition.lang = speechLang;
    recognition.continuous = false;
    recognition.interimResults = true;

    let sessionFinal = "";

    recognition.onresult = (event: any) => {
      // Rebuild from the full result list every time; never trust resultIndex.
      sessionFinal = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const chunk = (event.results[i][0].transcript || "").trim();
        if (!chunk) continue;
        if (event.results[i].isFinal) {
          // Skip re-delivered duplicates of text we already have.
          if (!sessionFinal.endsWith(chunk)) sessionFinal = join(sessionFinal, chunk);
        } else {
          interim += chunk + " ";
        }
      }
      handlers.onTranscript(join(committed, sessionFinal), interim.trim());
    };

    recognition.onerror = (e: any) => {
      const err = e?.error || "";
      // Normal, recoverable events while waiting for speech - keep listening.
      if (err === "no-speech" || err === "aborted") return;
      if (err === "service-not-allowed" || err === "not-allowed") {
        // iOS: speech recognition rides on Siri's engine and mic permission.
        handlers.onError?.(
          "Mic access was blocked. Allow the microphone for this site — on iPhone also turn on Settings → Siri & Search → Dictation."
        );
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
      // Seamlessly roll into the next session until the user taps stop.
      beginSession();
    };

    try {
      recognition.start();
    } catch {
      // start() can throw if a previous session hasn't fully released the mic.
      window.setTimeout(() => beginSession(), 150);
    }
  };

  beginSession();

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
