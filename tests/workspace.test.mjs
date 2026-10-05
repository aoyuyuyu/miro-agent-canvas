import test from 'node:test'
import assert from 'node:assert/strict'
import {groupAgents,sessionMatchesGroup,overlaps,visibleAgentMessages,pickPortSides,autoLayout,toggleOverlap,isOverlapping} from '../src/shared/workspace.js'

test('一个软件仅一个头像，合并不同连接的历史，优先在线本聊天',()=>{
 const groups=groupAgents([{id:'codex',label:'Codex',connected:true},{id:'external',software:'codex',connected:true},{id:'offline',label:'WorkBuddy',connected:false},{id:'online',software:'CodeBuddy',connected:true},{id:'other',label:'Hermes'}])
 assert.equal(groups.length,3);assert.equal(groups[0].members.length,2);assert.equal(groups[0].representative.id,'codex');assert.equal(groups[1].representative.id,'online')
 assert.ok(sessionMatchesGroup({provider:'codebuddy'},groups[1]));assert.ok(sessionMatchesGroup({provider:'workbuddy'},groups[1]));assert.ok(sessionMatchesGroup({agentId:'offline'},groups[1]));assert.ok(!sessionMatchesGroup({provider:'hermes'},groups[1]))
})
test('相同真实头像合并，缺头像的不同软件不能合并',()=>{
 const groups=groupAgents([{id:'1',software:'one',avatar:'data:image/png;base64,real'},{id:'2',software:'two',avatar:'data:image/png;base64,real'},{id:'3',software:'three'},{id:'4',software:'four'}]);assert.equal(groups.length,3);assert.equal(groups[0].members.length,2)
 assert.equal(groupAgents([{id:'1',software:'one',avatar:'x'},{id:'2',software:'two',avatar:'y'},{id:'3',software:'one',avatar:'y'}]).length,1)
})
test('需求4：取消磁吸，对话框允许自由重叠且位置不被改写',()=>{
 const seeds=Array.from({length:6},(_,i)=>({id:String(i),type:'agent',position:{x:100+i*10,y:200+i*10},width:410,height:430}))
 seeds.forEach((n,i)=>assert.deepEqual(n.position,{x:100+i*10,y:200+i*10}))
 assert.ok(overlaps({...seeds[0]},{...seeds[0]}))
})
test('需求9：按相对方位选择最近的连接点',()=>{
 const nodes=[
  {id:'a',position:{x:0,y:0},width:400,height:400},
  {id:'b',position:{x:800,y:0},width:400,height:400},
  {id:'c',position:{x:0,y:800},width:400,height:400},
  {id:'d',position:{x:-800,y:0},width:400,height:400}
 ]
 assert.deepEqual(pickPortSides({source:'a',target:'b'},nodes),{sourceHandle:'out-right',targetHandle:'in-left'})
 assert.deepEqual(pickPortSides({source:'a',target:'c'},nodes),{sourceHandle:'out-bottom',targetHandle:'in-top'})
 assert.deepEqual(pickPortSides({source:'a',target:'d'},nodes),{sourceHandle:'out-left',targetHandle:'in-right'})
 assert.deepEqual(pickPortSides({source:'a',target:'e'},[nodes[0],{id:'e',position:{x:900,y:100},width:400,height:400}]),{sourceHandle:'out-right',targetHandle:'in-left'})
})
test('需求6：自动排版把节点排成不重叠的网格',()=>{
 const nodes=Array.from({length:9},(_,i)=>({id:String(i),type:'agent',position:{x:0,y:0},width:400,height:430}))
 const laid=autoLayout(nodes)
 assert.equal(laid.length,9)
 laid.forEach((n,i)=>laid.slice(i+1).forEach(o=>assert.ok(!overlaps(n,o),`${n.id} 与 ${o.id} 重叠`)))
})
test('同一助手的不同画布会话按消息编号隔离',()=>{
 const states={agent:{messages:[{role:'user',text:'第一条',messageId:'1'},{role:'user',text:'第二条',messageId:'2'},{role:'assistant',text:'第二条回复',messageId:'2'},{role:'assistant',text:'第一条回复',messageId:'1'}]}}
 assert.deepEqual(visibleAgentMessages({agentId:'agent',requestIds:['1'],messages:[{role:'user',text:'第一条'}]},states).map(m=>m.text),['第一条','第一条回复'])
 assert.deepEqual(visibleAgentMessages({agentId:'agent',requestIds:['2']},states).map(m=>m.text),['第二条','第二条回复'])
 assert.deepEqual(visibleAgentMessages({agentId:'replacement',requestIds:['1']},{...states,replacement:{messages:[]}}).map(m=>m.text),['第一条','第一条回复'])
})

test('需求5：重叠与展开互相切换',()=>{
 const nodes=[
  {id:'a',type:'agent',position:{x:0,y:100},width:400,height:400},
  {id:'b',type:'agent',position:{x:1000,y:100},width:400,height:400}
 ]
 // 分散态：不算重叠
 assert.equal(isOverlapping(nodes),false)
 // 第一次点击 -> 重叠到同一位置
 const stacked=toggleOverlap(nodes,['a','b'])
 assert.deepEqual(stacked.map(n=>n.position.x),[0,0])
 assert.equal(isOverlapping(stacked),true)
 // 再次点击 -> 横向铺开，间距 48
 const spread=toggleOverlap(stacked,['a','b'])
 assert.deepEqual(spread.map(n=>n.position.x),[0,448])
 assert.equal(isOverlapping(spread),false)
 // 未选中的节点保持原位
 const third={id:'c',type:'agent',position:{x:2000,y:0},width:400,height:400}
 const r=toggleOverlap([...nodes,third],['a','b'])
 assert.deepEqual(r.find(n=>n.id==='c').position,{x:2000,y:0})
})
