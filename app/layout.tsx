import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SeJalan — Simulasi WebGIS Pemesanan Taksi Rute Pulang',
  description: 'Simulasi pemesanan taksi pulang menuju tempat mangkal berbasis WebGIS & analisis spasial buffer',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id">
      <head>
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
          crossOrigin=""
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
