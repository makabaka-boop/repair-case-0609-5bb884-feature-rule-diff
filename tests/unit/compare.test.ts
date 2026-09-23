import { describe, expect, it } from 'vitest';
import {
  DIFF_BASELINE_ONLY,
  DIFF_BOTH,
  DIFF_CANDIDATE_ONLY,
  DIFF_NONE,
  INVALID_MERGE_GAP_NOTICE,
  INVALID_MIN_RUN_NOTICE,
  INVALID_THRESHOLD_NOTICE,
  buildDiffMask,
  buildRuleComparison,
  diffSegments,
  parseCandidateRule
} from '../../src/audio/compare';
import { buildScanResult, scanChannel } from '../../src/audio/scanner';
import type { CandidateRule, ClipSegment, DiffKind } from '../../src/audio/types';

const SR = 1000;

/** 生成指定长度静音，再叠加各段（value 默认 1） */
function build(
  length: number,
  runs: Array<{ start: number; length: number; value?: number }>
): Float32Array {
  const data = new Float32Array(length);
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      data[run.start + i] = run.value ?? 1;
    }
  }
  return data;
}

/** 直接由帧区间构造 ClipSegment（毫秒字段仅展示，不参与裁决） */
function mkSegs(
  segs: Array<[number, number]>,
  sampleRate: number = SR
): ClipSegment[] {
  return segs.map(([startFrame, endFrame]) => ({
    startFrame,
    endFrame,
    startSeconds: startFrame / sampleRate,
    endSeconds: (endFrame + 1) / sampleRate,
    durationSeconds: (endFrame - startFrame + 1) / sampleRate,
    startMs: Math.round((startFrame / sampleRate) * 1000),
    endMs: Math.round(((endFrame + 1) / sampleRate) * 1000),
    durationMs: Math.round(((endFrame - startFrame + 1) / sampleRate) * 1000)
  }));
}

interface OracleFragment {
  kind: DiffKind;
  startFrame: number;
  endFrame: number;
}

/**
 * 独立预言机：逐帧标记两套区间的成员归属（基线=1、候选=2），
 * 再把标记相同且帧相邻的连续帧归并为片段。
 * 与被测实现（事件扫描线）完全独立，用于交叉验证。
 */
function oracleDiff(
  frameCount: number,
  baseline: Array<[number, number]>,
  candidate: Array<[number, number]>
): OracleFragment[] {
  const marks = new Array<number>(frameCount).fill(0);
  for (const [s, e] of baseline) {
    for (let f = s; f <= e; f++) marks[f]! |= DIFF_BASELINE_ONLY;
  }
  for (const [s, e] of candidate) {
    for (let f = s; f <= e; f++) marks[f]! |= DIFF_CANDIDATE_ONLY;
  }
  const out: OracleFragment[] = [];
  let f = 0;
  while (f < frameCount) {
    const m = marks[f]!;
    if (m === DIFF_NONE) {
      f += 1;
      continue;
    }
    let e = f;
    while (e + 1 < frameCount && marks[e + 1] === m) e += 1;
    out.push({
      kind:
        m === DIFF_BOTH
          ? 'BOTH'
          : m === DIFF_BASELINE_ONLY
            ? 'BASELINE_ONLY'
            : 'CANDIDATE_ONLY',
      startFrame: f,
      endFrame: e
    });
    f = e + 1;
  }
  return out;
}

/** 跑 diffSegments 并与独立预言机比对（帧坐标 + 标记） */
function expectDiff(
  frameCount: number,
  baseline: Array<[number, number]>,
  candidate: Array<[number, number]>
): OracleFragment[] {
  const actual = diffSegments(mkSegs(baseline), mkSegs(candidate), SR).map(
    (f) => ({ kind: f.kind, startFrame: f.startFrame, endFrame: f.endFrame })
  );
  const expected = oracleDiff(frameCount, baseline, candidate);
  expect(actual).toEqual(expected);
  return expected;
}

