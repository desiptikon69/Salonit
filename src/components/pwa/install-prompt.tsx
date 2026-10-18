"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Download, Share, X } from "lucide-react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const INSTALLED_KEY = "salonit.pwa.installed";
const DISMISSED_KEY = "salonit.pwa.install-dismissed";
const SEEN_KEY = "salonit.pwa.install-seen";
const DISMISS_FOR_MS = 1000 * 60 * 60 * 24 * 30;
const REPEAT_AFTER_MS = 1000 * 60 * 60 * 24 * 14;
const AUTO_OPEN_DELAY_MS = 7000;

function readTime(key: string) {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode can disable storage; the prompt still works for this visit.
  }
}

function inStandaloneMode() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIosDevice() {
  return (
    /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
    (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1)
  );
}

function isPhone() {
  return (
    window.matchMedia("(max-width: 760px)").matches ||
    window.matchMedia("(pointer: coarse)").matches
  );
}

export function InstallPrompt() {
  const pathname = usePathname();
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [open, setOpen] = useState(false);
  const [ios, setIos] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    setIos(isIosDevice());
    if (inStandaloneMode()) {
      setInstalled(true);
      return;
    }
    try {
      if (window.localStorage.getItem(INSTALLED_KEY) === "1") {
        setInstalled(true);
        return;
      }
    } catch {
      // Ignore unavailable storage.
    }

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      write(INSTALLED_KEY, "1");
      setInstalled(true);
      setOpen(false);
      setDeferred(null);
    };
    const onRequest = () => {
      if (inStandaloneMode()) return;
      try {
        if (window.localStorage.getItem(INSTALLED_KEY) === "1") return;
      } catch {
        // Storage can be unavailable; the explicit request still deserves an answer.
      }
      setOpen(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("salonit:install", onRequest);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("salonit:install", onRequest);
    };
  }, []);

  useEffect(() => {
    if (installed || pathname !== "/" || !isPhone()) return;
    const now = Date.now();
    if (now - readTime(DISMISSED_KEY) < DISMISS_FOR_MS) return;
    if (now - readTime(SEEN_KEY) < REPEAT_AFTER_MS) return;
    const timer = window.setTimeout(() => {
      write(SEEN_KEY, String(Date.now()));
      setOpen(true);
    }, AUTO_OPEN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [installed, pathname]);

  if (!open || installed) return null;

  const mode = deferred ? "prompt" : ios ? "ios" : "help";

  async function install() {
    if (!deferred) return;
    const event = deferred;
    setDeferred(null);
    try {
      await event.prompt();
      const choice = await event.userChoice;
      if (choice.outcome === "accepted") {
        write(INSTALLED_KEY, "1");
        setInstalled(true);
        setOpen(false);
      } else {
        close();
      }
    } catch {
      setOpen(true);
    }
  }

  function close() {
    write(DISMISSED_KEY, String(Date.now()));
    setOpen(false);
  }

  return (
    <aside className="pwa-prompt" role="dialog" aria-labelledby="pwa-prompt-title" aria-live="polite">
      <div className="pwa-prompt-mark" aria-hidden="true">
        <Image src="/icons/icon-192.png" alt="" width={46} height={46} />
      </div>
      <div className="pwa-prompt-body">
        <strong id="pwa-prompt-title">SalonIt на главном экране</strong>
        {mode === "prompt" && <p>Открывайте студию в одно касание — без адресной строки.</p>}
        {mode === "ios" && (
          <p>
            Нажмите <Share size={13} aria-hidden="true" /> «Поделиться», затем «На экран „Домой“».
          </p>
        )}
        {mode === "help" && <p>Откройте меню браузера и выберите «Установить приложение».</p>}
        <div className="pwa-prompt-actions">
          {mode === "prompt" ? (
            <button type="button" className="pwa-prompt-install" onClick={() => void install()}>
              <Download size={15} aria-hidden="true" /> Установить
            </button>
          ) : (
            <button type="button" className="pwa-prompt-install" onClick={close}>
              Понятно
            </button>
          )}
        </div>
      </div>
      <button type="button" className="pwa-prompt-close" onClick={close} aria-label="Закрыть подсказку">
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  );
}

/** Footer / account button that asks the global prompt to open. */
export function InstallTrigger({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event("salonit:install"))}
    >
      {children}
    </button>
  );
}
