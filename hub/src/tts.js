/**
 * Optional TTS for Imagine clips (Studio).
 * Uses xAI Grok TTS (POST /v1/tts) with XAI_API_KEY.
 * Docs: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
 */

export const TTS_VOICES = [
  {
    id: "eve",
    label: "Eve",
    vibe: "Energetic & upbeat",
    example: "Stop scrolling — this tip takes ten seconds and actually works.",
  },
  {
    id: "ara",
    label: "Ara",
    vibe: "Warm & conversational",
    example: "Hey, real talk — here's what I'd try first.",
  },
  {
    id: "rex",
    label: "Rex",
    vibe: "Confident & clear",
    example: "Three moves. Do these and you'll feel the difference today.",
  },
  {
    id: "sal",
    label: "Sal",
    vibe: "Smooth & balanced",
    example: "Quick walkthrough — keep it simple and stick with it.",
  },
  {
    id: "leo",
    label: "Leo",
    vibe: "Authoritative & strong",
    example: "Listen up. This is the part most people skip — and it matters.",
  },
];

export function ttsConfigured() {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

export function listTtsVoices() {
  return { configured: ttsConfigured(), voices: TTS_VOICES };
}

export function getVoiceMeta(voice) {
  const id = String(voice || "").toLowerCase();
  return TTS_VOICES.find((v) => v.id === id) || null;
}

export async function synthesizeSpeech(text, voice = "eve") {
  const key = (process.env.XAI_API_KEY || "").trim();
  if (!key) {
    const err = new Error("Voiceover is not configured on this hub.");
    err.status = 503;
    throw err;
  }
  const base = (process.env.XAI_BASE_URL || "https://api.x.ai").replace(/\/$/, "");
  const allowed = new Set(TTS_VOICES.map((v) => v.id));
  const voiceId = allowed.has(String(voice || "").toLowerCase())
    ? String(voice).toLowerCase()
    : "eve";
  const input = String(text || "").trim().slice(0, 900);
  if (!input) {
    const err = new Error("Nothing to narrate.");
    err.status = 400;
    throw err;
  }

  const res = await fetch(`${base}/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: input,
      voice_id: voiceId,
      language: process.env.TTS_LANGUAGE || "en",
      output_format: {
        codec: "mp3",
        sample_rate: 44100,
        bit_rate: 128000,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(body.slice(0, 200) || `TTS failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, mime: "audio/mpeg", ext: "mp3" };
}

/** Build narration from film labels (hook + beats = talk track). */
export function narrationFromLabels(labels = {}) {
  const parts = [labels.hook, ...(labels.beats || []).slice(0, 4)].filter(Boolean);
  return parts.join(". ").replace(/\s+/g, " ").trim().slice(0, 900);
}
