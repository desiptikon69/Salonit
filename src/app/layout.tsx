import type { Metadata, Viewport } from "next";
import { ServiceWorker } from "@/components/pwa/service-worker";
import { appleStartupImages } from "./pwa-assets";
import "./globals.css";
import "./public.css";
import "./workspace.css";
import "./studio-redesign.css";
import "./booking-redesign.css";
import "./workspace-redesign.css";
import "./pwa.css";

export const metadata: Metadata = {
  title: { default: "SalonIt — время для себя", template: "%s · SalonIt" },
  description:
    "Салон красоты и забота о вашем времени. Онлайн-запись на стрижку, маникюр, уход и другие услуги.",
  applicationName: "SalonIt",
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "SalonIt",
    statusBarStyle: "default",
    startupImage: appleStartupImages,
  },
  formatDetection: { telephone: false, email: false, address: false },
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f6f4ef",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" dir="ltr">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
