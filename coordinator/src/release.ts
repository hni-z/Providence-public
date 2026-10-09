import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const schema=z.object({schemaVersion:z.literal(1),commit:z.string().regex(/^[a-f0-9]{40,64}$/),builtAt:z.string().datetime(),nodeVersion:z.string().max(50),webEntry:z.object({path:z.string().regex(/^web\/dist\/assets\/[^/]+\.js$/),url:z.string().regex(/^\/assets\/[^/]+\.js$/),sha256:digest}),questEntry:z.object({path:z.string().regex(/^quest\/dist\/assets\/[^/]+\.js$/),url:z.string().regex(/^\/quest\/assets\/[^/]+\.js$/),sha256:digest})});
/** Cached at process start; editing source cannot advertise a running-code upgrade. */
export function loadRelease(file=fileURLToPath(new URL('../release.json',import.meta.url))){
  if(!existsSync(file))return {commit:'development',builtAt:null,stamped:false};
  try{
    return {...schema.parse(JSON.parse(readFileSync(file,'utf8'))),stamped:true};
  }catch{
    // A damaged manifest describes an unknown build; it must not stop the coordinator from serving.
    console.error('Release manifest could not be read as a stamped build; reporting an unstamped release.');
    return {commit:'unreadable',builtAt:null,stamped:false};
  }
}
