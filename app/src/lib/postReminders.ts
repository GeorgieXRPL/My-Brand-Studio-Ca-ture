import type { Platform } from "./types";

const STORAGE_KEY = "brand.postReminders";
const NOTIFY_KEY = "brand.postReminders.notify";

export type PostReminder = {
  id: string;
  draftId: number;
  platform: Platform;
  scheduledAt: string;
  topic: string;
  preview: string;
  createdAt: string;
  /** Fired once when due (notification / popup). */
  notified?: boolean;
  done?: boolean;
};

function readAll(): PostReminder[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(rows: PostReminder[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  try {
    window.dispatchEvent(new Event("post-reminders-changed"));
  } catch {
    /* ignore */
  }
}

export function listReminders(): PostReminder[] {
  return readAll()
    .filter((r) => !r.done)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

export function addReminder(input: {
  draftId: number;
  platform: Platform;
  scheduledAt: string;
  topic: string;
  preview: string;
}): PostReminder {
  const row: PostReminder = {
    id: `pr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    draftId: input.draftId,
    platform: input.platform,
    scheduledAt: new Date(input.scheduledAt).toISOString(),
    topic: input.topic,
    preview: input.preview,
    createdAt: new Date().toISOString(),
  };
  const all = readAll();
  all.push(row);
  writeAll(all);
  return row;
}

export function cancelReminder(id: string) {
  writeAll(readAll().filter((r) => r.id !== id));
}

export function markReminderDone(id: string) {
  writeAll(readAll().map((r) => (r.id === id ? { ...r, done: true, notified: true } : r)));
}

export function markReminderNotified(id: string) {
  writeAll(readAll().map((r) => (r.id === id ? { ...r, notified: true } : r)));
}

/** Reminders due now (or overdue), not yet marked done. */
export function dueReminders(now = Date.now()): PostReminder[] {
  return listReminders().filter((r) => new Date(r.scheduledAt).getTime() <= now);
}

export function nextUnnotifiedDue(now = Date.now()): PostReminder | null {
  return (
    listReminders().find((r) => !r.notified && new Date(r.scheduledAt).getTime() <= now) || null
  );
}

export async function ensureNotifyPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") {
    localStorage.setItem(NOTIFY_KEY, "1");
    return true;
  }
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  const ok = result === "granted";
  if (ok) localStorage.setItem(NOTIFY_KEY, "1");
  return ok;
}

export function pushBrowserNotification(reminder: PostReminder, platformLabel: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification("Time to post", {
      body: `${platformLabel}: ${reminder.topic || "Your draft is ready to Share"}`,
      tag: reminder.id,
      icon: "/icon-192.png",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* ignore unsupported options */
  }
}
