import { DataFrame, FieldType, GrafanaTheme2, dateTime, dateTimeFormat } from '@grafana/data';
import { HeatmapValue } from '../types';

type Aggregation = 'sum' | 'count' | 'avg' | 'max' | 'min';

export function processTimeSeriesData(
  series: DataFrame[],
  aggregation: Aggregation,
  timeZone?: string
): HeatmapValue[] {
  const dailyData = new Map<string, number[]>();

  // Iterate through all data frames
  for (const frame of series) {
    const timeField = frame.fields.find((f) => f.type === FieldType.time);
    const valueField = frame.fields.find((f) => f.type === FieldType.number && f.name !== 'Time');

    if (!timeField || !valueField) {
      continue;
    }

    // Group values by date (using Grafana timezone passed from panel props)
    for (let i = 0; i < frame.length; i++) {
      const timestamp = timeField.values[i];
      const value = valueField.values[i];

      if (value === null || value === undefined || isNaN(value)) {
        continue;
      }

      // IMPORTANT: pass Grafana's timezone so day-bucketing follows dashboard/user settings
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

  // Apply aggregation
  const result: HeatmapValue[] = [];

  dailyData.forEach((values, date) => {
    const count = aggregate(values, aggregation);
    result.push({ date, count: Math.round(count * 100) / 100 });
  });

  // Sort by date
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

  // #RGB / #RRGGBB
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

  // rgb() / rgba()
  // - Allow spaces
  // - Accept alpha but ignore it (heatmap expects solid fills anyway)
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

  // 4 levels to match existing legend stability:
  // super-light, light, semi-dark, dark
  const levels = [
    rgbToCss(mix(base, white, 0.7)),
    rgbToCss(mix(base, white, 0.45)),
    rgbToCss(mix(base, black, 0.15)),
    rgbToCss(mix(base, black, 0.35)),
  ];

  // reverse in dark mode for perceived contrast
  return theme.isDark ? [...levels].reverse() : levels;
}

export function getColorPalette(
  scheme: string,
  theme: GrafanaTheme2,
  maxCount: number,
  customColor?: string
): Record<number, string> {
  const emptyColor = theme.colors.background.canvas;

  // @uiw/react-heat-map chooses the first threshold strictly greater than `count`.
  // That means a `count` of 0 would otherwise take the first non-zero bucket color.
  // Adding a `1: emptyColor` threshold makes 0 render as empty.
  const emptyUpperBound = 1;

  // Always expose 4 non-empty shades, regardless of maxCount, to keep the legend stable.
  // We generate strictly increasing *exclusive upper bounds* for the 4 shade buckets.
  const safeMax = Number.isFinite(maxCount) ? Math.max(0, Math.ceil(maxCount)) : 0;
  const shadeQuantiles = [0.25, 0.5, 0.75, 1];

  // Choose 4 colors (either built-in or derived from customColor)
  let colorLevels: string[] | null = null;

  if (scheme === 'custom') {
    const rgb = parseColorToRgb(customColor ?? '');
    if (rgb) {
      colorLevels = buildCustomLevels(rgb, theme);
    }
  }

  if (!colorLevels) {
    // Fallback to built-in theme colors
    const supportedSchemes = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
    const hue = supportedSchemes.has(scheme) ? scheme : 'green';

    let shades = ['super-light', 'light', 'semi-dark', 'dark'];
    if (theme.isDark) {
      shades = Array.from(shades).reverse();
    }

    colorLevels = shades.map((shade) => theme.visualization.getColorByName(`${shade}-${hue}`));
  }

  const palette: Record<number, string> = {
    0: emptyColor,
    [emptyUpperBound]: emptyColor,
  };

  let prev = emptyUpperBound;
  for (let i = 0; i < shadeQuantiles.length; i++) {
    // desired is (inclusive cutoff) + 1 to make it an exclusive upper bound
    const desired = Math.round(safeMax * shadeQuantiles[i]) + 1;
    const bound = Math.max(prev + 1, Math.max(2, desired));
    palette[bound] = colorLevels[i];
    prev = bound;
  }

  return palette;
}