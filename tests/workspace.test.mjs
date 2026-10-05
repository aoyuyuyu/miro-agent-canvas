import test from 'node:test'
import assert from 'node:assert/strict'
import {groupAgents,sessionMatchesGroup,settleNodes,overlaps,visibleAgentMessages} from '../src/shared/workspace.js'

test('一个软件仅一个头像，合并不同连接的历史，优先在线本聊天',()=>{
 const groups=groupAgents([{id:'codex',label:'Codex',connected:true},{id:'external',software:'codex',connected:true},{id:'offline',label:'WorkBuddy',connected:false},{id:'online',software:'CodeBuddy',connected:true},{id:'other',label:'Hermes'}])
 assert.equal(groups.length,3);assert.equal(groups[0].members.length,2);assert.equal(groups[0].representative.id,'codex');assert.equal(groups[1].representative.id,'online')
 assert.ok(sessionMatchesGroup({provider:'codebuddy'},groups[1]));assert.ok(sessionMatchesGroup({provider:'workbuddy'},groups[1]));assert.ok(sessionMatchesGroup({agentId:'offline'},groups[1]));assert.ok(!sessionMatchesGroup({provider:'hermes'},groups[1]))
})
test('相同真实头像合并，缺头像的不同软件不能合并',()=>{
 const groups=groupAgents([{id:'1',software:'one',avatar:'data:image/png;base64,real'},{id:'2',software:'two',avatar:'data:image/png;base64,real'},{id:'3',software:'three'},{id:'4',software:'four'}]);assert.equal(groups.length,3);assert.equal(groups[0].members.length,2)
 assert.equal(groupAgents([{id:'1',software:'one',avatar:'x'},{id:'2',software:'two',avatar:'y'},{id:'3',software:'one',avatar:'y'}]).length,1)
})
test('新增、拖动及扩大卡片后保持空隙，固定正在操作的卡片',()=>{
 const seeds=Array.from({length:18},(_,i)=>({id:String(i),type:i%3?'agent':'prompt',position:{x:50,y:50},width:410,height:i%3?430:260}))
 let nodes=settleNodes(seeds);const check=()=>nodes.forEach((node,i)=>nodes.slice(i+1).forEach(other=>assert.ok(!overlaps(node,other))))
 check();nodes[9]={...nodes[9],position:{...nodes[0].position},width:1200,height:900};nodes=settleNodes(nodes,'9');assert.deepEqual(nodes[9].position,seeds[0].position);check();assert.deepEqual(settleNodes(nodes),nodes)
})
test('同一助手的不同画布会话按消息编号隔离',()=>{
 const states={agent:{messages:[{role:'user',text:'第一条',messageId:'1'},{role:'user',text:'第二条',messageId:'2'},{role:'assistant',text:'第二条回复',messageId:'2'},{role:'assistant',text:'第一条回复',messageId:'1'}]}}
 assert.deepEqual(visibleAgentMessages({agentId:'agent',requestIds:['1'],messages:[{role:'user',text:'第一条'}]},states).map(m=>m.text),['第一条','第一条回复'])
 assert.deepEqual(visibleAgentMessages({agentId:'agent',requestIds:['2']},states).map(m=>m.text),['第二条','第二条回复'])
 assert.deepEqual(visibleAgentMessages({agentId:'replacement',requestIds:['1']},{...states,replacement:{messages:[]}}).map(m=>m.text),['第一条','第一条回复'])
})
