# NES Emu

スマホのブラウザで動くファミコン（NES）エミュレータ。TypeScript + Vite。ROM は同梱しないので、自分の ROM ファイルを選んで遊ぶ。

## 使い方
```sh
npm install
npm run dev      # 開発サーバー
npm test         # テスト（初回はテスト用 ROM の nestest を test/roms/ にダウンロード）
npm run build
```

## 進捗
- [x] 段階1：CPU（6502、非公式命令を含む）… nestest.log と全 8991 命令が一致
- [ ] 段階2：PPU（画面）
- [ ] 段階3：コントローラー・タッチボタン
- [ ] 段階4：APU（音）
- [ ] 段階5：PWA
- [ ] 段階6：マッパー 1・2・4

## 構成
| ファイル | 内容 |
|---|---|
| `src/cpu.ts` | 6502。`step()` で 1 命令実行、サイクル数を返す |
| `src/bus.ts` | CPU から見たメモリマップ |
| `src/cartridge.ts` | iNES ヘッダーの読み込み |
| `src/mappers/` | マッパー（今は 0 = NROM） |
| `test/nestest.test.ts` | nestest の自動モードを公式ログと突き合わせる |
