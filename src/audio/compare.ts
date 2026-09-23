/**
 * 候选规则比较（纯函数）。
 *
 * 在保留基线扫描（0.999 / 连续 3 帧 / 间隔 2 帧合并）结论不变的前提下，
 * 用候选规则对同一份已解码 PCM 重扫（不重复读取或解码文件），
 * 并逐声道把两套合并后区间切成最大连续差异片段：
 * - 片段边界一律以原始帧坐标裁决，毫秒仅用于展示；
 * - 只有成员集合（基线/候选命中情况）相同且帧相邻的片段才合并；
 * - 片段标记 BASELINE_ONLY（仅基线命中）、CANDIDATE_ONLY（仅候选命中）
 *   或 BOTH（两套规则都命中）。
 */

import { scanChannel, type ScanRule } from './scanner';
import {
  frameToEndSeconds,
  frameToStartSeconds,
  secondsToMs
} from './time';
import type {
  CandidateRule,
  ChannelDiff,
  ClipSegment,
  DiffFragment,
  DiffKind,
  RuleComparison,
  ScanResult
} from './types';

/** 阈值非法时的就地提示 */
export const INVALID_THRESHOLD_NOTICE =
  '阈值必须是大于 0 且不超过 1 的数字';
/** 最短连续帧数非法时的就地提示 */
export const INVALID_MIN_RUN_NOTICE = '最短连续帧数必须是正整数';
/** 合并间隔非法时的就地提示 */
export const INVALID_MERGE_GAP_NOTICE = '合并间隔必须是非负整数';

/** 候选规则三个输入框的原始文本 */
export interface CandidateRuleInput {
  threshold: string;
  minRunFrames: string;
  maxMergeGap: string;
}

export type ParseRuleResult =
  | { ok: true; rule: CandidateRule }
  | { ok: false; error: string };

/**
 * 解析并校验候选规则输入：
 * - threshold：0 < 值 ≤ 1 的有限数字；
 * - minRunFrames：正整数；
 * - maxMergeGap：非负整数。
 * 任一非法即返回就地提示文案，调用方保留上一次有效比较。
 */
export function parseCandidateRule(input: CandidateRuleInput): ParseRuleResult {
  const thresholdRaw = input.threshold.trim();
  const threshold = thresholdRaw === '' ? NaN : Number(thresholdRaw);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    return { ok: false, error: INVALID_THRESHOLD_NOTICE };
  }

  const minRunRaw = input.minRunFrames.trim();
  const minRunFrames = minRunRaw === '' ? NaN : Number(minRunRaw);
  if (!Number.isInteger(minRunFrames) || minRunFrames < 1) {
    return { ok: false, error: INVALID_MIN_RUN_NOTICE };
  }

  const mergeGapRaw = input.maxMergeGap.trim();
  const maxMergeGap = mergeGapRaw === '' ? NaN : Number(mergeGapRaw);
  if (!Number.isInteger(maxMergeGap) || maxMergeGap < 0) {
    return { ok: false, error: INVALID_MERGE_GAP_NOTICE };
  }

  return { ok: true, rule: { threshold, minRunFrames, maxMergeGap } };
}

/**
 * 把两套合并后区间切成最大连续差异片段（纯帧坐标扫描线）。
 * 按帧坐标分组处理区间端点事件，逐帧维护两套规则的命中状态；
 * 命中状态相同的连续帧并入同一片段，两者都不命中的帧不属于任何片段，
 * 只有成员集合相同且帧相邻的片段才合并。
 */
export function diffSegments(
  baseline: ClipSegment[],
  candidate: ClipSegment[],
  sampleRate: number
): DiffFragment[] {
  // 事件：帧坐标处某套规则的命中计数 +1/-1（区间末帧的下一帧处 -1）
  const events: Array<{ frame: number; base: number; cand: number }> = [];
  const pushEvents = (segments: ClipSegment[], key: 'base' | 'cand') => {
    for (const seg of segments) {
      events.push({
        frame: seg.startFrame,
        base: key === 'base' ? 1 : 0,
        cand: key === 'cand' ? 1 : 0
      });
      events.push({
        frame: seg.endFrame + 1,
        base: key === 'base' ? -1 : 0,
        cand: key === 'cand' ? -1 : 0
      });
    }
  };
  pushEvents(baseline, 'base');
  pushEvents(candidate, 'cand');
  events.sort((a, b) => a.frame - b.frame);

  const fragments: DiffFragment[] = [];
  let inBaseline = 0;
  let inCandidate = 0;
  // 当前命中状态生效的起始帧（上一事件帧）
  let stateStart = 0;

  const currentKind = (): DiffKind | null =>
    inBaseline > 0 && inCandidate > 0
      ? 'BOTH'
      : inBaseline > 0
        ? 'BASELINE_ONLY'
        : inCandidate > 0
          ? 'CANDIDATE_ONLY'
          : null;

  const emit = (kind: DiffKind, startFrame: number, endFrame: number) => {
    const last = fragments[fragments.length - 1];
    if (last !== undefined && last.kind === kind && last.endFrame + 1 === startFrame) {
      // 成员集合相同且帧相邻：合并为一片段（展示时间按新末帧重算）
      fragments[fragments.length - 1] = makeFragment(
        kind,
        last.startFrame,
        endFrame,
        sampleRate
      );
    } else {
      fragments.push(makeFragment(kind, startFrame, endFrame, sampleRate));
    }
  };

  let i = 0;
  while (i < events.length) {
    const frame = events[i]!.frame;
    // 当前命中状态对 [stateStart, frame - 1] 的每一帧恒定
    const kind = currentKind();
    if (kind !== null) emit(kind, stateStart, frame - 1);
    // 应用该帧坐标上的全部端点事件，得到下一跨度的命中状态
    while (i < events.length && events[i]!.frame === frame) {
      inBaseline += events[i]!.base;
      inCandidate += events[i]!.cand;
      i += 1;
    }
    stateStart = frame;
  }
  // 最后一组事件后两套规则的命中计数必然归零（区间均有配对端点），无残留片段

  return fragments;
}

