// Optional display scaling (Setup → Display size) + visualViewport helpers
// for fixed chrome if the browser applies its own zoom.

const TEXT_SCALE_KEY = "textScale";
export const MIN_TEXT_SCALE = 0.85;
export const MAX_TEXT_SCALE = 1.5;

function clamp(n: number) {
  return Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, n));
}

function applyScale(scale: number) {
  document.documentElement.style.setProperty("--text-scale", String(scale));
}

export function getTextScale(): number {
  const n = Number(localStorage.getItem(TEXT_SCALE_KEY) || "1");
  return Number.isFinite(n) ? clamp(n) : 1;
}

export function setTextScale(scale: number) {
  const next = clamp(scale);
  localStorage.setItem(TEXT_SCALE_KEY, String(next));
  applyScale(next);
  window.dispatchEvent(new CustomEvent("brand:textscale", { detail: next }));
  return next;
}

export function initTextScale() {
  applyScale(getTextScale());
}

function applyVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  root.style.setProperty("--vv-offset-top", `${vv.offsetTop}px`);
  root.style.setProperty("--vv-offset-left", `${vv.offsetLeft}px`);
  root.style.setProperty("--vv-height", `${vv.height}px`);
  root.style.setProperty("--vv-width", `${vv.width}px`);
  root.style.setProperty("--vv-scale", String(vv.scale));
  root.classList.toggle("is-zoomed", vv.scale > 1.01);
}

export function initViewportZoom() {
  applyVisualViewport();
  const vv = window.visualViewport;
  if (!vv) return () => {};
  vv.addEventListener("resize", applyVisualViewport);
  vv.addEventListener("scroll", applyVisualViewport);
  window.addEventListener("resize", applyVisualViewport);
  return () => {
    vv.removeEventListener("resize", applyVisualViewport);
    vv.removeEventListener("scroll", applyVisualViewport);
    window.removeEventListener("resize", applyVisualViewport);
  };
}
