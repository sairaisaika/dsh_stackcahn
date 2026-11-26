import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WorkspaceTypertGenerator, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator';
import { build } from 'esbuild';

const root = resolve('.');
const workspace = join(root, 'work/remote-build');
const pkg = join(workspace, 'packages/stackchan');
await rm(workspace, { recursive: true, force: true });
await mkdir(join(pkg, 'src'), { recursive: true });
await cp(join(root, 'src/remote-api'), join(pkg, 'src/remote-api'), { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
// The official analyzer discovers packages under a face workspace. Stage only
// this package's authoritative TypeScript Remote surface, retaining its paths.
await writeFile(join(pkg, 'package.json'), JSON.stringify({
  name: manifest.name, version: manifest.version, type: 'module',
  exports: { './remote-api': manifest.exports['./remote-api'],
    './typert': manifest.exports['./typert'], './remote': manifest.exports['./remote'] },
  files: manifest.files,
}, null, 2));
const compilerOptions = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
  strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
  types: [], lib: ['ES2022', 'DOM', 'ESNext.Disposable'], paths: {
    '@deepseek-ai/dsh-typert-protocol': ['../protocol/src/index.ts'],
  } };
await writeFile(join(pkg, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src/**/*.ts'] }));
// The analyzer identifies Remote decorators via a registered protocol source.
// Register an unchanged source copy of the installed pinned protocol package.
const vendor = join(workspace, 'packages/protocol');
await mkdir(vendor, { recursive: true });
await cp('node_modules/@deepseek-ai/dsh-typert-protocol/src', join(vendor, 'src'), { recursive: true });
await cp('node_modules/@deepseek-ai/dsh-typert-protocol/package.json', join(vendor, 'package.json'));
await writeFile(join(vendor, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...compilerOptions, paths: {} }, include: ['src/**/*.ts'] }));
await writeFile(join(workspace, 'tsconfig.host.json'), JSON.stringify({ compilerOptions: { ...compilerOptions, paths: { '@deepseek-ai/dsh-typert-protocol': ['./packages/protocol/src/index.ts'] } }, files: [], references: [{ path: './packages/stackchan' }, { path: './packages/protocol' }] }));
const artifacts = new WorkspaceTypertGenerator(workspace).generate(['dsh-stackchan'], ['host']);
if (artifacts.length !== 1 || !artifacts[0].remote) throw new Error('Expected one generated Remote package');
writePackageArtifacts(root, artifacts);
await build({ entryPoints: ['src/remote-api/index.ts'], outfile: 'lib/remote-api.js',
  platform: 'node', format: 'esm', target: 'es2022', bundle: true, packages: 'external' });
console.log('Official Typert Host/Client artifacts and Remote runtime generated.');
