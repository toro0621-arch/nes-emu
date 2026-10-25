# NES Emu

スマホのブラウザで動くファミコン（NES）エミュレータ。TypeScript + Vite。ROM は同梱しないので、自分の ROM ファイルを選んで遊ぶ。

## 使い方
```sh
npm install
npm run dev      # 開発サーバー
npm test         # テスト（初回はテスト用 ROM を test/roms/ にダウンロード）
npm run build
```

## 進捗
- [x] 段階1：CPU（6502、非公式命令を含む）… nestest.log と全 8991 命令が一致
- [x] 段階2：PPU（画面）… ドット単位で描画。blargg の PPU テスト 26 本すべて合格（VBlank/NMI のタイミング、スプライト0ヒットなど）
- [ ] 段階3：コントローラー・タッチボタン
- [ ] 段階4：APU（音）
- [ ] 段階5：PWA
- [ ] 段階6：マッパー 1・2・4

## 構成
| ファイル | 内容 |
|---|---|
| `src/nes.ts` | 本体。`runFrame()` で 1 フレーム進める |
| `src/cpu.ts` | 6502。`step()` で 1 命令実行。命令の途中で `bus.tick` を呼び、PPU を同じ時間だけ進める |
| `src/ppu.ts` | 2C02。`tick()` で 1 ドット進める。画面は `frameBuffer`（256×240、RGBA） |
| `src/bus.ts` | CPU から見たメモリマップ、OAM DMA、NMI の検出 |
| `src/main.ts` | 画面（canvas）と 60fps のループ |
| `src/cartridge.ts` | iNES ヘッダーの読み込み |
| `src/mappers/` | マッパー（今は 0 = NROM） |
| `test/nestest.test.ts` | nestest の自動モードを公式ログと突き合わせる（PPU のタイミングも） |
| `test/ppu.test.ts` | blargg の PPU テストを動かし、画面に出た結果を読む |
