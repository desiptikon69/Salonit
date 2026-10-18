import type { Metadata } from "next";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Нет подключения",
  description: "SalonIt временно недоступен без интернета.",
};

export default function OfflinePage() {
  return (
    <main className="pwa-offline">
      <section className="pwa-offline-card" aria-labelledby="offline-title">
        <Image src="/icons/icon-192.png" alt="" width={72} height={72} priority unoptimized />
        <p className="pwa-offline-kicker">SALONIT / НЕТ СЕТИ</p>
        <h1 id="offline-title">Связь пропала</h1>
        <p>Проверьте интернет — и мы продолжим с того же места.</p>
        {/* A client transition cannot recover an offline document, so this anchor must reload. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a className="pwa-offline-action" href="/">
          Попробовать снова
        </a>
        <small>Запись и профиль откроются, как только появится сеть.</small>
      </section>
    </main>
  );
}
