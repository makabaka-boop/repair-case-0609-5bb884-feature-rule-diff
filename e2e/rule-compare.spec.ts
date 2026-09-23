import { expect, test, type Page } from '@playwright/test';

/**
 * 候选规则比较端到端验收：
 * - 与基线相同的规则 → 无差异（全部两者共有）；
 * - 更严 / 更宽的候选规则 → 结论翻转与差异片段着色；
 * - 非法输入就地提示并保留上一次有效比较；
 * - 换文件（含损坏文件）清空旧比较。
 * WAV 素材全部在浏览器页面内现场生成（16bit PCM），文件不离开本机。
 */

function buildWav(opts: {
  channels: number;
  sampleRate: number;
  interleaved: number[];
}): Buffer {
  const { channels, sampleRate, interleaved } = opts;
  const blockAlign = channels * 2;
  const dataBytes = interleaved.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < interleaved.length; i++) {
    const s = Math.max(-32768, Math.min(32767, Math.round(interleaved[i]! * 32767)));
    buf.writeInt16LE(s, 44 + i * 2);
  }
  return buf;
}

/** 静音交错帧序列；start/end 为帧区间（含），value 为幅值，targets 指定声道 */
function makeInterleaved(
  channels: number,
  frameCount: number,
  clips: Array<{ start: number; end: number; targets: number[]; value?: number }>
): number[] {
  const data = new Array<number>(channels * frameCount).fill(0);
  for (const clip of clips) {
    for (let f = clip.start; f <= clip.end; f++) {
      for (const ch of clip.targets) {
        data[f * channels + ch] = clip.value ?? 1;
      }
    }
  }
  return data;
}

async function loadFile(page: Page, buffer: Buffer, name: string): Promise<void> {
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('file-input').click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles({ name, mimeType: 'audio/wav', buffer });
}

async function pauseAudio(page: Page): Promise<void> {
  await page
    .getByTestId('audio-player')
    .evaluate((el) => (el as HTMLAudioElement).pause());
}

/** 统计画布中满足自定义颜色判据的像素数 */
async function countPixels(
  page: Page,
  canvasIndex: number,
  matcher: (r: number, g: number, b: number, a: number) => boolean
): Promise<number> {
  return page.evaluate(
    ({ idx, src }) => {
      const canvas = document.querySelectorAll<HTMLCanvasElement>(
        '[data-testid="waveform-canvas"]'
      )[idx]!;
      const ctx = canvas.getContext('2d')!;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const fn = new Function('r', 'g', 'b', 'a', `return (${src})(r, g, b, a);`) as (
        r: number,
        g: number,
        b: number,
        a: number
      ) => boolean;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (fn(data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!)) count++;
      }
      return count;
    },
    { idx: canvasIndex, src: matcher.toString() }
  );
}

/** 仅基线（琥珀）像素 */
const amberPixels = (page: Page, idx: number) =>
  countPixels(
    page,
    idx,
    (r, g, b, a) => a > 0 && r > 130 && g > 60 && g < 170 && b < 90 && r - g > 25 && g - b > 15
  );

/** 仅候选（紫）像素 */
const violetPixels = (page: Page, idx: number) =>
  countPixels(
    page,
    idx,
    (r, g, b, a) => a > 0 && b > 120 && b - r > 20 && r > g
  );

/** 两者共有（绿）像素 */
const greenPixels = (page: Page, idx: number) =>
  countPixels(
    page,
    idx,
    (r, g, b, a) => a > 0 && g > 90 && g - r > 25 && g - b > 10
  );

test('与基线相同的候选规则：两套结论一致，差异全部为两者共有', async ({ page }) => {
  await page.goto('/');
  // 8000Hz 单声道 80 帧；帧 10..12（连续 3 帧）满幅削波
  const wav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 80, [{ start: 10, end: 12, targets: [0] }])
  });
  await loadFile(page, wav, 'same-rule.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');

  // 默认输入即基线规则（0.999 / 3 / 2），直接应用
  await expect(page.getByTestId('rule-threshold')).toHaveValue('0.999');
  await expect(page.getByTestId('rule-min-run')).toHaveValue('3');
  await expect(page.getByTestId('rule-merge-gap')).toHaveValue('2');
  await page.getByTestId('apply-rule').click();

  // 两套结论与段数并列且一致
  await expect(page.getByTestId('compare-baseline-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('compare-candidate-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('compare-baseline-count')).toContainText('1 段');
  await expect(page.getByTestId('compare-candidate-count')).toContainText('1 段');
  await expect(page.getByTestId('compare-diff-summary')).toHaveText(
    '仅基线 0 · 仅候选 0 · 两者共有 1'
  );

  // 差异表唯一一行为“两者共有”，帧范围 10–12
  const rows = page.getByTestId('diff-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).getByTestId('diff-kind')).toHaveText('两者共有');
  await expect(rows.nth(0)).toContainText('10–12');

  // 基线摘要与结论保持原样（不被比较覆盖）
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await expect(page.getByTestId('channel-stat')).toContainText('1 段');

  // 波形用同一差异数组着色：出现“两者共有”绿色，无琥珀/紫
  await expect.poll(() => greenPixels(page, 0)).toBeGreaterThan(50);
  expect(await amberPixels(page, 0)).toBe(0);
  expect(await violetPixels(page, 0)).toBe(0);
});

