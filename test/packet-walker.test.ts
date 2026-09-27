import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadRespondents } from '../src/domain/respondents/cohort.js';
import { walkStudyPackets, type PreflightPacket } from '../src/domain/journey/packet-walker.js';
import { studyManifestSchema } from '../src/domain/study/study.js';
import type { StudyArm } from '../src/domain/study/arm.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const study = studyManifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('article.json', fixtures)), 'utf8')));
const arm = study.arms[0]!;
const profile = loadRespondents(JSON.parse(readFileSync(fileURLToPath(new URL('cohort.json', fixtures)), 'utf8')))[0]!;

test('walks every graph path for each arm and respondent in stable order', () => {
  const secondArm = { ...arm, id: 'revision', label: 'Revision' };
  const secondRespondent = { ...profile, id: 'reader-two' };
  const packets: PreflightPacket[] = [];
  const result = walkStudyPackets([arm, secondArm], [profile, secondRespondent], (packet) => packets.push(packet));

  assert.equal(result.status, 'complete');
  assert.equal(result.terminalJourneyCount, 20);
  assert.equal(result.packetCount, 12);
  assert.equal(new Set(packets.map((packet) => packet.packetId)).size, packets.length);
  assert.deepEqual(packets.filter((packet) => packet.armId === arm.id && packet.respondentId === profile.id)
    .map((packet) => [packet.nodeId, packet.pathId]), [
    ['choose-entry', 'root'],
    ['choose-investigation', 'choose-entry=continue'],
    ['choose-notes', 'choose-entry=continue>choose-investigation=open-notes'],
  ]);
  const repeated: PreflightPacket[] = [];
  const repeatedResult = walkStudyPackets([arm, secondArm], [profile, secondRespondent], (packet) => repeated.push(packet));
  assert.deepEqual(packets, repeated);
  assert.deepEqual(result, repeatedResult);
});

test('preserves distinct histories at a reconverged decision node', () => {
  const reconvergedArm: StudyArm = {
    ...arm,
    presentation: {
      kind: 'graph',
      entryNodeId: 'start',
      maxDecisions: 2,
      nodes: [
        { id: 'start', kind: 'ask', taskId: 'entry-response' },
        { id: 'expose-symptom', kind: 'expose', itemId: 'symptom' },
        { id: 'expose-investigation', kind: 'expose', itemId: 'investigation' },
        { id: 'merge', kind: 'ask', taskId: 'entry-response' },
        { id: 'finished', kind: 'terminal', outcome: 'finished' },
      ],
      transitions: [
        { fromNodeId: 'start', optionId: 'continue', toNodeId: 'expose-symptom' },
        { fromNodeId: 'start', optionId: 'leave', toNodeId: 'expose-investigation' },
        { fromNodeId: 'expose-symptom', toNodeId: 'merge' },
        { fromNodeId: 'expose-investigation', toNodeId: 'merge' },
        { fromNodeId: 'merge', optionId: 'continue', toNodeId: 'finished' },
        { fromNodeId: 'merge', optionId: 'leave', toNodeId: 'finished' },
      ],
    },
  };
  const packets: PreflightPacket[] = [];
  const result = walkStudyPackets([reconvergedArm], [profile], (packet) => packets.push(packet));
  const mergedPackets = packets.filter((packet) => packet.nodeId === 'merge');

  assert.equal(result.status, 'complete');
  assert.equal(result.terminalJourneyCount, 4);
  assert.equal(mergedPackets.length, 2);
  assert.notEqual(mergedPackets[0]!.packetId, mergedPackets[1]!.packetId);
  assert.deepEqual(mergedPackets.map((packet) => packet.request.state.trajectory.choices[0]?.choiceId), ['continue', 'leave']);
  assert.deepEqual(mergedPackets.map((packet) => packet.request.state.encounteredItems.map((item) => item.id)), [['symptom'], ['investigation']]);
});

test('enumerates every sequence response history and keeps all stimuli in each packet', () => {
  const sequenceArm: StudyArm = {
    ...arm,
    tasks: [arm.tasks[0]!, { ...arm.tasks[0]!, id: 'follow-up' }],
    presentation: { kind: 'sequence' },
  };
  const packets: PreflightPacket[] = [];
  const result = walkStudyPackets([sequenceArm], [profile], (packet) => packets.push(packet));

  assert.equal(result.status, 'complete');
  assert.equal(result.terminalJourneyCount, 4);
  assert.equal(result.packetCount, 3);
  assert.deepEqual(packets.map((packet) => packet.pathId), ['root', 'sequence-ask-entry-response=continue', 'sequence-ask-entry-response=leave']);
  assert.ok(packets.every((packet) => packet.request.state.encounteredItems.map((item) => item.id).join(',') === arm.items.map((item) => item.id).join(',')));
});

test('returns incomplete rather than dropping work at the packet ceiling or on a cycle', () => {
  const packets: PreflightPacket[] = [];
  const limited = walkStudyPackets([arm], [profile], (packet) => packets.push(packet), { maxPackets: 1 });
  assert.equal(limited.status, 'incomplete');
  assert.equal(limited.packetCount, 1);
  assert.equal(packets.length, 1);
  assert.match(limited.incompleteReason ?? '', /packet limit/i);

  const retained: PreflightPacket[] = [];
  const byteLimited = walkStudyPackets([arm], [profile], (packet) => retained.push(packet), { maxPacketBytes: 1 });
  assert.equal(byteLimited.status, 'incomplete');
  assert.equal(byteLimited.packetCount, 0);
  assert.equal(retained.length, 0);
  assert.match(byteLimited.incompleteReason ?? '', /byte limit/i);

  const graph = structuredClone(arm.presentation);
  assert.equal(graph.kind, 'graph');
  graph.transitions.find((edge) => edge.fromNodeId === 'show-symptom')!.toNodeId = 'show-symptom';
  const invalidArm = { ...arm, presentation: graph } as StudyArm;
  const cyclic = walkStudyPackets([invalidArm], [profile], () => {});
  assert.equal(cyclic.status, 'incomplete');
  assert.match(cyclic.incompleteReason ?? '', /cycle/i);
});
