// Arm A plumbing: providers, test accounts, contract deployment and exam registration.
import { readFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet, ContractFactory, Contract, FetchRequest } from 'ethers';

const here = (p) => new URL(p, import.meta.url);
export const artifact = JSON.parse(readFileSync(here('../build/ExamRelease.json'), 'utf8'));
export const network = JSON.parse(readFileSync(here('../network/generated/network.json'), 'utf8'));
export const accounts = JSON.parse(readFileSync(here('../network/generated/accounts.json'), 'utf8')).accounts;
// RPC endpoints: network.json (host ports) by default; RPC_URLS overrides them inside containers.
export const rpcUrls = process.env.RPC_URLS ? process.env.RPC_URLS.split(',') : network.rpc;

// Zero-fee private network: legacy transactions with gasPrice 0 (node runs with --min-gas-price=0).
export const TX = { type: 0, gasPrice: 0n };

// Per-request timeout, same as Arm B's etcd client (EtcdStore, 2 s): a request to a crashed or silent node
// fails after RPC_TIMEOUT_MS instead of ethers' default 300 s, so clients can fail over (F6/F7).
export const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 2000);

export function makeProvider(url) {
  const req = new FetchRequest(url);
  req.timeout = RPC_TIMEOUT_MS;
  const p = new JsonRpcProvider(req, network.chainId, { staticNetwork: true });
  p.pollingInterval = 250;
  return p;
}

export function wallet(index, url = rpcUrls[0]) {
  return new Wallet(accounts[index].privateKey, makeProvider(url));
}

export async function deploy(registrar = wallet(0)) {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, registrar);
  const c = await factory.deploy(TX);
  const receipt = await c.deploymentTransaction().wait();
  return { address: await c.getAddress(), gasUsed: receipt.gasUsed };
}

export function contractAt(address, runner) {
  return new Contract(address, artifact.abi, runner);
}

// Contract time is in whole seconds; T0 is rounded up so the contract never releases early.
export const toChainSeconds = (t0Ms) => BigInt(Math.ceil(t0Ms / 1000));

export async function registerExam(address, registrar, examId, meta, trusteeIndexes) {
  const c = contractAt(address, registrar);
  const tx = await c.registerExam(
    examId, toChainSeconds(meta.t0Ms), meta.k,
    trusteeIndexes.map((i) => accounts[i].address),
    meta.commitments.map((h) => `0x${h}`),
    TX,
  );
  const receipt = await tx.wait();
  return { gasUsed: receipt.gasUsed };
}
