// Compiles contracts/ExamRelease.sol with the pinned solc-js and writes build/ExamRelease.json.
// evmVersion "london" matches the network genesis (londonBlock 0).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import solc from 'solc';

const source = readFileSync(new URL('../contracts/ExamRelease.sol', import.meta.url), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'ExamRelease.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'london',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
const c = out.contracts['ExamRelease.sol'].ExamRelease;
mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
writeFileSync(new URL('../build/ExamRelease.json', import.meta.url), JSON.stringify({
  compiler: solc.version(), evmVersion: 'london', optimizerRuns: 200, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object,
}, null, 2));
console.log(JSON.stringify({ compiler: solc.version(), bytecodeBytes: c.evm.bytecode.object.length / 2, abiEntries: c.abi.length }));
