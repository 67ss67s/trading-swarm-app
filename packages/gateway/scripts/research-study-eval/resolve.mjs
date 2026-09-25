import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(s,c,next){
 if((s.startsWith('.')||s.startsWith('/'))&&s.endsWith('.js')&&c.parentURL?.endsWith('.ts')){
  const js=new URL(s,c.parentURL),ts=new URL(js.href.slice(0,-3)+'.ts');
  if(existsSync(fileURLToPath(ts)))return next(ts.href,c);
 }return next(s,c);
}
