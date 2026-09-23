/** 核验台核心数据类型 */

export interface ClipSegment {
  /** 首帧索引（包含） */
  startFrame: number;
  /** 末帧索引（包含） */
  endFrame: number;
  /** 首帧时间（秒），首帧 / sampleRate */
  startSeconds: number;
  /** 末帧后一帧时间（秒），(endFrame + 1) / sampleRate */
  endSeconds: number;
  /** 段时长（秒），(endFrame - startFrame + 1) / sampleRate */
  durationSeconds: number;
  /** 起始时间，毫秒，四舍五入（0.5 向上取整） */
  startMs: number;
  /** 结束时间，毫秒，四舍五入（0.5 向上取整） */
  endMs: number;
  /** 段时长，毫秒，按精确时长四舍五入（0.5 向上取整） */
  durationMs: number;
}

export interface ChannelScan {
  /** 声道序号，0 起 */
  channel: number;
  segments: ClipSegment[];
  /** 该声道所有段时长累加（秒，精确值） */
  totalClipSeconds: number;
  /** 该声道总削波时长（毫秒，对精确合计四舍五入） */
  totalClipMs: number;
  frameCount: number;
  sampleRate: number;
}

export interface ScanResult {
  fileName: string;
  sampleRate: number;
  channels: ChannelScan[];
  /** 各声道区间时长累加（秒，精确值；同一时刻多声道削波分别计入） */
  totalClipSeconds: number;
  /** 总削波时长（毫秒，对精确合计四舍五入） */
  totalClipMs: number;
  /** 任一声道存在区间 */
  hasClip: boolean;
  /** 全声道首个削波段 */
  firstClip: { channel: number; segment: ClipSegment } | null;
  /** 每声道原始 PCM 数据引用（解码缓冲不复制） */
  channelData: Float32Array[];
  durationSeconds: number;
}

/** 候选判定规则（与基线规则比较用） */
export interface CandidateRule {
  /** 削波阈值：0 < 值 ≤ 1，绝对值大于等于该值即削波帧 */
  threshold: number;
  /** 成段所需最少连续帧数：正整数 */
  minRunFrames: number;
  /** 间隔不超过该帧数的相邻段必须合并：非负整数 */
  maxMergeGap: number;
}

/** 差异片段的成员归属 */
export type DiffKind = 'BASELINE_ONLY' | 'CANDIDATE_ONLY' | 'BOTH';

/**
 * 两套合并后区间切出的最大连续差异片段。
 * 边界一律以原始帧坐标裁决；毫秒/秒字段仅用于展示。
 */
export interface DiffFragment {
  kind: DiffKind;
  /** 首帧索引（包含） */
  startFrame: number;
  /** 末帧索引（包含） */
  endFrame: number;
  /** 首帧时间（秒），仅展示 */
  startSeconds: number;
  /** 末帧后一帧时间（秒），仅展示 */
  endSeconds: number;
  /** 片段时长（秒），仅展示 */
  durationSeconds: number;
  /** 起始毫秒（展示，四舍五入 0.5 向上） */
  startMs: number;
  /** 结束毫秒（展示，四舍五入 0.5 向上） */
  endMs: number;
  /** 时长毫秒（展示，四舍五入 0.5 向上） */
  durationMs: number;
}

/** 单声道的规则比较结果：候选扫描 + 差异片段 */
export interface ChannelDiff {
  /** 声道序号，0 起 */
  channel: number;
  /** 该声道按候选规则扫描的结果 */
  candidate: ChannelScan;
  /** 基线/候选两套合并区间切出的最大连续差异片段（按帧升序） */
  fragments: DiffFragment[];
}

/** 一次完整的候选规则比较结果（页面、列表与波形共用同一份） */
export interface RuleComparison {
  /** 参与比较的候选规则 */
  rule: CandidateRule;
  /** 逐声道比较结果 */
  channels: ChannelDiff[];
  /** 候选规则下任一声道存在区间 */
  candidateHasClip: boolean;
  /** 候选规则总削波时长（秒，各声道累加，精确值） */
  candidateTotalClipSeconds: number;
  /** 候选规则总削波时长（毫秒，对精确合计四舍五入） */
  candidateTotalClipMs: number;
  /** 基线段数（各声道合计） */
  baselineSegmentCount: number;
  /** 候选段数（各声道合计） */
  candidateSegmentCount: number;
  /** 差异片段总数（各声道合计，含 BOTH） */
  fragmentCount: number;
  /** 仅基线命中的片段数 */
  baselineOnlyCount: number;
  /** 仅候选命中的片段数 */
  candidateOnlyCount: number;
  /** 两套规则共同命中的片段数 */
  bothCount: number;
}

export type WavErrorCode =
  | 'NOT_WAV'
  | 'CORRUPT'
  | 'NO_TRACK'
  | 'DECODE_FAILED';

export class WavError extends Error {
  code: WavErrorCode;
  constructor(code: WavErrorCode, message: string) {
    super(message);
    this.name = 'WavError';
    this.code = code;
  }
}

export const ERROR_MESSAGES: Record<WavErrorCode, string> = {
  NOT_WAV: '文件不是有效的 WAV 音频',
  CORRUPT: 'WAV 文件已损坏或被截断',
  NO_TRACK: 'WAV 文件不含可读取的音轨',
  DECODE_FAILED: '音频解码失败，扫描未执行'
};
