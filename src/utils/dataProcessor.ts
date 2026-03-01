import { DataFrame, FieldType, GrafanaTheme2, dateTime, dateTimeFormat } from '@grafana/data';
import { HeatmapValue } from '../types';

type Aggregation = 'sum' | 'count' | 'avg' | 'max' | 'min';

export function processTimeSeriesData(series: DataFrame[], aggregation: Aggregation, timeZone?: string): HeatmapValue[] {
  const dailyData = new Map<string, number[]>();

  for (const frame of series) {
    const timeField = frame.fields.find((f) => f.type === FieldType.time);
    const valueField = frame.fields.find((f) => f.type === FieldType.number && f.name !== 'Time');

    if (!timeField || !valueField) {
      continue;
    }

    for (let i = 0; i < frame.length; i++) {
      const timestamp = timeField.values[i];
      const value = valueField.values[i];

      if (value === null || value === undefined || isNaN(value)) {
        continue;
      }

      const date = dateTimeFormat(dateTime(timestamp), {
        format: 'YYYY/MM/DD',
        timeZone,
      });

      if (!dailyData.has(date)) {
        dailyData.set(date, []);
      }
      dailyData.get(date)!.push(value);
    }
  }

  const result: HeatmapValue[] = [];

  dailyData.forEach((values, date) => {
    const count = aggregate(values, aggregation);

    // 把 [0, 0.01) 当作 “没有数据”：不生成 heatmap cell
    // 这样可以保证 0 不会落入任何颜色 bucket（避免被渲染成浅绿/浅蓝）
    if (count >= 0 && count < 0.01) {
      return;
    }

    result.push({ date, count: Math.round(count * 100) / 100 });
  });

  result.sort((a, b) => a.date.localeCompare(b.date));

  return result;
}

function aggregate(values: number[], method: Aggregation): number {
  if (values.length === 0) {
    return 0;
  }

  switch (method) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'count':
      return values.length;
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    default:
      return values.reduce((a, b) => a + b, 0);
  }
}

// --------------------
// Custom color helpers
// --------------------
type RGB = { r: number; g: number; b: number };

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseColorToRgb(input: string): RGB | null {
  const s = (input ?? '').trim();

  const hex = s.replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  const m = s.match(
    /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*(\d+(\.\d+)?|\.\d+))?\s*\)$/
  );
  if (m) {
    return {
      r: clampByte(Number(m[1])),
      g: clampByte(Number(m[2])),
      b: clampByte(Number(m[3])),
    };
  }

  return null;
}

function rgbToCss({ r, g, b }: RGB): string {
  return `rgb(${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)})`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function buildCustomLevels(base: RGB, theme: GrafanaTheme2): string[] {
  const white: RGB = { r: 255, g: 255, b: 255 };
  const black: RGB = { r: 0, g: 0, b: 0 };

  const levels = [
    rgbToCss(mix(base, white, 0.7)),
    rgbToCss(mix(base, white, 0.45)),
    rgbToCss(mix(base, black, 0.15)),
    rgbToCss(mix(base, black, 0.35)),
  ];

  return theme.isDark ? [...levels].reverse() : levels;
}

// --------------------
// Palette and Bucket mapping
// --------------------

export type BucketMode = 'auto' | 'custom';

// 固定：空白 [0, 0.01)；>= 0.01 上色
const MIN_COLORED_VALUE = 0.01;
// epsilon：用于把 “>=0.01 上色” 精确实现出来，避免小数边界误差
const MIN_EPS = 1e-12;

function parseStrictCustomBuckets(input: string): number[] | null {
  const parts = String(input)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (parts.length !== 4) {
    return null;
  }

  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) {
    return null;
  }

  // 必须以 0 开头，并严格递增
  if (nums[0] !== 0) {
    return null;
  }
  for (let i = 1; i < nums.length; i++) {
    if (!(nums[i] > nums[i - 1])) {
      return null;
    }
  }

  return nums;
}

