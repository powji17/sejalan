'use client';

import dynamic from 'next/dynamic';

const SeJalanMap = dynamic(() => import('../components/SeJalanMap'), {
  ssr: false,
  loading: () => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        width: '100vw',
        background: '#f1f5f9',
        fontFamily: 'sans-serif',
        gap: '12px',
      }}
    >
      <div style={{ fontSize: '32px' }}>🚖</div>
      <div style={{ fontWeight: 700, color: '#1e293b' }}>Memuat Aplikasi SeJalan...</div>
      <div style={{ fontSize: '12px', color: '#64748b' }}>Menyiapkan basemap dan modul spasial WebGIS</div>
    </div>
  ),
});

export default function Home() {
  return (
    <main>
      <SeJalanMap />
    </main>
  );
}
