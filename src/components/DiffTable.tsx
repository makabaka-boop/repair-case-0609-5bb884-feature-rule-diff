import type { DiffFragment, DiffKind } from '../audio/types';

interface DiffTableProps {
  fragments: DiffFragment[];
  onLocate: (fragment: DiffFragment) => void;
}

/** 差异标记的展示文案 */
const KIND_LABELS: Record<DiffKind, string> = {
  BASELINE_ONLY: '仅基线',
  CANDIDATE_ONLY: '仅候选',
  BOTH: '两者共有'
};

/**
 * 单声道差异片段表：逐行列出两套规则切出的最大连续差异片段，
 * 行点击 / 按钮均可定位试听。毫秒仅为展示，帧范围才是裁决边界。
 */
export default function DiffTable({ fragments, onLocate }: DiffTableProps) {
  return (
    <div className="segment-table-wrap" data-testid="diff-table">
      <table className="segment-table diff-table">
        <thead>
          <tr>
            <th>#</th>
            <th>标记</th>
            <th>起始 (ms)</th>
            <th>结束 (ms)</th>
            <th>时长 (ms)</th>
            <th>帧范围</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {fragments.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={7}>该声道两套规则均无削波区间</td>
            </tr>
          ) : (
            fragments.map((frag, i) => (
              <tr
                key={`${frag.kind}-${frag.startFrame}-${frag.endFrame}`}
                data-testid="diff-row"
                data-kind={frag.kind}
                onClick={() => onLocate(frag)}
              >
                <td>{i + 1}</td>
                <td>
                  <span
                    className={`diff-kind diff-kind-${frag.kind.toLowerCase().replace(/_/g, '-')}`}
                    data-testid="diff-kind"
                  >
                    {KIND_LABELS[frag.kind]}
                  </span>
                </td>
                <td>{frag.startMs}</td>
                <td>{frag.endMs}</td>
                <td>{frag.durationMs}</td>
                <td>
                  {frag.startFrame}–{frag.endFrame}
                </td>
                <td>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onLocate(frag);
                    }}
                  >
                    定位试听
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
