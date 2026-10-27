import type { Cartridge } from '../cartridge';
import type { Mapper, MapperHost } from './base';
import { Mapper16 } from './bandai';
import {
  ChrAt6000,
  LatchMapper,
  Mapper11,
  Mapper140,
  Mapper180,
  Mapper185,
  Mapper232,
  Mapper3,
  Mapper34,
  Mapper38,
  Mapper66,
  Mapper7,
  Mapper71,
  Mapper72,
  Mapper79,
  Mapper86,
  Mapper97,
} from './discrete';
import { Mapper0 } from './mapper0';
import { Mapper1 } from './mapper1';
import { Mapper2 } from './mapper2';
import { Mapper4 } from './mapper4';
import { Mapper18, Mapper32, Mapper33, Mapper65, Mapper80, Mapper82 } from './misc';
import { Mapper9 } from './mmc2';
import { Mapper118, Mapper119 } from './mmc3x';
import { Mapper5 } from './mmc5';
import { Mapper19, Mapper19Nt } from './namco163';
import { Mapper206 } from './namco108';
import { Mapper67, Mapper68, Mapper69 } from './sunsoft';
import { Mapper24, Mapper73, Mapper75, Mapper85, Vrc24 } from './vrc';

export type { Mapper, MapperHost } from './base';

type MapperClass = new (cart: Cartridge, host: MapperHost) => Mapper;

/** マッパー番号 → 実装（主なソフトはコメント） */
const MAPPERS: Record<number, MapperClass> = {
  0: Mapper0, // NROM
  1: Mapper1, // MMC1
  2: Mapper2, // UxROM
  3: Mapper3, // CNROM
  4: Mapper4, // MMC3
  5: Mapper5, // MMC5
  7: Mapper7, // AxROM
  9: Mapper9, // MMC2
  10: Mapper9, // MMC4
  11: Mapper11, // Color Dreams
  16: Mapper16, // バンダイ FCG
  18: Mapper18, // ジャレコ SS88006
  19: Mapper19Nt, // ナムコ 163
  21: Vrc24, // VRC4
  22: Vrc24, // VRC2
  23: Vrc24, // VRC2・VRC4
  24: Mapper24, // VRC6
  25: Vrc24, // VRC2・VRC4
  26: Mapper24, // VRC6
  32: Mapper32, // アイレム G-101
  33: Mapper33, // タイトー TC0190
  34: Mapper34, // BNROM・NINA-001
  38: Mapper38,
  48: Mapper33, // タイトー TC0690
  65: Mapper65, // アイレム H3001
  66: Mapper66, // GxROM
  67: Mapper67, // サンソフト 3
  68: Mapper68, // サンソフト 4
  69: Mapper69, // サンソフト FME-7
  70: LatchMapper, // バンダイ
  71: Mapper71, // Camerica
  72: Mapper72, // ジャレコ JF-17
  73: Mapper73, // VRC3
  75: Mapper75, // VRC1
  76: Mapper206, // ナムコ 109
  78: LatchMapper, // アイレム・ジャレコ
  79: Mapper79, // NINA-03/06
  80: Mapper80, // タイトー X1-005
  82: Mapper82, // タイトー X1-017
  85: Mapper85, // VRC7
  86: Mapper86, // ジャレコ JF-13
  87: ChrAt6000, // ジャレコ・コナミ
  88: Mapper206, // ナムコ 118
  89: LatchMapper, // サンソフト 2
  92: Mapper72, // ジャレコ JF-19
  93: LatchMapper, // サンソフト 2
  94: LatchMapper, // 戦場の狼
  97: Mapper97, // アイレム TAM-S1
  101: ChrAt6000,
  113: Mapper79, // NINA-03/06
  118: Mapper118, // TxSROM
  119: Mapper119, // TQROM
  140: Mapper140, // ジャレコ JF-11/14
  152: LatchMapper, // バンダイ・タイトー
  153: Mapper16, // バンダイ（ファミコンジャンプII）
  154: Mapper206, // ナムコ 129
  159: Mapper16, // バンダイ（24C01）
  180: Mapper180, // クレイジークライマー
  184: ChrAt6000, // サンソフト 1
  185: Mapper185, // CNROM + プロテクト
  206: Mapper206, // ナムコ 108
  207: Mapper80, // タイトー X1-005（不動明王伝）
  210: Mapper19, // ナムコ 175・340
  232: Mapper232, // Camerica
};

/** 対応しているマッパー番号 */
export const SUPPORTED_MAPPERS = Object.keys(MAPPERS).map(Number);

export function createMapper(cart: Cartridge, host: MapperHost): Mapper {
  const M = MAPPERS[cart.mapper];
  if (!M) throw new Error(`マッパー ${cart.mapper} には未対応です`);
  return new M(cart, host);
}
