import { createHash } from 'node:crypto';
import { decisionBatchRequestSchema, type DecisionBatchRequest, type DecisionQuestion, type DecisionRequest } from '../../domain/decision/decision.js';
import { ImageMetadataSchema } from '../../domain/assets/image.js';
import { clefConfigSchema, type ClefConfigInput, type ClefImageResolver } from './config.js';

export const CLEF_MAX_IMAGES = 4;
export const CLEF_MAX_QUESTIONS = 64;
export const CLEF_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const CLEF_MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
export const CLEF_MAX_BODY_BYTES = 13 * 1024 * 1024;
export const CLEF_SAFE_CONTEXT_TOKENS = 51_200;
export const CLEF_IMAGE_TOKEN_ALLOWANCE = 1_027;

export class ClefCompilationError extends Error {
  constructor(readonly reason: string, readonly status: 'overflow' | 'unavailable') { super(reason); }
}

type ClefQuestion = { type: 'noul' | 'choice' | 'score'; instructions: string; criteria?: unknown };
export type CompiledClefRequest = {
  body: string;
  nonImageProjection: string;
  textEstimate: number;
  imageCount: number;
  imageTokenAllowance: number;
  imageBytes: number;
  bodyBytes: number;
};

function questionForClef(question: DecisionQuestion, imageIndexes: ReadonlyMap<string, number>): ClefQuestion {
  const criteria = question.type === 'choice' ? question.options : question.type === 'score' ? question.rubric : question.criteria;
  const indexes = question.visual?.mode === 'pixels' ? question.visual.materialIds.map((id) => imageIndexes.get(id)) : [];
  if (indexes.some((index) => index === undefined)) throw new ClefCompilationError('visual-image-reference-missing', 'unavailable');
  const imageNote = indexes.length ? `\nUse only attached image index${indexes.length === 1 ? '' : 'es'} ${indexes.join(', ')} for this question.` : '';
  const candidateMappings = question.type === 'choice' && question.materialOptions && question.visual?.mode === 'pixels'
    ? Object.entries(question.materialOptions).map(([optionId, materialId]) => {
      const index = imageIndexes.get(materialId);
      if (index === undefined) throw new ClefCompilationError('visual-choice-image-reference-missing', 'unavailable');
      return `Option ${JSON.stringify(optionId)} (${JSON.stringify(question.options[optionId])}) corresponds to attached image index ${index}.`;
    })
    : [];
  const mappingNote = candidateMappings.length ? `\nVisual choice mapping: ${candidateMappings.join(' ')}` : '';
  return { type: question.type, instructions: `${question.instructions}${imageNote}${mappingNote}`, ...(criteria === undefined ? {} : { criteria }) };
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export function compileClefRequest(input: DecisionRequest | DecisionBatchRequest, configInput: ClefConfigInput, imageResolver?: ClefImageResolver): CompiledClefRequest {
  const config = clefConfigSchema.parse(configInput);
  const rawQuestions = 'questions' in input ? input.questions : [input.question];
  const rawPixelIds = new Set(rawQuestions.flatMap((question) => question.visual?.mode === 'pixels' ? question.visual.materialIds : []));
  if (rawPixelIds.size > CLEF_MAX_IMAGES) throw new ClefCompilationError('image-count-exceeded', 'overflow');
  const request = 'questions' in input
    ? decisionBatchRequestSchema.parse(input)
    : { ...input, questions: [input.question], ...(input.visualMaterials ? { visualMaterials: input.visualMaterials } : {}) };
  if (request.questions.length > CLEF_MAX_QUESTIONS) throw new ClefCompilationError('question-count-exceeded', 'overflow');
  if (request.questions.some(({ id }) => !/^[A-Za-z0-9_.-]{1,100}$/.test(id))) throw new ClefCompilationError('question-id-unsupported', 'overflow');
  const bindings = request.questions.flatMap((question) => question.visual ? [{ question, mode: question.visual.mode, ids: question.visual.materialIds }] : []);
  const modeByMaterial = new Map<string, 'pixels' | 'described'>();
  for (const binding of bindings) for (const id of binding.ids) {
    const previous = modeByMaterial.get(id);
    if (previous !== undefined && previous !== binding.mode) throw new ClefCompilationError('visual-mode-conflict-in-batch', 'unavailable');
    modeByMaterial.set(id, binding.mode);
  }
  const metadataById = new Map((request.visualMaterials ?? []).map((material) => [material.id, material]));
  const materialOrder = Array.isArray(request.state.materialOrder) ? request.state.materialOrder as string[] : [];
  const singleQuestionOrder = request.questions.length === 1 ? request.questions[0]!.visual?.materialIds : undefined;
  const orderedMaterials = singleQuestionOrder ? [...singleQuestionOrder] : [...modeByMaterial.keys()].sort((left, right) => {
    const leftIndex = materialOrder.indexOf(left); const rightIndex = materialOrder.indexOf(right);
    if (leftIndex < 0 && rightIndex < 0) return left.localeCompare(right);
    if (leftIndex < 0) return 1;
    if (rightIndex < 0) return -1;
    return leftIndex - rightIndex;
  });
  const pixelIds = orderedMaterials.filter((id) => modeByMaterial.get(id) === 'pixels');
  if (pixelIds.length > CLEF_MAX_IMAGES) throw new ClefCompilationError('image-count-exceeded', 'overflow');
  const imageIndexes = new Map(pixelIds.map((id, index) => [id, index]));
  const images: string[] = [];
  const visualMaterials: Array<Record<string, unknown>> = [];
  let imageBytes = 0;
  for (const id of orderedMaterials) {
    const material = metadataById.get(id);
    if (!material) throw new ClefCompilationError('visual-image-reference-missing', 'unavailable');
    if (modeByMaterial.get(id) === 'pixels') {
      if (!imageResolver) throw new ClefCompilationError('image-asset-unavailable', 'unavailable');
      let resolved: ReturnType<ClefImageResolver['resolve']>;
      try { resolved = imageResolver.resolve(material.asset.assetId); }
      catch { throw new ClefCompilationError('image-asset-unavailable', 'unavailable'); }
      let actualMetadata;
      try { actualMetadata = ImageMetadataSchema.parse(resolved.metadata); }
      catch { throw new ClefCompilationError('image-metadata-invalid', 'unavailable'); }
      const bytes = Buffer.from(resolved.bytes);
      const actualDigest = sha256(bytes);
      if (actualMetadata.assetId !== material.asset.assetId || actualMetadata.sha256 !== material.asset.sha256 ||
          actualMetadata.bytes !== bytes.byteLength || actualDigest !== actualMetadata.sha256 ||
          JSON.stringify(actualMetadata) !== JSON.stringify(material.asset)) throw new ClefCompilationError('image-asset-integrity-failed', 'unavailable');
      if (actualMetadata.bytes > CLEF_MAX_IMAGE_BYTES) throw new ClefCompilationError('image-size-exceeded', 'overflow');
      if (actualMetadata.width * actualMetadata.height > 16_000_000) throw new ClefCompilationError('image-pixel-limit-exceeded', 'overflow');
      imageBytes += bytes.byteLength;
      if (imageBytes > CLEF_MAX_TOTAL_IMAGE_BYTES) throw new ClefCompilationError('total-image-size-exceeded', 'overflow');
      images.push(`data:image/${actualMetadata.format};base64,${bytes.toString('base64')}`);
      visualMaterials.push({ materialId: id, imageIndex: imageIndexes.get(id), ...(material.caption === undefined ? {} : { caption: material.caption }) });
    } else {
      const describingQuestionIds = bindings.filter((binding) => binding.mode === 'described' && binding.ids.includes(id)).map(({ question }) => question.id);
      visualMaterials.push({ materialId: id, describedFor: describingQuestionIds, altText: material.altText, ...(material.caption === undefined ? {} : { caption: material.caption }) });
    }
  }
  const state = { ...request.state, ...(visualMaterials.length ? { visualMaterials } : {}) };
  const questions = Object.fromEntries(request.questions.map((question) => [question.id, questionForClef(question, imageIndexes)]));
  const nonImageProjection = JSON.stringify({ model: config.model, state, questions });
  const textEstimate = Math.ceil(Buffer.byteLength(nonImageProjection, 'utf8') / 3);
  const imageTokenAllowance = images.length * CLEF_IMAGE_TOKEN_ALLOWANCE;
  if (textEstimate + imageTokenAllowance > CLEF_SAFE_CONTEXT_TOKENS) throw new ClefCompilationError('estimated-context-over-limit', 'overflow');
  const body = JSON.stringify({ model: config.model, state, questions, ...(images.length ? { images } : {}) });
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > CLEF_MAX_BODY_BYTES) throw new ClefCompilationError('request-body-size-exceeded', 'overflow');
  return { body, nonImageProjection, textEstimate, imageCount: images.length, imageTokenAllowance, imageBytes, bodyBytes };
}
