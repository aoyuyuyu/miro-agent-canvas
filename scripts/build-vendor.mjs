import fs from 'node:fs'
import {rolldown} from 'rolldown'
const bundle=await rolldown({input:'vendor/orca/entry.ts',external:['zod'],platform:'node',tsconfig:false})
try{
 const result=await bundle.write({file:'electron/vendor/orca.cjs',format:'cjs'})
 const modules=Object.entries(result.output.find(x=>x.type==='chunk').modules).filter(([id,m])=>id.replaceAll('\\','/').includes('/vendor/orca/src/')&&m.renderedLength>0).map(([id,m])=>({path:id.replaceAll('\\','/').split('/vendor/orca/')[1],renderedBytes:m.renderedLength,effectiveCharacters:m.code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,'').replace(/\s/g,'').length}))
 fs.writeFileSync('vendor/orca/runtime-modules.json',JSON.stringify({modules},null,2)+'\n')
}finally{await bundle.close()}
