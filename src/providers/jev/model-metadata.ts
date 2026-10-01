import type { JevRoute } from './config.js';

export type JevModelMetadata = {
  contextLimit: number | null;
  contextEvidence?: { sourceUrl: string; checkedOn: string };
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  priceEvidence?: { sourceUrl: string; checkedOn: string };
};

export const jevModelMetadata: Record<JevRoute, Record<string, JevModelMetadata>> = {
  openrouter: {
    'typesafe/jev-1.13': {
      contextLimit: 32_768,
      contextEvidence: {
        sourceUrl: 'https://openrouter.ai/typesafe/jev-1.13/',
        checkedOn: '2026-09-30',
      },
      inputUsdPerMillion: 0.042,
      outputUsdPerMillion: 0,
      priceEvidence: {
        sourceUrl: 'https://openrouter.ai/typesafe/jev-1.13/',
        checkedOn: '2026-09-30',
      },
    },
  },
  typesafe: {
    'jev-latest': {
      contextLimit: null,
      inputUsdPerMillion: 0.042,
      outputUsdPerMillion: 0,
      priceEvidence: {
        sourceUrl: 'https://typesafe.ai/blog/introducing-system-one-models-and-jev',
        checkedOn: '2026-09-30',
      },
    },
  },
};

export function jevMetadata(route: JevRoute, model: string): JevModelMetadata | undefined {
  return jevModelMetadata[route][model];
}
