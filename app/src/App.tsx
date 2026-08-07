import { useEffect } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./lib/toast";
import { useT } from "./lib/i18n";
import { BulbIcon, CalendarIcon, GearIcon, MicIcon, PenIcon } from "./lib/icons";
import Capture from "./screens/Capture";
import Drafts from "./screens/Drafts";
import Schedule from "./screens/Schedule";
import Workouts from "./screens/Workouts";
import Setup from "./screens/Setup";
import Agents from "./screens/Agents";
import Insights from "./screens/Insights";

const tabDefs = [
  { to: "/capture", key: "nav.capture" as const, icon: MicIcon, tour: "nav-capture" },
  { to: "/drafts", key: "nav.drafts" as const, icon: PenIcon, tour: "nav-drafts" },
  { to: "/schedule", key: "nav.schedule" as const, icon: CalendarIcon, tour: "nav-schedule" },
  { to: "/insights", key: "nav.insights" as const, icon: BulbIcon, tour: "nav-insights" },
  { to: "/setup", key: "nav.setup" as const, icon: GearIcon, tour: "nav-setup" },
];

export default function App() {
  const t = useT();

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref) localStorage.setItem("refCode", ref.toUpperCase());
  }, []);

  return (
    <ToastProvider>
      <div className="app">
        <Routes>
          <Route path="/" element={<Navigate to="/capture" replace />} />
          <Route path="/capture" element={<Capture />} />
          <Route path="/drafts" element={<Drafts />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/workouts" element={<Workouts />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="*" element={<Navigate to="/capture" replace />} />
        </Routes>
      </div>
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
    </ToastProvider>
  );
}