describe('候选规则解析与校验', () => {
  it('合法输入解析为候选规则', () => {
    const r = parseCandidateRule({
      threshold: '0.95',
      minRunFrames: '5',
      maxMergeGap: '0'
    });
    expect(r).toEqual({
      ok: true,
      rule: { threshold: 0.95, minRunFrames: 5, maxMergeGap: 0 }
    });
  });

  it('阈值边界：1 合法，0 / 负数 / 大于 1 非法', () => {
    expect(
      parseCandidateRule({ threshold: '1', minRunFrames: '3', maxMergeGap: '2' })
    ).toMatchObject({ ok: true });
    for (const bad of ['0', '-0.5', '1.0001', '2']) {
      const r = parseCandidateRule({
        threshold: bad,
        minRunFrames: '3',
        maxMergeGap: '2'
      });
      expect(r).toEqual({ ok: false, error: INVALID_THRESHOLD_NOTICE });
    }
  });

  it('阈值为空或非数字时就地提示', () => {
    for (const bad of ['', '   ', 'abc', 'NaN', 'Infinity']) {
      const r = parseCandidateRule({
        threshold: bad,
        minRunFrames: '3',
        maxMergeGap: '2'
      });
      expect(r).toEqual({ ok: false, error: INVALID_THRESHOLD_NOTICE });
    }
  });

  it('最短连续帧数必须为正整数', () => {
    expect(
      parseCandidateRule({ threshold: '0.5', minRunFrames: '1', maxMergeGap: '2' })
    ).toMatchObject({ ok: true });
    for (const bad of ['0', '-1', '2.5', '', 'abc']) {
      const r = parseCandidateRule({
        threshold: '0.5',
        minRunFrames: bad,
        maxMergeGap: '2'
      });
      expect(r).toEqual({ ok: false, error: INVALID_MIN_RUN_NOTICE });
    }
  });

  it('合并间隔必须为非负整数', () => {
    expect(
      parseCandidateRule({ threshold: '0.5', minRunFrames: '3', maxMergeGap: '0' })
    ).toMatchObject({ ok: true });
    for (const bad of ['-1', '1.5', '', 'abc']) {
      const r = parseCandidateRule({
        threshold: '0.5',
        minRunFrames: '3',
        maxMergeGap: bad
      });
      expect(r).toEqual({ ok: false, error: INVALID_MERGE_GAP_NOTICE });
    }
  });

  it('输入含空白字符时按去空白后解析', () => {
    const r = parseCandidateRule({
      threshold: ' 0.8 ',
      minRunFrames: ' 4 ',
      maxMergeGap: ' 1 '
    });
    expect(r).toEqual({
      ok: true,
      rule: { threshold: 0.8, minRunFrames: 4, maxMergeGap: 1 }
    });
  });
});

