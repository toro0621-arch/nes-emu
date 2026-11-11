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

- [x] 追加：どこでもセーブ（ゲームごとに 3 スロット、画面のサムネイル付き）、ゲーム一覧（読み込んだ ROM を端末に覚えておく）、早送り（3 倍速）、PPUMASK の色強調

- [x] ゲームボーイ・ゲームボーイカラー（`src/gb/`）。同じアプリで .gb / .gbc を読み込むと自動で切り替わる。MBC1・2・3（時計つき）・5、倍速モード、HDMA に対応。blargg の cpu_instrs・instr_timing・mem_timing・mem_timing-2・halt_bug・interrupt_time に合格、dmg_sound は 01〜07 に合格（08〜12 は波形メモリと電源の細かい癖）

- [x] 追加：ゲーム一覧をフォルダ式に（ファミコン・ゲームボーイ）、白黒のゲームボーイのソフトに色をつける（ゲームボーイカラー本体の色づけをもとにした 12 種類＋白黒、ソフトごとに覚える）、ステレオ（ゲームボーイは実機どおり、ファミコンは矩形波 1 を左・2 を右へ少し寄せる。メニューで切り替え）

- [x] ワンダースワン・ワンダースワンカラー（`src/ws/`）。.ws / .wsc を読み込むと自動で切り替わる。白黒・カラー（2 ビット・4 ビット）、スプライトとウィンドウ、音（波形メモリ・PCM・スイープ・ノイズ・サウンド DMA）、SRAM と EEPROM のセーブ、時計。縦持ちのソフトは画面を回し、十字キーを Y ボタンに割り当てる。CPU は NEC V20 の実機テスト（SingleStepTests/v20）で確かめた（未定義のフラグを除き、ほぼすべて一致）
- [x] ゲームボーイアドバンス（`src/gba/`）。.gba を読み込むと自動で切り替わり、L・R ボタンが出る。CPU（ARM7TDMI。ARM と Thumb）、画面（モード 0〜5、回転拡大、スプライト、ウィンドウ、半透明・明るさ、モザイク）、DMA、タイマー、音（ゲームボーイと同じ 4 チャンネル＋ PCM の FIFO 2 つ）、セーブ（SRAM・フラッシュ 64K / 128K・EEPROM。ROM の中の印で見分ける）、カートリッジの時計。BIOS は任天堂のものではなく、一から書かれた互換の BIOS（[Cult-of-GBA BIOS](https://github.com/Cult-of-GBA/BIOS)、MIT）を使う。起動画面は飛ばす。CPU は jsmolka/gba-tests と FuzzARM（ランダムな 1 万命令）で確かめた
- [x] 追加：ゲームのセーブデータを .sav に書き出す・読み込む（全機種。ほかのエミュレータのセーブも使える）、GBA の「液晶っぽい色」（当時の液晶のように色を落ち着かせる）、GBA の待ちループ飛ばし（ゲームが値の変化を待ってくり返しているだけのときは、次の出来事まで時間を飛ばして軽くする）

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

まだ鳴らないもの：VRC7 の FM 音源（ラグランジュポイント）、MMC5 の画面分割（縦スプリット）。

## 操作
| NES | タッチ | キーボード |
|---|---|---|
| 十字キー | 左の十字キー（斜めも可） | 矢印キー |
| A / B | 右の赤いボタン（A と B の間で両方） | X / Z |
| START / SELECT | 下の細いボタン | Enter / Shift |
| L / R（ゲームボーイアドバンス） | 十字キーと A・B の上 | A / S |

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
| `src/gb/palettes.ts` | 白黒のソフトの色づけ（パレットと、題名からの「おまかせ」） |
| `src/ws/` | ワンダースワン。`cpu.ts`（V30MZ ＝ 8086 / 80186 互換）、`ws.ts`（メモリ・I/O ポート・割り込み・タイマー・ボタン・DMA・EEPROM・時計）、`display.ts`（画面）、`sound.ts`（音） |
| `src/gba/` | ゲームボーイアドバンス。`cpu.ts`（ARM7TDMI。命令のビットから引く表で ARM・Thumb を実行）、`gba.ts`（メモリ・I/O・DMA・タイマー・割り込み・待ち時間・1 フレームの流れ）、`ppu.ts`（画面。ライン単位で描く）、`apu.ts`（音）、`save.ts`（SRAM・フラッシュ・EEPROM・時計）、`bios.ts`（互換 BIOS） |
| `src/machine.ts` | ファミコンとゲームボーイを、アプリから同じように扱うための窓口（ROM の中身から本体を決める） |
| `src/gb/` | ゲームボーイ。`cpu.ts`（SM83。読み書き 1 回ごとに 1 M サイクル進める）、`gb.ts`（メモリ・タイマー・DMA・ボタン・倍速）、`ppu.ts`（画面。ライン単位で描く）、`apu.ts`（音）、`cart.ts`（MBC・時計） |
| `src/savestate.ts` | どこでもセーブ。CPU・PPU・APU・バス・マッパーのフィールドをたどって写し取り、書き戻す（ROM・関数・部品どうしの参照は写さない） |
| `src/mappers/` | マッパー。`base.ts` が土台（PRG 8KB×4・CHR 1KB×8 の切り替え表と、CPU サイクル・ネームテーブル・走査線・拡張音源のフック）、`mapper.ts` が番号→実装の表。`mapper0/1/2/4.ts`、`discrete.ts`（汎用ロジック）、`mmc2.ts`、`mmc3x.ts`、`mmc5.ts`、`vrc.ts`、`namco108.ts`、`namco163.ts`、`sunsoft.ts`、`bandai.ts`、`misc.ts`（ジャレコ・アイレム・タイトー） |
| `test/nestest.test.ts` | nestest の自動モードを公式ログと突き合わせる（PPU のタイミングも） |
| `test/ppu.test.ts` | blargg の PPU テスト（結果は画面の文字を読む。共通部分は `test/blargg.ts`） |
| `test/apu.test.ts` | blargg の APU テスト |
| `test/mappers.test.ts` | MMC1・MMC3 を使う blargg のテスト ROM |
| `test/mapper-units.test.ts` | 各マッパーのバンク切り替え・IRQ を直接確かめる |
| `test/ws.test.ts` | ワンダースワン：テスト用のプログラムをその場で組み立てて、割り込み・画面・ボタン・縦持ち・セーブを確かめる |
| `test/gba.test.ts` | ゲームボーイアドバンス：手で組み立てた小さなプログラム（画面・ボタン・L / R）、どこでもセーブ、EEPROM、jsmolka/gba-tests と FuzzARM |
| `test/gb.test.ts` | ゲームボーイ：blargg のテスト ROM、画面（スプライト・ウィンドウ・カラーのパレット）、MBC、どこでもセーブ |
| `test/savestate.test.ts` | セーブしたところから動かし直すと、画面・RAM・音が同じになるか |
| `test/mapper-more.test.ts` | あとから足したマッパー（VRC・ナムコ・サンソフト・バンダイの EEPROM・MMC5 など） |
| `test/sound.test.ts` | 出力波形から音の高さを測る（矩形波・三角波・ノイズ、ROM から鳴らした音） |

## ライセンス

MIT License（[LICENSE](LICENSE)）。ゲームボーイアドバンスの互換 BIOS（`src/gba/bios.ts`）は Cult-of-GBA BIOS（Copyright 2020 - 2021 DenSinH and fleroviux、MIT License。[public/THIRD-PARTY-NOTICES.txt](public/THIRD-PARTY-NOTICES.txt)）。ゲームの ROM は含まれていません。自分で持っているソフトから吸い出したものを使ってください。
