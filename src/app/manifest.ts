import type { MetadataRoute } from "next";

const icon = (src: string, sizes: string, purpose: "any" | "maskable") => ({
  src,
  sizes,
  type: "image/png",
  purpose,
});

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "SalonIt — ваша beauty-студия",
    short_name: "SalonIt",
    description:
      "Выбирайте услуги, собирайте свой визит и управляйте записями. Ваша личная beauty-студия в одном приложении.",
    lang: "ru",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#f6f4ef",
    theme_color: "#f6f4ef",
    categories: ["beauty", "lifestyle", "shopping"],
    prefer_related_applications: false,
    icons: [
      icon("/icons/icon-192.png", "192x192", "any"),
      icon("/icons/icon-512.png", "512x512", "any"),
      icon("/icons/icon-maskable-192.png", "192x192", "maskable"),
      icon("/icons/icon-maskable-512.png", "512x512", "maskable"),
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    screenshots: [
      {
        src: "/screenshots/home-narrow.png",
        sizes: "780x1688",
        type: "image/png",
        form_factor: "narrow",
        label: "Каталог услуг и ваш будущий визит",
      },
      {
        src: "/screenshots/home-wide.png",
        sizes: "1440x900",
        type: "image/png",
        form_factor: "wide",
        label: "SalonIt на большом экране",
      },
    ],
    shortcuts: [
      {
        name: "Записаться на визит",
        short_name: "Запись",
        description: "Выбрать услугу, мастера и свободное время",
        url: "/book",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Мои записи",
        short_name: "Мои записи",
        description: "Посмотреть предстоящие визиты и историю",
        url: "/account",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
