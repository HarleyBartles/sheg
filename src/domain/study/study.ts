import { z } from 'zod';
import { studyArmSchema } from './arm.js';

const prose = z.string().trim().min(1);

export const studyManifestSchema = z.object({
  version: z.literal('2.0'),
  study: z.object({
    title: prose,
    purpose: prose,
  }).strict(),
  arms: z.array(studyArmSchema).min(1),
}).strict().superRefine((study, context) => {
  const armIds = study.arms.map((arm) => arm.id);
  if (new Set(armIds).size !== armIds.length) {
    context.addIssue({ code: 'custom', path: ['arms'], message: 'Arm IDs must be unique within a study.' });
  }
  const visibleBytes = study.arms.reduce((total, arm) => total + arm.items.reduce((armTotal, item) => armTotal + Buffer.byteLength(item.text, 'utf8'), 0), 0);
  if (visibleBytes > 80_000) {
    context.addIssue({ code: 'custom', path: ['arms'], message: 'Study stimulus text exceeds the 80 KB limit.' });
  }
});

export type StudyManifest = z.infer<typeof studyManifestSchema>;
