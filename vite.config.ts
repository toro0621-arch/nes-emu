import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // どの URL の下に置いても動くように相対パス
  base: './',
  plugins: [
    VitePWA({
      // ゲーム中に勝手に再読み込みしないよう、新しい版があったら画面上で知らせて押してもらう
      registerType: 'prompt',
      injectRegister: false,
      // アイコンは下の globPatterns で保存するので、二重に登録しない
      includeManifestIcons: false,
      manifest: {
        name: 'NES Emu',
        short_name: 'NES Emu',
        description: 'スマホのブラウザで動くファミコン（NES）エミュレータ',
        lang: 'ja',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        scope: '.',
        background_color: '#16161d',
        theme_color: '#16161d',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 画面・スクリプト・音の再生器・アイコンをすべて先に保存し、オフラインでも開けるようにする（manifest はプラグインが足す）
        globPatterns: ['**/*.{html,js,css,png}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