function resolveColorLevels(
  scheme: string,
  theme: GrafanaTheme2,
  customColor?: string
): { emptyColor: string; levels: string[] } {
  const emptyColor = theme.colors.background.canvas;

  let colorLevels: string[] | null = null;

  if (scheme === 'custom') {
    const rgb = parseColorToRgb(customColor ?? '');
    if (rgb) {
      colorLevels = buildCustomLevels(rgb, theme);
    }
  }

  if (!colorLevels) {
    const supportedSchemes = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
    const hue = supportedSchemes.has(scheme) ? scheme : 'green';

    let shades = ['super-light', 'light', 'semi-dark', 'dark'];
    if (theme.isDark) {
      shades = Array.from(shades).reverse();
    }

    colorLevels = shades.map((shade) => theme.visualization.getColorByName(`${shade}-${hue}`));
  }

  return { emptyColor, levels: colorLevels };
}

/**
 * Legend colors (stable): [empty, level1, level2, level3, level4]
 * 用于 UI legend 渲染，避免从 thresholds 推导导致数量/顺序混乱。
 */
export function getLegendColors(
  scheme: string,
  theme: GrafanaTheme2,
  customColor?: string
): string[] {
  const { emptyColor, levels } = resolveColorLevels(scheme, theme, customColor);
  return [emptyColor, ...levels];
}

/**
 * Heatmap panelColors thresholds.
 * @uiw/react-heat-map picks the first threshold STRICTLY greater than count.
 *
 * We want: empty is [0, 0.01), colored is [0.01, ...]
 * So:
 * - threshold 0.01 -> emptyColor (covers count < 0.01)
 * - threshold 0.01+eps -> first color (covers count >= 0.01)
 */
export function getColorPalette(
  scheme: string,
  theme: GrafanaTheme2,
  maxCount: number,
  customColor?: string,
  bucketMode: BucketMode = 'auto',
  customBuckets?: string
): Record<number, string> {
  const { emptyColor, levels } = resolveColorLevels(scheme, theme, customColor);

  const min = MIN_COLORED_VALUE;
  const eps = MIN_EPS;

  // base thresholds: empty then first colored boundary
  const palette: Record<number, string> = {
    0: emptyColor,
    [min]: emptyColor,
    [min + eps]: levels[0],
  };

  if (bucketMode === 'custom') {
    const edges = parseStrictCustomBuckets(customBuckets ?? '');
    if (!edges) {
      // fallback to auto
      bucketMode = 'auto';
    } else {
      // edges: [0, b1, b2, b3]
      const [, b1, b2, b3] = edges;

      // 强制保证：从 >=0.01 开始必定上色
      const firstUpper = Math.max(b1, min + eps);

      // 左闭右开区间由 “严格大于阈值” 自然实现（阈值作为排他上界）
      // [min+eps, firstUpper) -> levels[0] （levels[0] 已经在 min+eps 处设置）
      palette[firstUpper] = levels[0];
      palette[b2] = levels[1];
      palette[b3] = levels[2];

      // >= b3 -> levels[3]
      palette[Number.MAX_SAFE_INTEGER] = levels[3];

      return palette;
    }
  }

  // --------
  // AUTO mode (quantiles) - FIXED for @uiw/react-heat-map:
  // thresholds are EXCLUSIVE upper bounds, strictly increasing,
  // and we ensure the last bucket can color max values.
  // --------
  const safeMax = Number.isFinite(maxCount) ? Math.max(0, Math.ceil(maxCount)) : 0;

  // Always keep 4 non-empty shades (levels[0..3]).
  // Build 4 exclusive upper bounds for them.
  const shadeQuantiles = [0.25, 0.5, 0.75, 1];

  let prev = min + eps;

  for (let i = 0; i < shadeQuantiles.length; i++) {
    // inclusive cutoff (integer)
    const cutoff = Math.round(safeMax * shadeQuantiles[i]);
    // exclusive upper bound: cutoff + 1
    const desiredUpper = cutoff + 1;

    // Must be > prev and at least > (min+eps)
    const upper = Math.max(prev + 1, Math.max(2, desiredUpper));

    palette[upper] = levels[i];
    prev = upper;
  }

  return palette;
}