test('候选更严（最短 5 帧）：结论翻转为可交付，差异为仅基线并着色', async ({ page }) => {
  await page.goto('/');
  // 8000Hz 单声道 80 帧；帧 20..22 连续 3 帧削波（候选 5 帧成段则漏掉）
  const wav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 80, [{ start: 20, end: 22, targets: [0] }])
  });
  await loadFile(page, wav, 'stricter-rule.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');

  await page.getByTestId('rule-min-run').fill('5');
  await page.getByTestId('apply-rule').click();

  // 结论翻转：基线需重采，候选可交付
  await expect(page.getByTestId('compare-baseline-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('compare-candidate-verdict')).toHaveText('可交付');
  await expect(page.getByTestId('compare-baseline-count')).toContainText('1 段');
  await expect(page.getByTestId('compare-candidate-count')).toContainText('0 段');
  await expect(page.getByTestId('compare-diff-summary')).toHaveText(
    '仅基线 1 · 仅候选 0 · 两者共有 0'
  );

  // 差异行标记“仅基线”，帧范围 20–22；声道头部出现候选统计
  const rows = page.getByTestId('diff-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).getByTestId('diff-kind')).toHaveText('仅基线');
  await expect(rows.nth(0)).toContainText('20–22');
  await expect(page.getByTestId('candidate-stat')).toHaveText('候选：无削波段');

  // 波形出现“仅基线”琥珀色，无紫/绿
  await expect.poll(() => amberPixels(page, 0)).toBeGreaterThan(50);
  expect(await violetPixels(page, 0)).toBe(0);
  expect(await greenPixels(page, 0)).toBe(0);

  // 差异表可定位试听：点击行后播放器跳到片段起点（20/8000 = 2.5ms）
  await rows.nth(0).click();
  await pauseAudio(page);
  const t = await page
    .getByTestId('audio-player')
    .evaluate((el) => (el as HTMLAudioElement).currentTime);
  expect(t).toBeGreaterThan(0.001);
  expect(t).toBeLessThan(0.05);
});

test('候选更宽（阈值 0.5）：基线可交付而候选需重采，差异为仅候选', async ({ page }) => {
  await page.goto('/');
  // 8000Hz 单声道 80 帧；帧 30..34 幅值 0.6（基线 0.999 不命中，候选 0.5 命中）
  const wav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 80, [
      { start: 30, end: 34, targets: [0], value: 0.6 }
    ])
  });
  await loadFile(page, wav, 'looser-rule.wav');
  await expect(page.getByTestId('verdict')).toHaveText('可交付');

  await page.getByTestId('rule-threshold').fill('0.5');
  await page.getByTestId('apply-rule').click();

  // 反向翻转：基线可交付，候选需重采
  await expect(page.getByTestId('compare-baseline-verdict')).toHaveText('可交付');
  await expect(page.getByTestId('compare-candidate-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('compare-diff-summary')).toHaveText(
    '仅基线 0 · 仅候选 1 · 两者共有 0'
  );

  const rows = page.getByTestId('diff-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).getByTestId('diff-kind')).toHaveText('仅候选');
  await expect(rows.nth(0)).toContainText('30–34');
  await expect(page.getByTestId('candidate-stat')).toContainText('候选：1 段');

  // 波形出现“仅候选”紫色，无琥珀/绿
  await expect.poll(() => violetPixels(page, 0)).toBeGreaterThan(50);
  expect(await amberPixels(page, 0)).toBe(0);
  expect(await greenPixels(page, 0)).toBe(0);

  // 基线摘要不受影响：仍可交付、无削波段
  await expect(page.getByTestId('verdict')).toHaveText('可交付');
  await expect(page.getByTestId('channel-stat')).toHaveText('无削波段');
});