describe('候选规则扫描（scanChannel 的 rule 参数）', () => {
  it('阈值相等恰为削波帧（含负向）', () => {
    const rule: CandidateRule = { threshold: 0.5, minRunFrames: 3, maxMergeGap: 2 };
    const data = build(12, [
      { start: 2, length: 3, value: 0.5 },
      { start: 7, length: 3, value: -0.5 }
    ]);
    const r = scanChannel(data, SR, 0, rule);
    // 两段间隔 2 帧，按候选合并间隔 2 合并为一段
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ startFrame: 2, endFrame: 9 });
  });

  it('略低于候选阈值不成段', () => {
    const rule: CandidateRule = { threshold: 0.5, minRunFrames: 3, maxMergeGap: 2 };
    const data = build(8, [{ start: 2, length: 3, value: 0.499 }]);
    expect(scanChannel(data, SR, 0, rule).segments).toHaveLength(0);
  });

  it('最短游程：恰为 minRunFrames 成段，少一帧不成段', () => {
    const rule: CandidateRule = { threshold: 0.999, minRunFrames: 5, maxMergeGap: 2 };
    expect(
      scanChannel(build(10, [{ start: 2, length: 4 }]), SR, 0, rule).segments
    ).toHaveLength(0);
    const r = scanChannel(build(10, [{ start: 2, length: 5 }]), SR, 0, rule);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ startFrame: 2, endFrame: 6 });
  });

  it('合并间隙：间隔恰为 maxMergeGap 合并，多一帧不合并', () => {
    const rule: CandidateRule = { threshold: 0.999, minRunFrames: 3, maxMergeGap: 4 };
    // 游程 [0..2] 与 [7..9]，间隔帧 3..6 共 4 帧 => 合并
    const merged = scanChannel(
      build(10, [
        { start: 0, length: 3 },
        { start: 7, length: 3 }
      ]),
      SR,
      0,
      rule
    );
    expect(merged.segments).toHaveLength(1);
    expect(merged.segments[0]).toMatchObject({ startFrame: 0, endFrame: 9 });
    // 游程 [0..2] 与 [8..10]，间隔 5 帧 => 不合并
    const apart = scanChannel(
      build(11, [
        { start: 0, length: 3 },
        { start: 8, length: 3 }
      ]),
      SR,
      0,
      rule
    );
    expect(apart.segments).toHaveLength(2);
  });

  it('maxMergeGap 为 0：仅帧相邻（间隔 0）才合并', () => {
    const rule: CandidateRule = { threshold: 0.999, minRunFrames: 2, maxMergeGap: 0 };
    const adjacent = scanChannel(
      build(8, [
        { start: 0, length: 2 },
        { start: 2, length: 2 }
      ]),
      SR,
      0,
      rule
    );
    expect(adjacent.segments).toHaveLength(1);
    const gapped = scanChannel(
      build(8, [
        { start: 0, length: 2 },
        { start: 3, length: 2 }
      ]),
      SR,
      0,
      rule
    );
    expect(gapped.segments).toHaveLength(2);
  });
});

describe('差异片段切分（独立逐帧预言机交叉验证）', () => {
  it('两套区间完全一致：全部 BOTH', () => {
    expectDiff(20, [[5, 8]], [[5, 8]]);
    const frags = diffSegments(mkSegs([[5, 8]]), mkSegs([[5, 8]]), SR);
    expect(frags).toHaveLength(1);
    expect(frags[0]).toMatchObject({ kind: 'BOTH', startFrame: 5, endFrame: 8 });
  });

  it('嵌套：候选区间落在基线区间内部 → 仅基线 / 共有 / 仅基线', () => {
    const expected = expectDiff(12, [[2, 9]], [[4, 6]]);
    expect(expected).toEqual([
      { kind: 'BASELINE_ONLY', startFrame: 2, endFrame: 3 },
      { kind: 'BOTH', startFrame: 4, endFrame: 6 },
      { kind: 'BASELINE_ONLY', startFrame: 7, endFrame: 9 }
    ]);
  });

  it('相交：部分重叠 → 仅基线 / 共有 / 仅候选', () => {
    const expected = expectDiff(12, [[2, 6]], [[5, 10]]);
    expect(expected).toEqual([
      { kind: 'BASELINE_ONLY', startFrame: 2, endFrame: 4 },
      { kind: 'BOTH', startFrame: 5, endFrame: 6 },
      { kind: 'CANDIDATE_ONLY', startFrame: 7, endFrame: 10 }
    ]);
  });

  it('相邻区间：成员集合不同的相邻片段不得合并', () => {
    // 基线 [0,2] 与候选 [3,5] 帧相邻，但成员集合不同 → 两个片段
    const expected = expectDiff(8, [[0, 2]], [[3, 5]]);
    expect(expected).toEqual([
      { kind: 'BASELINE_ONLY', startFrame: 0, endFrame: 2 },
      { kind: 'CANDIDATE_ONLY', startFrame: 3, endFrame: 5 }
    ]);
  });

  it('成员集合相同且帧相邻的片段必须合并', () => {
    // 两段仅基线 [0,1] 与 [2,3]（间隔 0 帧，帧相邻）→ 合并为 [0,3]
    const expected = expectDiff(6, [
      [0, 1],
      [2, 3]
    ], []);
    expect(expected).toEqual([
      { kind: 'BASELINE_ONLY', startFrame: 0, endFrame: 3 }
    ]);
    // 间隔 1 帧（帧 2 两不沾）→ 不合并
    const apart = expectDiff(8, [
      [0, 1],
      [3, 4]
    ], []);
    expect(apart).toEqual([
      { kind: 'BASELINE_ONLY', startFrame: 0, endFrame: 1 },
      { kind: 'BASELINE_ONLY', startFrame: 3, endFrame: 4 }
    ]);
  });

  it('两不沾的帧不属于任何片段；空区间产生空差异', () => {
    expect(diffSegments([], [], SR)).toEqual([]);
    const expected = expectDiff(10, [[4, 6]], []);
    expect(expected).toEqual([
      { kind: 'BASELINE_ONLY', startFrame: 4, endFrame: 6 }
    ]);
  });

  it('毫秒仅作展示：边界由帧裁决，毫秒字段按帧换算', () => {
    // 采样率 8：帧 1 起始 = 125ms，帧 2 结束 = 3/8 s = 375ms
    const frags = diffSegments(mkSegs([[1, 2]], 8), [], 8);
    expect(frags[0]).toMatchObject({
      startFrame: 1,
      endFrame: 2,
      startMs: 125,
      endMs: 375,
      durationMs: 250
    });
  });
});

