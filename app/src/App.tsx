import { useEffect, useState, type ComponentType } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ToastProvider } from "./lib/toast";
import { useT } from "./lib/i18n";
import { BulbIcon, CalendarIcon, GearIcon, MicIcon, PenIcon } from "./lib/icons";
import PostReminderHost from "./lib/PostReminderHost";
import Capture from "./screens/Capture";
import Drafts from "./screens/Drafts";
import Schedule from "./screens/Schedule";
import Workouts from "./screens/Workouts";
import Setup from "./screens/Setup";
import Agents from "./screens/Agents";
import SaltBubblePair from "./screens/SaltBubblePair";
import Insights from "./screens/Insights";
import Legal from "./screens/Legal";
import Desk from "./screens/Desk";
import { privyEnabled } from "./lib/privy-env";

const tabDefs = [
  { to: "/capture", key: "nav.capture" as const, icon: MicIcon, tour: "nav-capture" },
  { to: "/drafts", key: "nav.drafts" as const, icon: PenIcon, tour: "nav-drafts" },
  { to: "/schedule", key: "nav.schedule" as const, icon: CalendarIcon, tour: "nav-schedule" },
  { to: "/insights", key: "nav.insights" as const, icon: BulbIcon, tour: "nav-insights" },
  { to: "/setup", key: "nav.setup" as const, icon: GearIcon, tour: "nav-setup" },
];

function PrivyBinderHost() {
  const [Binder, setBinder] = useState<ComponentType | null>(null);
  useEffect(() => {
    if (!privyEnabled()) return;
    void import("./lib/privy").then((mod) => setBinder(() => mod.PrivyHubBinder));
  }, []);
  if (!Binder) return null;
  return <Binder />;
}

export default function App() {
  const t = useT();
  const location = useLocation();
  const isDesk = location.pathname.startsWith("/desk");
  const isSaltPair = location.pathname.startsWith("/salt-bubble");

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref) localStorage.setItem("refCode", ref.toUpperCase());
  }, []);

  return (
    <ToastProvider>
      <div className={isDesk ? "app app-desk" : "app"}>
        <Routes>
          <Route path="/" element={<Navigate to="/capture" replace />} />
          <Route path="/capture" element={<Capture />} />
          <Route path="/drafts" element={<Drafts />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/workouts" element={<Workouts />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/terms" element={<Legal kind="terms" />} />
          <Route path="/privacy" element={<Legal kind="privacy" />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/salt-bubble/pair" element={<SaltBubblePair />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/desk" element={<Desk />} />
          <Route path="*" element={<Navigate to="/capture" replace />} />
        </Routes>
      </div>
      {privyEnabled() ? <PrivyBinderHost /> : null}
      <PostReminderHost />
      {isDesk || isSaltPair ? null : (
        <nav className="nav">
          {tabDefs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              data-tour={tab.tour}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              <span className="nav-icon">
                <tab.icon size={21} />
              </span>
              {t(tab.key)}
            </NavLink>
          ))}
        </nav>
      )}
    </ToastProvider>
  );
}