test('非法输入：就地提示并保留上一次有效比较', async ({ page }) => {
  await page.goto('/');
  // 8000Hz 单声道 80 帧；帧 20..22 连续 3 帧削波
  const wav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 80, [{ start: 20, end: 22, targets: [0] }])
  });
  await loadFile(page, wav, 'invalid-rule.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');

  // 先应用一条有效规则（最短 5 帧 → 候选可交付）
  await page.getByTestId('rule-min-run').fill('5');
  await page.getByTestId('apply-rule').click();
  await expect(page.getByTestId('compare-candidate-verdict')).toHaveText('可交付');
  await expect(page.getByTestId('diff-row')).toHaveCount(1);

  // 阈值非法：0、大于 1、非数字、空
  for (const bad of ['0', '1.5', 'abc', '']) {
    await page.getByTestId('rule-threshold').fill(bad);
    await page.getByTestId('apply-rule').click();
    await expect(page.getByTestId('rule-error')).toHaveText(
      '阈值必须是大于 0 且不超过 1 的数字'
    );
    // 上一次有效比较保留
    await expect(page.getByTestId('compare-candidate-verdict')).toHaveText('可交付');
    await expect(page.getByTestId('diff-row')).toHaveCount(1);
    await expect(page.getByTestId('compare-diff-summary')).toHaveText(
      '仅基线 1 · 仅候选 0 · 两者共有 0'
    );
  }
  await page.getByTestId('rule-threshold').fill('0.999');

  // 最短连续帧数非法：0、负数、小数
  for (const bad of ['0', '-2', '2.5']) {
    await page.getByTestId('rule-min-run').fill(bad);
    await page.getByTestId('apply-rule').click();
    await expect(page.getByTestId('rule-error')).toHaveText(
      '最短连续帧数必须是正整数'
    );
    await expect(page.getByTestId('compare-candidate-verdict')).toHaveText('可交付');
  }
  await page.getByTestId('rule-min-run').fill('5');

  // 合并间隔非法：负数、小数
  for (const bad of ['-1', '0.5']) {
    await page.getByTestId('rule-merge-gap').fill(bad);
    await page.getByTestId('apply-rule').click();
    await expect(page.getByTestId('rule-error')).toHaveText(
      '合并间隔必须是非负整数'
    );
    await expect(page.getByTestId('compare-candidate-verdict')).toHaveText('可交付');
  }
  await page.getByTestId('rule-merge-gap').fill('2');

  // 修正为合法输入后可再次应用，比较结果随之更新
  await page.getByTestId('rule-min-run').fill('3');
  await page.getByTestId('apply-rule').click();
  await expect(page.getByTestId('rule-error')).toHaveCount(0);
  await expect(page.getByTestId('compare-candidate-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('compare-diff-summary')).toHaveText(
    '仅基线 0 · 仅候选 0 · 两者共有 1'
  );
});

test('换文件清空旧比较：载入新文件或解码失败均不保留候选结论', async ({ page }) => {
  await page.goto('/');
  const clipWav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 80, [{ start: 20, end: 22, targets: [0] }])
  });
  await loadFile(page, clipWav, 'first.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');

  // 应用候选规则，确认比较结果出现
  await page.getByTestId('rule-min-run').fill('5');
  await page.getByTestId('apply-rule').click();
  await expect(page.getByTestId('compare-result')).toBeVisible();
  await expect(page.getByTestId('compare-candidate-verdict')).toHaveText('可交付');

  // 载入另一个有效文件：旧比较被清空，输入框回到基线默认值
  const cleanWav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: new Array<number>(80).fill(0.01)
  });
  await loadFile(page, cleanWav, 'second.wav');
  await expect(page.getByTestId('verdict')).toHaveText('可交付');
  await expect(page.getByTestId('compare-result')).toHaveCount(0);
  await expect(page.getByTestId('compare-candidate-verdict')).toHaveCount(0);
  await expect(page.getByTestId('diff-row')).toHaveCount(0);
  await expect(page.getByTestId('rule-min-run')).toHaveValue('3');

  // 再次应用比较后，载入损坏文件：错误提示出现且旧比较同样被清空
  await page.getByTestId('apply-rule').click();
  await expect(page.getByTestId('compare-result')).toBeVisible();
  const truncated = clipWav.subarray(0, 60);
  await loadFile(page, truncated, 'broken.wav');
  await expect(page.getByTestId('error-panel')).toBeVisible();
  await expect(page.getByTestId('error-title')).toContainText('CORRUPT');
  await expect(page.getByTestId('compare-panel')).toHaveCount(0);

  // 重新载入有效文件：比较结果不会复活
  await loadFile(page, clipWav, 'third.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await expect(page.getByTestId('compare-result')).toHaveCount(0);
});
