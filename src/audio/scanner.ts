/**
 * 削波扫描器（纯函数）。
 *
 * 判定规则：
 * 1. 解码后的归一化 PCM 中，|sample| >= 0.999 即“削波帧”。
 * 2. 连续至少 3 帧才形成削波段。
 * 3. 相邻段间隔 <= 2 帧必须合并；间隔 >= 3 帧不得合并。
 */

import type { ChannelScan, ClipSegment, ScanResult } from './types';
import {
  frameToEndSeconds,
  frameToStartSeconds,
  secondsToMs
} from './time';

/** 削波阈值：绝对值大于等于该值 */
export const CLIP_THRESHOLD = 0.999;
/** 成段所需最少连续帧数 */
export const MIN_RUN_FRAMES = 3;
/** 间隔不超过该帧数的相邻段必须合并 */
export const MAX_MERGE_GAP = 2;

/** 一次扫描采用的判定规则（基线扫描使用 BASELINE_RULE） */
export interface ScanRule {
  threshold: number;
  minRunFrames: number;
  maxMergeGap: number;
}

/** 现行放行标准：0.999 / 连续 3 帧 / 间隔 2 帧合并 */
export const BASELINE_RULE: ScanRule = {
  threshold: CLIP_THRESHOLD,
  minRunFrames: MIN_RUN_FRAMES,
  maxMergeGap: MAX_MERGE_GAP
};

export function isClipSample(
  sample: number,
  threshold: number = CLIP_THRESHOLD
): boolean {
  return Math.abs(sample) >= threshold;
}

/**
 * 扫描单声道 PCM，返回合并后的削波段（按时间升序）。
 * 默认按基线规则；传入 rule 可按候选规则复用同一已解码 PCM 重扫。
 */
export function scanChannel(
  data: Float32Array,
  sampleRate: number,
  channel: number,
  rule: ScanRule = BASELINE_RULE
): ChannelScan {
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
    throw new RangeError(`非法采样率: ${String(sampleRate)}`);
  }

  // 第一步：找出所有长度 >= minRunFrames 的连续帧游程
  const runs: Array<[number, number]> = [];
  let runStart = -1;
  for (let i = 0; i < data.length; i++) {
    if (isClipSample(data[i]!, rule.threshold)) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart >= rule.minRunFrames) runs.push([runStart, i - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0 && data.length - runStart >= rule.minRunFrames) {
    runs.push([runStart, data.length - 1]);
  }

  // 第二步：间隔 <= maxMergeGap 帧的相邻段必须合并（间隔 = 下一段首帧 - 上一段末帧 - 1）
  const merged: Array<[number, number]> = [];
  for (const [start, end] of runs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start - last[1]! - 1 <= rule.maxMergeGap) {
      last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }

  const segments: ClipSegment[] = merged.map(([startFrame, endFrame]) => {
    const startSeconds = frameToStartSeconds(startFrame, sampleRate);
    const endSeconds = frameToEndSeconds(endFrame, sampleRate);
    const durationSeconds = endSeconds - startSeconds;
    return {
      startFrame,
      endFrame,
      startSeconds,
      endSeconds,
      durationSeconds,
      startMs: secondsToMs(startSeconds),
      endMs: secondsToMs(endSeconds),
      durationMs: secondsToMs(durationSeconds)
    };
  });

  const totalClipSeconds = segments.reduce(
    (sum, seg) => sum + seg.durationSeconds,
    0
  );

  return {
    channel,
    segments,
    totalClipSeconds,
    totalClipMs: secondsToMs(totalClipSeconds),
    frameCount: data.length,
    sampleRate
  };
}

/**
 * 汇总所有声道扫描结果。
 * 总削波时长按各声道区间时长累加，同一时刻多声道削波分别计入。
 */
export function buildScanResult(
  fileName: string,
  channelData: Float32Array[],
  sampleRate: number
): ScanResult {
  const channels = channelData.map((data, index) =>
    scanChannel(data, sampleRate, index)
  );
  const totalClipSeconds = channels.reduce(
    (sum, ch) => sum + ch.totalClipSeconds,
    0
  );

  let firstClip: { channel: number; segment: ClipSegment } | null = null;
  for (const ch of channels) {
    const seg = ch.segments[0];
    if (
      seg !== undefined &&
      (firstClip === null || seg.startFrame < firstClip.segment.startFrame)
    ) {
      firstClip = { channel: ch.channel, segment: seg };
    }
  }

  const frameCount = channelData.reduce((max, d) => Math.max(max, d.length), 0);

  return {
    fileName,
    sampleRate,
    channels,
    totalClipSeconds,
    totalClipMs: secondsToMs(totalClipSeconds),
    hasClip: firstClip !== null,
    firstClip,
    channelData,
    durationSeconds: frameCount / sampleRate
  };
}
