# Calendar Heatmap Panel - Technical Documentation

This document is for developers working on the Calendar Heatmap Panel source. For end-user guidance, see the root [README](../README.md).

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Component Breakdown](#component-breakdown)
- [Data Flow](#data-flow)
- [Key Algorithms](#key-algorithms)
- [Styling Approach](#styling-approach)
- [Testing Strategy](#testing-strategy)
- [Performance Considerations](#performance-considerations)
- [Extending the Plugin](#extending-the-plugin)
- [Build & Tooling](#build--tooling)

## Architecture Overview

- **Framework:** React 18 + TypeScript 5.9
- **Visualization:** `@uiw/react-heat-map`
- **Build:** Webpack 5 with SWC
- **Target:** Grafana 11.6+ panel plugin

```
src/
├── components/              # UI components
│   └── CalendarHeatmapPanel.tsx
├── utils/                   # Pure utilities (aggregation, palettes)
│   └── dataProcessor.ts
├── types.ts                 # Shared types
├── module.ts                # Plugin registration & options
└── plugin.json              # Plugin manifest
```

Design principles:

- Pure, testable utilities for data processing
- Memoized, theme-aware UI rendering
- Strict typing and explicit props
- Separation of data logic (utils) from rendering (components)

## Component Breakdown

### CalendarHeatmapPanel.tsx

Responsibilities:

- Parse Grafana `DataFrame[]` into daily buckets
- Compute responsive cell sizing (auto-size vs fixed)
- Render heatmap, labels, legend, and tooltips
- Apply color palettes based on theme and chosen scheme

Key hooks and computations:

```typescript
const heatmapData = useMemo(
  () => processTimeSeriesData(data.series, options.aggregation),
  [data.series, options.aggregation]
);

const rectSize = useMemo(
  () =>
    computeRectSize({
      auto: options.autoRectSize,
      requested: options.rectSize,
      spacing: options.space,
      weekCount,
      availableWidth,
      showWeekLabels: options.showWeekLabels,
    }),
  [options.autoRectSize, options.rectSize, options.space, weekCount, availableWidth, options.showWeekLabels]
);

const palette = useMemo(
  () => getColorPalette(options.colorScheme, theme, maxValue),
  [options.colorScheme, theme, maxValue]
);
```

### dataProcessor.ts

- `processTimeSeriesData(series, aggregation)` — converts `DataFrame[]` to `HeatmapValue[]` grouped by YYYY/MM/DD.
- `aggregate(values, method)` — sum, count, average, max, min.
- `getColorPalette(scheme, theme, max)` — returns intensity stops keyed by thresholds.
- `formatDate(date)` — normalizes to `YYYY/MM/DD` for heatmap keys.

### module.ts

Defines panel registration and options UI:

- Color scheme select
- Auto-size toggle and size/spacing sliders
- Label and legend toggles
- Aggregation select and tooltip toggle

### types.ts

Central types:

```typescript
export type Aggregation = 'sum' | 'count' | 'avg' | 'max' | 'min';

export interface CalendarHeatmapOptions {
  colorScheme: 'green' | 'blue' | 'red' | 'yellow' | 'purple' | 'orange';
  autoRectSize: boolean;
  rectSize: number;
  space: number;
  radius: number;
  showWeekLabels: boolean;
  showMonthLabels: boolean;
  showLegend: boolean;
  aggregation: Aggregation;
  showTooltip: boolean;
}

export interface HeatmapValue {
  date: string; // YYYY/MM/DD
  count: number;
}
```

## Data Flow

```
Grafana queries → DataFrame[] → processTimeSeriesData → HeatmapValue[]
                                     ↓
                             Aggregation by day
                                     ↓
                        Palette + layout computations
                                     ↓
                             @uiw/react-heat-map
```

1. **Input**: time field + numeric field from each `DataFrame`.
2. **Grouping**: bucket timestamps to day precision.
3. **Aggregation**: apply selected method per day.
4. **Formatting**: produce `HeatmapValue[]` sorted by date.
5. **Rendering**: heatmap with palette, labels, and tooltips.

## Key Algorithms

### Aggregation

```typescript
function aggregate(values: number[], method: Aggregation): number {
  if (values.length === 0) return 0;
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
  }
}
```

### Auto cell sizing

```typescript
export function computeRectSize({
  auto,
  requested,
  spacing,
  weekCount,
  availableWidth,
  showWeekLabels,
}: {
  auto: boolean;
  requested: number;
  spacing: number;
  weekCount: number;
  availableWidth: number;
  showWeekLabels: boolean;
}): number {
  if (!auto) return requested;
  const leftPad = showWeekLabels ? 28 : 6;
  const usable = Math.max(0, availableWidth - leftPad);
  const raw = Math.floor(usable / Math.max(1, weekCount)) - spacing;
  return Math.max(8, Math.min(20, raw));
}
```

### Palette generation

```typescript
export function getColorPalette(
  scheme: CalendarHeatmapOptions['colorScheme'],
  theme: GrafanaTheme2,
  maxCount: number
): Record<number, string> {
  const safeMax = Number.isFinite(maxCount) ? Math.max(0, Math.ceil(maxCount)) : 0;
  const quantiles = [0.25, 0.5, 0.75, 1];
  const shades = ['-1', '-2', '-3', '-4']; // theme color suffixes

  const palette: Record<number, string> = { 0: theme.colors.background.canvas };
  let prev = 0;
  for (let i = 0; i < quantiles.length; i++) {
    const bound = Math.max(prev + 1, Math.round(safeMax * quantiles[i]) || 1);
    palette[bound] = theme.visualization.getColorByName(`${scheme}${shades[i]}`);
    prev = bound;
  }
  return palette;
}
```

## Styling Approach

- Emotion CSS co-located with components.
- Theme awareness via `useTheme2()`; prefer theme tokens for text, backgrounds, borders.
- Keep layout responsive: width/height from panel props, auto cell sizing when enabled.
- Avoid inline style churn; memoize style objects when they depend on theme/options.

## Testing Strategy

- **Unit (Jest):** aggregation, palette generation, date formatting, auto-size logic.
- **Component (React Testing Library):** rendering heatmap, labels, legend toggles, tooltip visibility.
- **E2E (Playwright):** panel renders with data, color scheme change updates cells, tooltips show values.
- **Type Safety:** `npm run typecheck` in CI.

Example unit test target areas:

- Empty data returns empty array
- Aggregations per method
- Palette thresholds monotonic and include zero bucket
- Auto-size clamps between 8–20 px

## Performance Considerations

- Single-pass aggregation using `Map` for daily buckets.
- Memoize heavy computations (`useMemo` for data, palette, sizing; `useCallback` for tooltip renderers).
- Avoid re-creating large arrays in render; derive once per dependency change.
- Keep DOM light: conditional render of labels/legend; prefer `React.memo` for static subcomponents.
- Defer expensive formatting in tooltips where possible.

## Extending the Plugin

- **New color scheme:** update `CalendarHeatmapOptions` union, add select option, extend palette mapping, add tests.
- **New aggregation:** add to `Aggregation` union, implement branch in `aggregate`, expose in options, test thoroughly.
- **New layout option:** add to `CalendarHeatmapOptions`, wire in `module.ts`, consume in component, test behavior.
- **Data validation:** keep error messages user-friendly; fail soft with empty state and guidance.

## Build & Tooling

- **Build:** `npm run build` (Webpack + SWC)
- **Dev server:** `npm run dev`
- **Typecheck:** `npm run typecheck`
- **Lint:** `npm run lint`
- **Tests:** `npm run test` / `npm run test:ci` / `npm run e2e`
- **Signing:** `npm run sign`

Artifacts in `dist/`: bundled `module.js`, `plugin.json`, and assets ready for Grafana plugin loading.

---

Maintain this document when architecture, options, or key flows change to keep contributors aligned.