describe('整轨比较（buildRuleComparison，复用已解码 PCM）', () => {
  it('多声道逐声道比较：一声道漏掉、一声道新增', () => {
    // 左声道：帧 10..12 满幅（基线 3 帧成段；候选 minRunFrames=5 漏掉）
    // 右声道：帧 20..24 幅值 0.6（基线不命中；候选阈值 0.5 新增）
    const left = build(40, [{ start: 10, length: 3, value: 1 }]);
    const right = build(40, [{ start: 20, length: 5, value: 0.6 }]);
    const baseline = buildScanResult('two.wav', [left, right], SR);
    expect(baseline.hasClip).toBe(true);

    const cmp = buildRuleComparison(baseline, {
      threshold: 0.5,
      minRunFrames: 5,
      maxMergeGap: 2
    });

    // 基线结论不被覆盖
    expect(baseline.channels[0]!.segments).toHaveLength(1);
    expect(cmp.baselineSegmentCount).toBe(1);
    expect(cmp.candidateSegmentCount).toBe(1);
    expect(cmp.candidateHasClip).toBe(true);

    // 左声道：仅基线 [10,12]；与预言机一致
    const leftFrags = cmp.channels[0]!.fragments.map((f) => ({
      kind: f.kind,
      startFrame: f.startFrame,
      endFrame: f.endFrame
    }));
    expect(leftFrags).toEqual([
      { kind: 'BASELINE_ONLY', startFrame: 10, endFrame: 12 }
    ]);
    expect(leftFrags).toEqual(oracleDiff(40, [[10, 12]], []));
    // 右声道：仅候选 [20,24]
    const rightFrags = cmp.channels[1]!.fragments.map((f) => ({
      kind: f.kind,
      startFrame: f.startFrame,
      endFrame: f.endFrame
    }));
    expect(rightFrags).toEqual([
      { kind: 'CANDIDATE_ONLY', startFrame: 20, endFrame: 24 }
    ]);
    expect(rightFrags).toEqual(oracleDiff(40, [], [[20, 24]]));

    expect(cmp.fragmentCount).toBe(2);
    expect(cmp.baselineOnlyCount).toBe(1);
    expect(cmp.candidateOnlyCount).toBe(1);
    expect(cmp.bothCount).toBe(0);
  });

  it('结论翻转：候选更严时可交付，基线仍需重采', () => {
    const data = build(16, [{ start: 4, length: 3 }]);
    const baseline = buildScanResult('flip.wav', [data], SR);
    const cmp = buildRuleComparison(baseline, {
      threshold: 0.999,
      minRunFrames: 4,
      maxMergeGap: 2
    });
    expect(baseline.hasClip).toBe(true);
    expect(cmp.candidateHasClip).toBe(false);
    expect(cmp.candidateTotalClipMs).toBe(0);
    expect(cmp.baselineOnlyCount).toBe(1);
  });

  it('规则与基线相同：全部 BOTH，段数一致', () => {
    const data = build(20, [
      { start: 2, length: 3 },
      { start: 10, length: 4 }
    ]);
    const baseline = buildScanResult('same.wav', [data], SR);
    const cmp = buildRuleComparison(baseline, {
      threshold: 0.999,
      minRunFrames: 3,
      maxMergeGap: 2
    });
    expect(cmp.baselineSegmentCount).toBe(2);
    expect(cmp.candidateSegmentCount).toBe(2);
    expect(cmp.baselineOnlyCount).toBe(0);
    expect(cmp.candidateOnlyCount).toBe(0);
    expect(cmp.bothCount).toBe(2);
    expect(cmp.candidateTotalClipMs).toBe(baseline.totalClipMs);
  });

  it('候选总削波时长按声道累加', () => {
    const clipped = build(10, [{ start: 2, length: 3 }]);
    const baseline = buildScanResult('sum.wav', [clipped, clipped.slice()], 10);
    const cmp = buildRuleComparison(baseline, {
      threshold: 0.999,
      minRunFrames: 3,
      maxMergeGap: 2
    });
    expect(cmp.candidateTotalClipSeconds).toBeCloseTo(0.6, 10);
    expect(cmp.candidateTotalClipMs).toBe(600);
  });

  it('阈值分层嵌套：候选更严时基线区间包住候选区间', () => {
    // 帧 2..9 幅值 0.9995（仅基线 0.999 命中），帧 4..6 幅值 1（候选阈值 1 也命中）
    const pcm = build(12, [
      { start: 2, length: 8, value: 0.9995 },
      { start: 4, length: 3, value: 1 }
    ]);
    const baseline = buildScanResult('nest.wav', [pcm], SR);
    const cmp = buildRuleComparison(baseline, {
      threshold: 1,
      minRunFrames: 3,
      maxMergeGap: 2
    });
    const frags = cmp.channels[0]!.fragments.map((f) => ({
      kind: f.kind,
      startFrame: f.startFrame,
      endFrame: f.endFrame
    }));
    expect(frags).toEqual([
      { kind: 'BASELINE_ONLY', startFrame: 2, endFrame: 3 },
      { kind: 'BOTH', startFrame: 4, endFrame: 6 },
      { kind: 'BASELINE_ONLY', startFrame: 7, endFrame: 9 }
    ]);
    expect(frags).toEqual(oracleDiff(12, [[2, 9]], [[4, 6]]));
  });
});

