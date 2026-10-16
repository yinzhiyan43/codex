import { StdioWorkbenchHost } from '../desktop-host/stdio-host.ts';
import { prepareIsolatedCore } from '../desktop-host/isolated-core.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const synthetic = [
  { id: '00000000-0000-4000-8000-000000000781', archived: false, source: 'vscode', time: '2026-10-15T12:00:00Z' },
  { id: '00000000-0000-4000-8000-000000000782', archived: false, source: { custom: 'chatgpt' }, time: '2026-10-14T12:00:00Z' },
  { id: '00000000-0000-4000-8000-000000000783', archived: true, source: 'vscode', time: '2026-10-13T12:00:00Z' },
];

function options() {
  const result = { runsDirectory: null, resultPath: null };
  for (let i = 2; i < process.argv.length; i += 2) {
    const value = process.argv[i + 1];
    if (!value || !isAbsolute(value)) throw new Error('invalid-option');
    if (process.argv[i] === '--runs-directory' && !result.runsDirectory) result.runsDirectory = value;
    else if (process.argv[i] === '--result' && !result.resultPath) result.resultPath = value;
    else throw new Error('invalid-option');
  }
  return result;
}

async function verifyContracts(binarySha256) {
  const spec = JSON.parse(await readFile(join(root, 'contracts/spec.json'), 'utf8'));
  if (spec.experimental.generator.version !== '0.162.1' || spec.experimental.generator.binarySha256 !== binarySha256) throw new Error('binary-provenance-mismatch');
  for (const name of ['threadSearchParams', 'threadSearchResult']) {
    const entry = spec.experimental.generatedSchemas[name];
    if (!entry || !entry.path.startsWith('contracts/experimental/')) throw new Error('contract-provenance-mismatch');
    const bytes = await readFile(join(root, entry.path));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('contract-hash-mismatch');
  }
}

async function seedSyntheticRollouts(prepared) {
  for (const thread of synthetic) {
    const directory = join(prepared.codexHome, thread.archived ? 'archived_sessions' : 'sessions', '2026', '10', thread.time.slice(8, 10));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `rollout-${thread.time.replaceAll(':', '-').replace('Z', '')}-${thread.id}.jsonl`;
    const line = (type, payload) => JSON.stringify({ timestamp: thread.time, type, payload });
    const meta = { id: thread.id, session_id: thread.id, timestamp: thread.time, cwd: prepared.cwd, originator: 'synthetic-search-check', cli_version: '0.162.1', source: thread.source, model_provider: 'openai' };
    const contents = [
      line('session_meta', { meta }),
      line('event_msg', { type: 'user_message', message: 'Synthetic baseline heading', kind: 'plain' }),
      line('event_msg', { type: 'agent_message', message: 'SYNTHETIC PROBE needle in body' }),
    ].join('\n') + '\n';
    await writeFile(join(directory, filename), contents, { mode: 0o600 });
  }
}


async function main() {
  const { runsDirectory, resultPath } = options();
  const base = runsDirectory ?? join(root, 'tests/real-core/.runs');
  let prepared, host; const methods=[];
  try {
    prepared = await prepareIsolatedCore(base);
    await verifyContracts(prepared.identity.sha256);
    await seedSyntheticRollouts(prepared);
    host=new StdioWorkbenchHost(()=>{
      const child=prepared.launcher(),write=child.stdin.write.bind(child.stdin);
      child.stdin.write=(data,...args)=>{for(const line of String(data).trim().split('\n'))methods.push(JSON.parse(line).method);return Reflect.apply(write,child.stdin,[data,...args]);};
      return child;
    },{searchApi:true,requestTimeoutMs:12000,shutdownGraceMs:1000,closeTimeoutMs:3000});
    await host.start();const client=host.client();
    const request=async(method,params)=>({result:await(method==='thread/search'?client.searchThreads(params):client.listThreads(params))});
    const checked=await (async()=>{
      const first = await request('thread/search', { searchTerm: 'needle', limit: 1 });
      if (first.result?.data?.length !== 1 || !first.result.nextCursor) throw new Error('first-page-failed');
      const second = await request('thread/search', { searchTerm: 'needle', limit: 1, cursor: first.result.nextCursor });
      const archived = await request('thread/search', { searchTerm: 'needle', limit: 10, archived: true });
      const titleOnly = await request('thread/list', { searchTerm: 'needle', limit: 10 });
      const rows = [...first.result.data, ...(second.result?.data ?? [])];
      const nonarchivedIds = synthetic.filter(thread => !thread.archived).map(thread => thread.id).sort();
      return {
        firstPageCount: first.result.data.length,
        secondPageCount: second.result?.data?.length ?? 0,
        finalCursorNull: second.result?.nextCursor === null,
        interactiveSourcesIncluded: JSON.stringify(rows.map(row => row.thread.id).sort()) === JSON.stringify(nonarchivedIds),
        bodyMarkerInSnippets: rows.every(row => row.snippet.includes('needle')),
        bodyMarkerAbsentFromTitles: rows.every(row => !(row.thread.name ?? row.thread.preview ?? '').includes('needle')),
        archivedOnlyResult: archived.result?.data?.length === 1 && archived.result.data[0].thread.id === synthetic[2].id,
        titleOnlySearchCount: titleOnly.result?.data?.length ?? -1,
      };
    })();
    await host.dispose();
    if(host.getView().processActive||methods.some(method=>['turn/start','thread/start','thread/resume','account/read'].includes(method)))throw new Error('unexpected-native-action');
    const result = { check: 'isolated-native-session-search', coreVersion: prepared.identity.version, binarySha256: prepared.identity.sha256, syntheticThreadCount: synthetic.length, modelRequests: 0, loginRequests: 0, networkAllowed: false, adapterSchemaValidated:true, cleanupConfirmed:!host.getView().processActive, methods, ...checked };
    if (checked.firstPageCount !== 1 || checked.secondPageCount !== 1 || !checked.finalCursorNull || !checked.interactiveSourcesIncluded || !checked.bodyMarkerInSnippets || !checked.bodyMarkerAbsentFromTitles || !checked.archivedOnlyResult || checked.titleOnlySearchCount !== 0) throw new Error('search-assertion-failed');
    const json = JSON.stringify(result, null, 2) + '\n';
    if (resultPath) await writeFile(resultPath, json, { flag: 'wx', mode: 0o600 });
    else process.stdout.write(json);
  } finally {
    if(host)await host.dispose();
    if(prepared&&(!host||!host.getView().processActive))await rm(prepared.directory,{recursive:true,force:true});
  }
}

main().catch(() => { process.stderr.write('session-search-core-check failed\n'); process.exitCode = 1; });
