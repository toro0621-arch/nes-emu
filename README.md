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
- [x] 追加：ファミコンでよく使われるマッパーをまとめて対応（下の表）。VRC6・ナムコ 163・サンソフト 5B・MMC5 の拡張音源も鳴る

### 対応マッパー

| 番号 | チップ | 主なソフト |
|---|---|---|
| 0・1・2・3・4・7 | NROM・MMC1・UxROM・CNROM・MMC3・AxROM | 任天堂のソフトの大半 |
| 5 | MMC5（拡張 RAM・拡張属性・走査線 IRQ・音源） | 光栄のシミュレーション、ジャストブリード、メタルスレイダーグローリー |
| 9・10 | MMC2・MMC4 | パンチアウト!!、ファミコンウォーズ、ファイアーエムブレム |
| 16・153・159 | バンダイ FCG（EEPROM のセーブも） | ドラゴンボールZ、SDガンダム外伝、ファミコンジャンプII |
| 18 | ジャレコ SS88006 | 忍者じゃじゃ丸 銀河大作戦 など |
| 19・210 | ナムコ 163（波形メモリ音源）・175・340 | ドラゴンスピリット、三国志 中原の覇者、ワギャンランド2・3 |
| 21・22・23・25 | コナミ VRC2・VRC4 | がんばれゴエモン2、グラディウスII、ツインビー3 |
| 24・26 | コナミ VRC6（拡張音源） | 悪魔城伝説、魍魎戦記MADARA、エスパードリーム2 |
| 73・75・85 | コナミ VRC3・VRC1・VRC7 | 沙羅曼蛇、がんばれゴエモン！からくり道中、ラグランジュポイント（FM 音源は鳴らない） |
| 32・65・97 | アイレム G-101・H3001・TAM-S1 | イメージファイト、大工の源さん2、快傑ヤンチャ丸 |
| 33・48・80・82・207 | タイトー TC0190・TC0690・X1-005・X1-017 | 不動明王伝 など |
| 67・68・69・89・93・184 | サンソフト 1〜4・FME-7（5B 音源） | ギミック!、アフターバーナー、ファンタジーゾーン |
| 76・88・154・206 | ナムコ 108 系 | ナムコ・ナムコ系列の中期の作品 |
| 118・119 | MMC3 の仲間（TxSROM・TQROM） | アルマジロ、ピンボット |
| 11・34・38・66・70・71・72・78・79・86・87・92・94・101・113・140・152・180・185・232 | 汎用ロジックのマッパー | ホーリーダイバー、クレイジークライマー、戦場の狼 など |

まだ鳴らないもの：VRC7 の FM 音源（ラグランジュポイント）、MMC5 の画面分割（縦スプリット）。PPUMASK の色強調ビットも未対応。

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
| `src/mappers/` | マッパー。`base.ts` が土台（PRG 8KB×4・CHR 1KB×8 の切り替え表と、CPU サイクル・ネームテーブル・走査線・拡張音源のフック）、`mapper.ts` が番号→実装の表。`mapper0/1/2/4.ts`、`discrete.ts`（汎用ロジック）、`mmc2.ts`、`mmc3x.ts`、`mmc5.ts`、`vrc.ts`、`namco108.ts`、`namco163.ts`、`sunsoft.ts`、`bandai.ts`、`misc.ts`（ジャレコ・アイレム・タイトー） |
| `test/nestest.test.ts` | nestest の自動モードを公式ログと突き合わせる（PPU のタイミングも） |
| `test/ppu.test.ts` | blargg の PPU テスト（結果は画面の文字を読む。共通部分は `test/blargg.ts`） |
| `test/apu.test.ts` | blargg の APU テスト |
| `test/mappers.test.ts` | MMC1・MMC3 を使う blargg のテスト ROM |
| `test/mapper-units.test.ts` | 各マッパーのバンク切り替え・IRQ を直接確かめる |
| `test/mapper-more.test.ts` | あとから足したマッパー（VRC・ナムコ・サンソフト・バンダイの EEPROM・MMC5 など） |
| `test/sound.test.ts` | 出力波形から音の高さを測る（矩形波・三角波・ノイズ、ROM から鳴らした音） |

## ライセンス

MIT License（[LICENSE](LICENSE)）。ゲームの ROM は含まれていません。自分で持っているソフトから吸い出したものを使ってください。
