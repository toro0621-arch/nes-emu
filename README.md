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
- [x] 段階3：コントローラー・タッチボタン … 十字キー（8 方向・指を滑らせて切り替え）、A/B（間を押すと同時押し）、SELECT/START。PC はキーボード
- [x] 段階4：APU（音）… 矩形波 2・三角波・ノイズ・DMC、フレームカウンタと IRQ。blargg の apu_test 8 本すべて合格。Web Audio（AudioWorklet）で再生
- [x] 段階5：PWA … ホーム画面に追加して全画面で起動、オフラインでも動く、前回の ROM を自動で読み込み、プレイ中は画面を消さない
- [x] 段階6：マッパー 1（MMC1）・2（UxROM）・4（MMC3）… バッテリーバックアップのセーブにも対応。MMC1 を使う blargg のまとめ ROM と mmc3_test_2 に合格

## 操作
| NES | タッチ | キーボード |
|---|---|---|
| 十字キー | 左の十字キー（斜めも可） | 矢印キー |
| A / B | 右の赤いボタン（A と B の間で両方） | X / Z |
| START / SELECT | 下の細いボタン | Enter / Shift |

## スマホに入れる（PWA）
1. `npm run build` でできた `dist/` を HTTPS のサーバーに置く（GitHub Pages・Cloudflare Pages など。どの URL の下でも動く）
2. スマホのブラウザで開く
   - iPhone（Safari）：共有ボタン →「ホーム画面に追加」
   - Android（Chrome）：メニュー →「ホーム画面に追加」（または「アプリをインストール」）
3. 一度開けば、あとはオフラインでも起動できる。新しい版を置くと画面の上に「更新」が出る

ROM とセーブデータは端末の中（IndexedDB）にだけ保存し、どこにも送らない。セーブデータは ROM の中身ごとに分けて保存するので、ファイル名を変えても引き継がれる。アイコンは `python3 scripts/make-icons.py` で作り直せる。

## 音
スマホのブラウザは、画面に触れるまで音を出せません。最初のタップ（ボタンでも画面でも）で音が出始めます。🔊 ボタンで消音できます（設定は保存）。

## 構成
| ファイル | 内容 |
|---|---|
| `src/nes.ts` | 本体。`runFrame()` で 1 フレーム進める |
| `src/cpu.ts` | 6502。`step()` で 1 命令実行。命令の途中で `bus.tick` を呼び、PPU を同じ時間だけ進める |
| `src/ppu.ts` | 2C02。`tick()` で 1 ドット進める。画面は `frameBuffer`（256×240、RGBA） |
| `src/bus.ts` | CPU から見たメモリマップ、OAM DMA、NMI の検出 |
| `src/apu.ts` | 2A03 の音源。CPU 1 サイクルごとに `tick()`、出力は `takeSamples()` |
| `src/audio/` | Web Audio への出力（`output.ts`）とオーディオスレッドの再生器（`worklet.ts`） |
| `src/controller.ts` | 標準コントローラー（$4016/$4017） |
| `src/input/` | タッチボタン（`touch.ts`）とキーボード（`keyboard.ts`） |
| `src/main.ts` | 画面（canvas）と 60fps のループ、ROM の読み込み、PWA の更新のお知らせ |
| `src/storage.ts` | 最後に遊んだ ROM とセーブデータの保存（IndexedDB） |
| `src/wakelock.ts` | プレイ中に画面を消さない（Screen Wake Lock） |
| `vite.config.ts` | PWA の設定（manifest・Service Worker） |
| `src/cartridge.ts` | iNES ヘッダーの読み込み |
| `src/mappers/` | マッパー。`base.ts` が土台（PRG 8KB×4・CHR 1KB×8 の切り替え表）、`mapper0/1/2/4.ts` が各マッパー |
| `test/nestest.test.ts` | nestest の自動モードを公式ログと突き合わせる（PPU のタイミングも） |
| `test/ppu.test.ts` | blargg の PPU テスト（結果は画面の文字を読む。共通部分は `test/blargg.ts`） |
| `test/apu.test.ts` | blargg の APU テスト |
| `test/mappers.test.ts` | MMC1・MMC3 を使う blargg のテスト ROM |
| `test/mapper-units.test.ts` | 各マッパーのバンク切り替え・IRQ を直接確かめる |
| `test/sound.test.ts` | 出力波形から音の高さを測る（矩形波・三角波・ノイズ、ROM から鳴らした音） |

## ライセンス

MIT License（[LICENSE](LICENSE)）。ゲームの ROM は含まれていません。自分で持っているソフトから吸い出したものを使ってください。
