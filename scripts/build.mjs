import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(path.join(root,'bin'),{recursive:true});
const result=spawnSync(process.env.GO_BINARY??'go',['build','-trimpath','-o',path.join(root,'bin','whatsapp-transport'),'.'],{cwd:path.join(root,'transport'),stdio:'inherit',env:process.env});
if(result.error){console.error('Install Go 1.26+ and a C compiler (SQLite dependency), or set GO_BINARY.');console.error(result.error.message);}
process.exit(result.status??1);
