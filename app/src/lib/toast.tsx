import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type ToastOptions = {
  /** Position over this element (e.g. the draft card the user tapped). */
  anchor?: Element | null;
};

type ToastFn = (msg: string, opts?: ToastOptions) => void;

const ToastContext = createContext<ToastFn>(() => {});

type ToastState = {
  msg: string;
  anchor: Element | null;
};

/** Map a point in the *visible* screen to position:fixed coordinates. */
function fixedPoint(clientX: number, clientY: number): { top: number; left: number } {
  const vv = window.visualViewport;
  if (!vv) return { top: clientY, left: clientX };
  // getBoundingClientRect / client coords are visual-viewport relative;
  // fixed top/left are layout-viewport relative — add visual offsets.
  return {
    top: clientY + vv.offsetTop,
    left: clientX + vv.offsetLeft,
  };
}

function computeStyle(anchor: Element | null): CSSProperties {
  const vv = window.visualViewport;
  const viewW = vv?.width ?? window.innerWidth;
  const viewH = vv?.height ?? window.innerHeight;
  const padX = 20;
  const padY = 72; // clear top chrome / bottom nav

  let clientX = viewW / 2;
  let clientY = viewH * 0.42;

  if (anchor && document.contains(anchor)) {
    const r = anchor.getBoundingClientRect();
    // Prefer the upper-middle of the open draft so the toast sits on the card in view.
    clientX = r.left + r.width / 2;
    clientY = r.top + Math.min(Math.max(r.height * 0.35, 56), 160);
  }

  // Keep inside the visible viewport
  clientX = Math.min(Math.max(clientX, padX), viewW - padX);
  clientY = Math.min(Math.max(clientY, padY), viewH - padY);

  const { top, left } = fixedPoint(clientX, clientY);

  return {
    position: "fixed",
    top,
    left,
    transform: "translate(-50%, -50%)",
    zIndex: 99999,
    width: "max-content",
    maxWidth: "min(92vw, 360px)",
    margin: 0,
    pointerEvents: "none",
  };
}

function ToastView({ msg, anchor }: ToastState) {
  const [style, setStyle] = useState<CSSProperties>(() => computeStyle(anchor));

  useLayoutEffect(() => {
    const update = () => setStyle(computeStyle(anchor));
    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, msg]);

  return createPortal(
    <div className="toast" role="status" aria-live="polite" style={style}>
      {msg}
    </div>,
    document.body
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | null>(null);

  const show = useCallback<ToastFn>((m, opts) => {
    setToast({ msg: m, anchor: opts?.anchor ?? null });
    if (timer.current) window.clearTimeout(timer.current);
    const ms = m.length > 48 ? 5200 : 2800;
    timer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && <ToastView msg={toast.msg} anchor={toast.anchor} />}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