describe('逐帧差异标记数组（波形着色数据源）', () => {
  it('按片段展开为逐帧标记，帧外为 DIFF_NONE', () => {
    const baseline = buildScanResult(
      'mask.wav',
      [build(12, [{ start: 2, length: 3 }])],
      SR
    );
    const cmp = buildRuleComparison(baseline, {
      threshold: 0.999,
      minRunFrames: 5,
      maxMergeGap: 2
    });
    const mask = buildDiffMask(cmp.channels[0]!.fragments, 12);
    expect(Array.from(mask)).toEqual([
      0, 0,
      DIFF_BASELINE_ONLY, DIFF_BASELINE_ONLY, DIFF_BASELINE_ONLY,
      0, 0, 0, 0, 0, 0, 0
    ]);
  });

  it('共有与仅候选标记正确，超出帧数的片段被截断', () => {
    const mask = buildDiffMask(
      [
        { ...mkSegs([[0, 1]])[0]!, kind: 'BOTH' as const },
        { ...mkSegs([[3, 10]])[0]!, kind: 'CANDIDATE_ONLY' as const }
      ],
      5
    );
    expect(Array.from(mask)).toEqual([
      DIFF_BOTH,
      DIFF_BOTH,
      DIFF_NONE,
      DIFF_CANDIDATE_ONLY,
      DIFF_CANDIDATE_ONLY
    ]);
  });

  it('空片段与零帧数产生全零标记', () => {
    expect(Array.from(buildDiffMask([], 4))).toEqual([0, 0, 0, 0]);
    expect(buildDiffMask([], 0).length).toBe(0);
  });
});
