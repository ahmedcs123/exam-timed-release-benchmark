// Usage: node scripts/make-exam.js --seed 42 --size 5MB
// Writes exams/exam_seed42_5MB.bin and prints its SHA-256.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { generateExam, parseSize, sha256Hex } from '../src/exam.js';

const { values } = parseArgs({ options: { seed: { type: 'string', default: '42' }, size: { type: 'string', default: '5MB' } } });
const exam = generateExam(values.seed, parseSize(values.size));
mkdirSync('exams', { recursive: true });
const file = `exams/exam_seed${values.seed}_${values.size.toUpperCase()}.bin`;
writeFileSync(file, exam);
console.log(JSON.stringify({ file, bytes: exam.length, sha256: sha256Hex(exam) }));