/** 差异帧标记：两不沾 */
export const DIFF_NONE = 0;
/** 差异帧标记：仅基线命中 */
export const DIFF_BASELINE_ONLY = 1;
/** 差异帧标记：仅候选命中 */
export const DIFF_CANDIDATE_ONLY = 2;
/** 差异帧标记：两套规则都命中 */
export const DIFF_BOTH = 3;

const KIND_TO_MARK: Record<DiffKind, number> = {
  BASELINE_ONLY: DIFF_BASELINE_ONLY,
  CANDIDATE_ONLY: DIFF_CANDIDATE_ONLY,
  BOTH: DIFF_BOTH
};

/**
 * 把差异片段展开为逐帧标记数组（长度 frameCount，帧外为 DIFF_NONE）。
 * 波形着色与差异表共用同一份比较结果：画布只读该数组，
 * 保证着色边界与差异表完全一致。
 */
export function buildDiffMask(
  fragments: DiffFragment[],
  frameCount: number
): Uint8Array {
  const mask = new Uint8Array(Math.max(0, frameCount));
  for (const frag of fragments) {
    const mark = KIND_TO_MARK[frag.kind];
    const start = Math.max(0, frag.startFrame);
    const end = Math.min(mask.length - 1, frag.endFrame);
    for (let f = start; f <= end; f++) mask[f] = mark;
  }
  return mask;
}

/** 帧坐标片段 + 展示用时间字段（毫秒不参与任何边界裁决） */
function makeFragment(
  kind: DiffKind,
  startFrame: number,
  endFrame: number,
  sampleRate: number
): DiffFragment {
  const startSeconds = frameToStartSeconds(startFrame, sampleRate);
  const endSeconds = frameToEndSeconds(endFrame, sampleRate);
  const durationSeconds = endSeconds - startSeconds;
  return {
    kind,
    startFrame,
    endFrame,
    startSeconds,
    endSeconds,
    durationSeconds,
    startMs: secondsToMs(startSeconds),
    endMs: secondsToMs(endSeconds),
    durationMs: secondsToMs(durationSeconds)
  };
}

/**
 * 基于已解码 PCM（baseline.channelData）构建候选规则比较结果。
 * 基线结论直接取自既有扫描结果，不会被候选规则覆盖。
 */
export function buildRuleComparison(
  baseline: ScanResult,
  rule: CandidateRule
): RuleComparison {
  const scanRule: ScanRule = {
    threshold: rule.threshold,
    minRunFrames: rule.minRunFrames,
    maxMergeGap: rule.maxMergeGap
  };

  const channels: ChannelDiff[] = baseline.channelData.map((data, index) => {
    const base = baseline.channels[index];
    const candidate = scanChannel(data, baseline.sampleRate, index, scanRule);
    return {
      channel: index,
      candidate,
      fragments: diffSegments(base?.segments ?? [], candidate.segments, baseline.sampleRate)
    };
  });

  let candidateTotalClipSeconds = 0;
  let candidateHasClip = false;
  let baselineSegmentCount = 0;
  let candidateSegmentCount = 0;
  let fragmentCount = 0;
  let baselineOnlyCount = 0;
  let candidateOnlyCount = 0;
  let bothCount = 0;

  channels.forEach((ch, index) => {
    candidateTotalClipSeconds += ch.candidate.totalClipSeconds;
    candidateHasClip = candidateHasClip || ch.candidate.segments.length > 0;
    baselineSegmentCount += baseline.channels[index]?.segments.length ?? 0;
    candidateSegmentCount += ch.candidate.segments.length;
    fragmentCount += ch.fragments.length;
    for (const frag of ch.fragments) {
      if (frag.kind === 'BASELINE_ONLY') baselineOnlyCount += 1;
      else if (frag.kind === 'CANDIDATE_ONLY') candidateOnlyCount += 1;
      else bothCount += 1;
    }
  });

  return {
    rule,
    channels,
    candidateHasClip,
    candidateTotalClipSeconds,
    candidateTotalClipMs: secondsToMs(candidateTotalClipSeconds),
    baselineSegmentCount,
    candidateSegmentCount,
    fragmentCount,
    baselineOnlyCount,
    candidateOnlyCount,
    bothCount
  };
}
