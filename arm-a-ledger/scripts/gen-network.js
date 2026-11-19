// Generates a fresh 4-validator Besu QBFT network in network/generated/:
//   accounts.json (TEST-ONLY accounts from the public Hardhat test mnemonic),
//   qbftConfigFile.json -> Besu `operator generate-blockchain-config` -> genesis.json + 4 validator keys,
//   docker-compose.yml (fixed IPs, node 1 as bootnode).
// Usage: node scripts/gen-network.js            (needs Docker)
//        node scripts/gen-network.js --config-only
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HDNodeWallet } from 'ethers';

export const BESU_IMAGE = 'hyperledger/besu:26.10.0@sha256:7ce78163f9de6733bb868c8bd2ebb4e6e90cc7cb950034ff8c333b1a0c27aace';
export const CHAIN_ID = 1337;
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'; // public, test only
const ACCOUNTS = 11; // 0 = registrar/harness, 1..9 = trustees (up to n = 9), 10 = spare
const IPS = ['172.28.0.11', '172.28.0.12', '172.28.0.13', '172.28.0.14'];
const RPC_PORTS = [18545, 18546, 18547, 18548];

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'network', 'generated');

// Besu output is complete when genesis.json and 4 validator key folders exist.
const generatedComplete = () => {
  const nf = join(out, 'networkFiles');
  return existsSync(join(nf, 'genesis.json')) && existsSync(join(nf, 'keys'))
    && readdirSync(join(nf, 'keys')).filter((d) => existsSync(join(nf, 'keys', d, 'key.pub'))).length === 4;
};
if (existsSync(join(out, 'networkFiles')) && !generatedComplete()) {
  console.error(`Incomplete network in ${join(out, 'networkFiles')}. Delete that folder by hand and run again.`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });

// 1. Test accounts
const accounts = Array.from({ length: ACCOUNTS }, (_, i) => {
  const w = HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
  return { index: i, address: w.address, privateKey: w.privateKey };
});
writeFileSync(join(out, 'accounts.json'), JSON.stringify({ note: 'TEST ONLY - public mnemonic, never use on a real network', accounts }, null, 2));

// 2. QBFT config (London EVM, zero base fee, block period 2 s - design Sections 5 and 6)
const alloc = Object.fromEntries(accounts.map((a) => [a.address.slice(2).toLowerCase(), { balance: '0xd3c21bcecceda1000000' }]));
const qbftConfig = {
  genesis: {
    config: {
      chainId: CHAIN_ID,
      berlinBlock: 0,
      londonBlock: 0,
      zeroBaseFee: true,
      qbft: { blockperiodseconds: 2, epochlength: 30000, requesttimeoutseconds: 4 },
    },
    nonce: '0x0',
    timestamp: '0x0',
    gasLimit: '0x1fffffffffffff',
    difficulty: '0x1',
    mixHash: '0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365',
    coinbase: '0x0000000000000000000000000000000000000000',
    alloc,
  },
  blockchain: { nodes: { generate: true, count: 4 } },
};
writeFileSync(join(out, 'qbftConfigFile.json'), JSON.stringify(qbftConfig, null, 2));
console.log(`wrote accounts.json and qbftConfigFile.json in ${out}`);
if (process.argv.includes('--config-only')) process.exit(0);

// 3. Besu generates genesis.json (with validator extraData) and the 4 validator keys
// Skipped when a complete output already exists. Besu may print "Output directory already exists"
// after writing the files; the output is checked instead of the exit code.
if (!generatedComplete()) {
  spawnSync('docker', [
    'run', '--rm', '-v', `${out}:/data`, BESU_IMAGE,
    'operator', 'generate-blockchain-config',
    '--config-file=/data/qbftConfigFile.json', '--to=/data/networkFiles', '--private-key-file-name=key',
  ], { stdio: 'inherit' });
}
if (!generatedComplete()) { console.error('besu operator failed: genesis.json or validator keys missing'); process.exit(1); }
console.log('besu operator output OK (genesis.json + 4 validator keys)');

copyFileSync(join(out, 'networkFiles', 'genesis.json'), join(out, 'genesis.json'));
const keyDirs = readdirSync(join(out, 'networkFiles', 'keys')).sort();
if (keyDirs.length !== 4) { console.error(`expected 4 validator keys, found ${keyDirs.length}`); process.exit(1); }
const pubs = keyDirs.map((d, i) => {
  const nodeDir = join(out, `node${i + 1}`);
  mkdirSync(nodeDir, { recursive: true });
  copyFileSync(join(out, 'networkFiles', 'keys', d, 'key'), join(nodeDir, 'key'));
  return readFileSync(join(out, 'networkFiles', 'keys', d, 'key.pub'), 'utf8').trim().replace(/^0x/, '');
});
const bootnode = `enode://${pubs[0]}@${IPS[0]}:30303`;

// 4. docker-compose.yml: data inside containers, so `down -v` gives a fresh chain per run
const service = (i) => `  besu${i + 1}:
    image: ${BESU_IMAGE}
    container_name: etr-besu${i + 1}
    cpus: 1.0
    restart: "no"
    environment:
      BESU_OPTS: "-Xmx1g"
    volumes:
      - ./genesis.json:/config/genesis.json:ro
      - ./node${i + 1}/key:/config/key:ro
    command:
      - --data-path=/opt/besu/data
      - --genesis-file=/config/genesis.json
      - --node-private-key-file=/config/key
      - --p2p-host=${IPS[i]}
      - --p2p-port=30303
      - --rpc-http-enabled
      - --rpc-http-host=0.0.0.0
      - --rpc-http-port=8545
      - --rpc-http-api=ETH,NET,QBFT,WEB3,ADMIN,TXPOOL
      - --host-allowlist=*
      - --rpc-http-cors-origins=all
      - --min-gas-price=0
${i === 0 ? '' : `      - --bootnodes=${bootnode}\n`}    networks:
      besu:
        ipv4_address: ${IPS[i]}
    ports:
      - "${RPC_PORTS[i]}:8545"
`;
writeFileSync(join(out, 'docker-compose.yml'), `# Generated by scripts/gen-network.js - Arm A: 4-validator Besu QBFT network
networks:
  besu:
    ipam:
      config:
        - subnet: 172.28.0.0/24
services:
${[0, 1, 2, 3].map(service).join('')}`);
writeFileSync(join(out, 'network.json'), JSON.stringify({
  chainId: CHAIN_ID, image: BESU_IMAGE, validators: keyDirs, rpc: RPC_PORTS.map((p) => `http://127.0.0.1:${p}`),
}, null, 2));
console.log(JSON.stringify({ validators: keyDirs, rpc: RPC_PORTS }));
