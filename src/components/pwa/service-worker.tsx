"use client";

import { useEffect } from "react";

/**
 * Registers the app-shell service worker in production builds only.
 *
 * The worker never calls skipWaiting on updates: a new version takes over the
 * next time every app tab is closed, so a deploy cannot reload a half-filled
 * booking form. Static assets and the offline page are refreshed then.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let disposed = false;
    let lastCheck = 0;
    let interval: number | undefined;
    let registration: ServiceWorkerRegistration | undefined;

    const register = async () => {
      try {
        registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        if (disposed) return;
        lastCheck = Date.now();
        interval = window.setInterval(() => {
          if (document.visibilityState !== "visible") return;
          lastCheck = Date.now();
          void registration?.update().catch(() => undefined);
        }, 60 * 60 * 1000);
      } catch {
        // Installability still depends on the manifest; a failed worker must
        // never break a page that otherwise works fine online.
      }
    };

    const checkForUpdate = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheck < 60 * 60 * 1000) return;
      lastCheck = Date.now();
      void registration?.update().catch(() => undefined);
    };

    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });
    document.addEventListener("visibilitychange", checkForUpdate);

    return () => {
      disposed = true;
      if (interval) window.clearInterval(interval);
      window.removeEventListener("load", register);
      document.removeEventListener("visibilitychange", checkForUpdate);
    };
  }, []);

  return null;
}
