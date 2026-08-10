import { useState, useEffect } from 'react'
import StatusBadge from '../components/StatusBadge'
import TemplateLibrary from '../components/TemplateLibrary'
import * as ca from '../lib/commissioningAgent'

var loopStages = ['comm_cable','control_cable','continuity','termination','device_installed','address_set']
var stgLbl = {comm_cable:'COMM CABLE',control_cable:'CTRL CABLE',continuity:'CONTINUITY',termination:'TERMINATION',device_installed:'INSTALLED',address_set:'ADDRESS'}
var protocols = ['MODBUS RTU','BACNET MSTP','BACNET IP']
var deviceTypes = ['FCU THERMOSTAT','FCU CONTROLLER','VAV THERMOSTAT','VAV CONTROLLER','PMU','WATER METER','BTU METER','SENSOR','OTHER']
// Ids MUST be globally unique — they are database row keys now (M6).
// The old per-pageload counters ('ldev-1000'…) collided across sessions
// and corrupted rows into duplicates.
var gidC=0
function gid(p){gidC++;var u=Date.now()+'-'+gidC;if(p==='loop')return 'loop-'+u;if(p==='area')return 'area-'+u;return 'ldev-'+u}
function up(v){return (v||'').toUpperCase().trim()}

// Stage button - defined OUTSIDE so React doesn't remount on parent re-render
function StgBtn(props){
  var ch=props.checked,prev=props.prevDone
  return (<button onClick={props.onClick} disabled={!prev&&!ch}
    className={'w-5 h-5 rounded border text-[9px] font-bold transition '+(ch?'bg-green border-green text-white':prev?'border-border hover:border-teal cursor-pointer':'border-border/20 opacity-20 cursor-not-allowed')}>{ch?'!':''}</button>)
}

// Weighted progress - reflects real BMS commissioning effort
var stageWeights={comm_cable:25,control_cable:25,continuity:10,termination:25,device_installed:15,address_set:0}
function calcWeightedPct(devs){
  if(!devs||devs.length===0)return 0
  var total=0
  devs.forEach(function(d){
    if(d.comm_cable)total+=stageWeights.comm_cable
    if(d.control_cable)total+=stageWeights.control_cable
    if(d.continuity)total+=stageWeights.continuity
    if(d.termination)total+=stageWeights.termination
    if(d.device_installed)total+=stageWeights.device_installed
    if(d.address_set)total+=stageWeights.address_set
  })
  return Math.round(total/devs.length)
}
function stageCount(devs,stage){return devs.filter(function(d){return d[stage]}).length}

function autoGrow(e){e.target.style.whiteSpace='normal';e.target.style.height='auto';e.target.style.height=e.target.scrollHeight+'px'}
function autoShrink(e){e.target.style.height='';e.target.style.whiteSpace='nowrap'}

// Numeric address sort — "3" < "12" < "ADDR-20"; blanks last
function addrNum(a){var n=parseInt(String(a||'').replace(/[^0-9]/g,''),10);return isNaN(n)?Infinity:n}
function sortDevsByAddr(devs){return devs.slice().sort(function(a,b){return addrNum(a.address)-addrNum(b.address)})}


export default function CommDevices(props){
  var loops=props.loops,areas=props.areas,onUpdateLoops=props.onUpdateLoops,onUpdateAreas=props.onUpdateAreas
  var gateways=props.gateways||[],onUpdateGateways=props.onUpdateGateways||function(){}
  var vs=useState('loops'),view=vs[0],setView=vs[1]
  var es=useState(null),expanded=es[0],setExpanded=es[1]
  var sas=useState(false),showAdd=sas[0],setShowAdd=sas[1]
  var adts=useState(null),addDevTo=adts[0],setAddDevTo=adts[1]
  var ds=useState(null),dragDev=ds[0],setDragDev=ds[1]
  var dis=useState(null),dragIdx=dis[0],setDragIdx=dis[1]
  var addDevAreaSt=useState(null),addDevArea=addDevAreaSt[0],setAddDevArea=addDevAreaSt[1]
  var dais=useState(null),dragAreaIdx=dais[0],setDragAreaIdx=dais[1]
  var egw=useState(null),expandedGw=egw[0],setExpandedGw=egw[1]
  var egl=useState(null),expandedGwLoop=egl[0],setExpandedGwLoop=egl[1]
  var nls=useState({name:'',protocol:'MODBUS RTU',gateway:'',ddc_ref:'',floor:'',zone:''})
  var newLoop=nls[0],setNewLoop=nls[1]
  var nds=useState({device_type:'FCU THERMOSTAT',tag:'',room_name:'',address:''})
  var newDev=nds[0],setNewDev=nds[1]
  var nas=useState({name:'',floor:''}),newArea=nas[0],setNewArea=nas[1]
  var saas=useState(false),showAddArea=saas[0],setShowAddArea=saas[1]
  var lfcS=useState({}),locCollapsed=lfcS[0],setLocCollapsed=lfcS[1]
  var projectId=props.projectId
  var busSt=useState(localStorage.getItem('kmc_modbus_bus')||''),bus=busSt[0],setBus=busSt[1]
  var mcSt=useState({}),modbusComm=mcSt[0],setModbusComm=mcSt[1] // loopId -> {busy,summary,checks,showDetails,err}
  var dgSt=useState({}),dgCtl=dgSt[0],setDgCtl=dgSt[1] // gatewayId -> {mode:'config'|'gateway'|null, form fields, busy, err, lastResult/gwStatus}
  // Device kinds that actually have a register map. A loop mixes kinds freely, and each slave's
  // registers come from its own kind — so the picker offers what the library can really generate,
  // not a hardcoded list that silently can't.
  var tplTypesSt=useState([]),tplTypes=tplTypesSt[0],setTplTypes=tplTypesSt[1]
  useEffect(function(){
    if(!props.projectId)return
    ca.modbusTemplatesList()
      .then(function(res){setTplTypes((res.templates||[]).map(function(t){return t.device_type}).filter(Boolean))})
      .catch(function(){/* agent not running — fall back to the built-in list */})
  },[props.projectId])
  // Union so existing data is never silently unselectable, even if its kind has no map yet.
  var deviceTypeOptions=deviceTypes.slice()
  tplTypes.forEach(function(t){if(deviceTypeOptions.indexOf(t)<0)deviceTypeOptions.push(t)})

  function setModbusFor(loopId,patch){
    setModbusComm(function(prev){var next=Object.assign({},prev);next[loopId]=Object.assign({},next[loopId],patch);return next})
  }
  function busTarget(){
    var v=(bus||'').trim()
    if(/^[\w.-]+:\d+$/.test(v))return {tcp:v}
    return {serial_port:v}
  }
  function loopGatewayKey(loop){return loop.gateway?ca.gatewayKeyFor(loop.gateway):loop.id}
  function runPreflight(loop){
    if(!projectId)return
    setModbusFor(loop.id,{busy:'preflight',err:''})
    ca.modbusPreflight({project_id:projectId,gateway_key:loopGatewayKey(loop)})
      .then(function(res){setModbusFor(loop.id,{busy:null,preflightWarnings:res.warnings||[]})})
      .catch(function(e){setModbusFor(loop.id,{busy:null,err:e.message})})
  }
  function runScan(loop){
    if(!projectId||!bus.trim())return
    setModbusFor(loop.id,{busy:'scan',err:''})
    ca.modbusScan(busTarget())
      .then(function(res){setModbusFor(loop.id,{busy:null,scanFound:res.found||[]})})
      .catch(function(e){setModbusFor(loop.id,{busy:null,err:e.message})})
  }
  function runVerify(loop){
    if(!projectId||!bus.trim())return
    setModbusFor(loop.id,{busy:'verify',err:''})
    var body=Object.assign({project_id:projectId,gateway_key:loopGatewayKey(loop)},busTarget())
    ca.modbusVerify(body)
      .then(function(res){
        var checks=(res.report&&res.report.checks)||[]
        var sum={checked:checks.length,pass:0,fail:0}
        checks.forEach(function(c){if(c.status==='pass')sum.pass++;else sum.fail++})
        setModbusFor(loop.id,{busy:null,summary:sum,checks:checks.filter(function(c){return c.status!=='pass'}),showDetails:false})
      })
      .catch(function(e){setModbusFor(loop.id,{busy:null,err:e.message})})
  }


  var allDevices=[]
  loops.forEach(function(l){l.devices.forEach(function(d){
    allDevices.push(Object.assign({},d,{loop_id:l.id,loop_name:l.name,protocol:l.protocol,gateway:l.gateway,ddc_ref:l.ddc_ref,loop_floor:l.floor,loop_zone:l.zone}))
  })})
  var totalDevices=allDevices.length
  var totalInstalled=allDevices.filter(function(d){return d.device_installed}).length
  var totalAddressed=allDevices.filter(function(d){return d.address_set}).length
  var totalDone=allDevices.filter(function(d){return loopStages.every(function(s){return d[s]})}).length

  function ensureUnassignedLoop(){
    var ul=loops.find(function(l){return l.id==='loop-unassigned'})
    if(ul)return loops
    return loops.concat([{id:'loop-unassigned',name:'UNASSIGNED',protocol:'MODBUS RTU',gateway:'',ddc_ref:'',floor:'',zone:'',devices:[]}])
  }

  function addLoop(){
    if(!newLoop.name.trim())return
    var loop={id:gid('loop'),name:up(newLoop.name),protocol:newLoop.protocol,gateway:up(newLoop.gateway),ddc_ref:up(newLoop.ddc_ref),floor:up(newLoop.floor),zone:up(newLoop.zone),devices:[]}
    onUpdateLoops(loops.concat([loop]))
    setNewLoop({name:'',protocol:'MODBUS RTU',gateway:'',ddc_ref:'',floor:'',zone:''});setShowAdd(false);setExpanded(loop.id)
  }
  function deleteLoop(id){if(!confirm('Remove loop and devices?'))return;onUpdateLoops(loops.filter(function(l){return l.id!==id}))}
  function addDevice(loopId){
    if(!newDev.tag.trim())return
    var dev={id:gid('dev'),device_type:newDev.device_type,tag:up(newDev.tag),room_name:up(newDev.room_name),address:up(newDev.address),comm_cable:false,control_cable:false,continuity:false,termination:false,device_installed:false,address_set:false,remarks:''}
    onUpdateLoops(loops.map(function(l){if(l.id===loopId)return Object.assign({},l,{devices:l.devices.concat([dev])});return l}))
    setNewDev({device_type:'FCU THERMOSTAT',tag:'',room_name:'',address:''});setAddDevTo(null)
  }
  function addDeviceToArea(areaId){
    if(!newDev.tag.trim())return
    var updated=ensureUnassignedLoop()
    var dev={id:gid('dev'),device_type:newDev.device_type,tag:up(newDev.tag),room_name:up(newDev.room_name),address:up(newDev.address),comm_cable:false,control_cable:false,continuity:false,termination:false,device_installed:false,address_set:false,remarks:''}
    updated=updated.map(function(l){if(l.id==='loop-unassigned')return Object.assign({},l,{devices:l.devices.concat([dev])});return l})
    onUpdateLoops(updated)
    onUpdateAreas(areas.map(function(a){if(a.id===areaId)return Object.assign({},a,{device_ids:a.device_ids.concat([dev.id])});return a}))
    setNewDev({device_type:'FCU THERMOSTAT',tag:'',room_name:'',address:''});setAddDevArea(null)
  }
  function removeDevice(lid,did){
    onUpdateLoops(loops.map(function(l){if(l.id===lid)return Object.assign({},l,{devices:l.devices.filter(function(d){return d.id!==did})});return l}))
    // Also clean up area group references
    onUpdateAreas(areas.map(function(a){return Object.assign({},a,{device_ids:a.device_ids.filter(function(i){return i!==did})})}))
  }
  function handleToggle(lid,did,stage){
    onUpdateLoops(loops.map(function(l){if(l.id!==lid)return l;return Object.assign({},l,{devices:l.devices.map(function(d){
      if(d.id!==did)return d;var nv=!d[stage];var i=loopStages.indexOf(stage);if(nv&&i>0&&!d[loopStages[i-1]])return d
      var u={};u[stage]=nv;if(!nv){for(var j=i+1;j<loopStages.length;j++)u[loopStages[j]]=false};return Object.assign({},d,u)
    })})}))
  }
  function handleToggleByDevId(did,stage){
    onUpdateLoops(loops.map(function(l){
      var has=l.devices.some(function(d){return d.id===did})
      if(!has)return l
      return Object.assign({},l,{devices:l.devices.map(function(d){
        if(d.id!==did)return d;var nv=!d[stage];var i=loopStages.indexOf(stage);if(nv&&i>0&&!d[loopStages[i-1]])return d
        var u={};u[stage]=nv;if(!nv){for(var j=i+1;j<loopStages.length;j++)u[loopStages[j]]=false};return Object.assign({},d,u)
      })})
    }))
  }
  function handleDeviceField(lid,did,f,v){onUpdateLoops(loops.map(function(l){if(l.id!==lid)return l;return Object.assign({},l,{devices:l.devices.map(function(d){if(d.id!==did)return d;var u={};u[f]=v;return Object.assign({},d,u)})})}))}
  function handleDeviceBlur(lid,did,f){onUpdateLoops(loops.map(function(l){if(l.id!==lid)return l;return Object.assign({},l,{devices:l.devices.map(function(d){if(d.id!==did)return d;var u={};u[f]=up(d[f]);return Object.assign({},d,u)})})}))}
  function handleDevFieldById(did,f,v){onUpdateLoops(loops.map(function(l){var has=l.devices.some(function(d){return d.id===did});if(!has)return l;return Object.assign({},l,{devices:l.devices.map(function(d){if(d.id!==did)return d;var u={};u[f]=v;return Object.assign({},d,u)})})}))}
  function handleDevBlurById(did,f){onUpdateLoops(loops.map(function(l){var has=l.devices.some(function(d){return d.id===did});if(!has)return l;return Object.assign({},l,{devices:l.devices.map(function(d){if(d.id!==did)return d;var u={};u[f]=up(d[f]);return Object.assign({},d,u)})})}))}
  function handleLoopField(lid,f,v){onUpdateLoops(loops.map(function(l){if(l.id!==lid)return l;var u={};u[f]=v;return Object.assign({},l,u)}))}
  function handleLoopBlur(lid,f){onUpdateLoops(loops.map(function(l){if(l.id!==lid)return l;var u={};u[f]=up(l[f]);return Object.assign({},l,u)}))}
  function startDragLoop(did,fromLid){setDragDev({devId:did,fromLoopId:fromLid,type:'loop'})}
  function dropOnLoop(toLid){
    if(!dragDev||dragDev.fromLoopId===toLid){setDragDev(null);return}
    var mv=null;var ul=loops.map(function(l){if(l.id===dragDev.fromLoopId){mv=l.devices.find(function(d){return d.id===dragDev.devId});return Object.assign({},l,{devices:l.devices.filter(function(d){return d.id!==dragDev.devId})})}return l})
    if(mv)ul=ul.map(function(l){if(l.id===toLid)return Object.assign({},l,{devices:l.devices.concat([mv])});return l})
    onUpdateLoops(ul);setDragDev(null)
  }
  function startReorder(lid,fi){setDragIdx({loopId:lid,fromIndex:fi})}
  function dropReorder(lid,ti){
    if(!dragIdx||dragIdx.loopId!==lid||dragIdx.fromIndex===ti){setDragIdx(null);return}
    onUpdateLoops(loops.map(function(l){if(l.id!==lid)return l;var d=l.devices.slice();var it=d.splice(dragIdx.fromIndex,1)[0];d.splice(ti,0,it);return Object.assign({},l,{devices:d})}))
    setDragIdx(null)
  }
  function addArea(){if(!newArea.name.trim())return;onUpdateAreas(areas.concat([{id:gid('area'),name:up(newArea.name),floor:up(newArea.floor||''),device_ids:[]}]));setNewArea({name:'',floor:''});setShowAddArea(false)}
  // Floor of an area: explicit field wins, else derived from member devices
  function areaFloorOf(a){
    if(a.floor)return up(a.floor)
    var devMap={};allDevices.forEach(function(d){devMap[d.id]=d})
    for(var i=0;i<(a.device_ids||[]).length;i++){
      var d=devMap[a.device_ids[i]]
      if(d){var f=up(d.floor||d.loop_floor||'');if(f)return f}
    }
    return 'UNSPECIFIED'
  }
  function deleteArea(id){onUpdateAreas(areas.filter(function(a){return a.id!==id}))}
  function toggleDeviceInArea(aid,did){onUpdateAreas(areas.map(function(a){if(a.id!==aid)return a;var h=a.device_ids.indexOf(did)>=0;return Object.assign({},a,{device_ids:h?a.device_ids.filter(function(i){return i!==did}):a.device_ids.concat([did])})}))}
  function renameArea(aid,n){onUpdateAreas(areas.map(function(a){if(a.id!==aid)return a;return Object.assign({},a,{name:n})}))}
  function renameAreaBlur(aid){onUpdateAreas(areas.map(function(a){if(a.id!==aid)return a;return Object.assign({},a,{name:up(a.name)})}))}
  function startDragArea(did,faid){setDragDev({devId:did,fromAreaId:faid,type:'area'})}
  function dropOnArea(taid){
    if(!dragDev||dragDev.type!=='area'||dragDev.fromAreaId===taid){setDragDev(null);return}
    onUpdateAreas(areas.map(function(a){
      if(a.id===dragDev.fromAreaId)return Object.assign({},a,{device_ids:a.device_ids.filter(function(i){return i!==dragDev.devId})})
      if(a.id===taid){if(a.device_ids.indexOf(dragDev.devId)>=0)return a;return Object.assign({},a,{device_ids:a.device_ids.concat([dragDev.devId])})}
      return a
    }));setDragDev(null)
  }
  function moveArea(aid,dir){
    var idx=areas.findIndex(function(a){return a.id===aid})
    var to=idx+dir
    if(idx<0||to<0||to>=areas.length)return
    var next=areas.slice();var t=next[idx];next[idx]=next[to];next[to]=t
    onUpdateAreas(next)
  }
  function startReorderArea(aid,fi){setDragAreaIdx({areaId:aid,fromIndex:fi})}
  function dropReorderArea(aid,ti){
    if(!dragAreaIdx||dragAreaIdx.areaId!==aid||dragAreaIdx.fromIndex===ti){setDragAreaIdx(null);return}
    onUpdateAreas(areas.map(function(a){if(a.id!==aid)return a;var ids=a.device_ids.slice();var it=ids.splice(dragAreaIdx.fromIndex,1)[0];ids.splice(ti,0,it);return Object.assign({},a,{device_ids:ids})}))
    setDragAreaIdx(null)
  }
  // Bulk assign: move all devices in an area to a target loop
  function bulkAssignToLoop(areaId, targetLoopId){
    var area=areas.find(function(a){return a.id===areaId})
    if(!area||!area.device_ids.length)return
    var devIds={}; area.device_ids.forEach(function(id){devIds[id]=true})
    var movedDevs=[]
    var updatedLoops=loops.map(function(l){
      var keep=[],move=[]
      l.devices.forEach(function(d){if(devIds[d.id]){move.push(d)}else{keep.push(d)}})
      if(move.length>0)movedDevs=movedDevs.concat(move)
      return keep.length!==l.devices.length?Object.assign({},l,{devices:keep}):l
    })
    // Add moved devices to target loop
    updatedLoops=updatedLoops.map(function(l){
      if(l.id===targetLoopId)return Object.assign({},l,{devices:l.devices.concat(movedDevs)})
      return l
    })
    onUpdateLoops(updatedLoops)
  }
  var assignedIds={};areas.forEach(function(a){a.device_ids.forEach(function(i){assignedIds[i]=true})})
  var unassigned=allDevices.filter(function(d){return !assignedIds[d.id]})
  var showTplSt=useState(false),showTemplates=showTplSt[0],setShowTemplates=showTplSt[1]

  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-5">
        <h1 className="text-lg md:text-xl font-bold uppercase">FIELD DEVICES <span className="text-dgray font-normal text-xs md:text-sm ml-2">{totalDevices} DEVICES / {loops.length} LOOPS</span></h1>
        <div className="flex gap-2">
          <button onClick={function(){setView('loops');setExpanded(null)}} className={'px-3 md:px-4 py-1.5 text-xs font-semibold rounded-md transition uppercase '+(view==='loops'?'bg-teal text-white':'bg-card2 text-dgray hover:text-white')}>LOOP VIEW</button>
          <button onClick={function(){setView('location');setExpanded(null)}} className={'px-3 md:px-4 py-1.5 text-xs font-semibold rounded-md transition uppercase '+(view==='location'?'bg-teal text-white':'bg-card2 text-dgray hover:text-white')}>LOCATION VIEW</button>
          <button onClick={function(){setView('gateways');setExpanded(null)}} className={'px-3 md:px-4 py-1.5 text-xs font-semibold rounded-md transition uppercase '+(view==='gateways'?'bg-teal text-white':'bg-card2 text-dgray hover:text-white')}>GATEWAY/RTR</button>
          {projectId&&<button onClick={function(){setShowTemplates(true)}} title="MANAGE MODBUS POINT-ROLE TEMPLATES — REQUIRED BEFORE GENERATING A CONFIG.CSV" className="px-3 md:px-4 py-1.5 text-xs font-semibold rounded-md transition uppercase bg-card2 text-dgray hover:text-white border border-border">TEMPLATES</button>}
        </div>
      </div>
      {showTemplates&&<TemplateLibrary onClose={function(){setShowTemplates(false)}}/>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        {[{l:'LOOPS',v:loops.length},{l:'TOTAL DEVICES',v:totalDevices},{l:'OVERALL PROGRESS',v:calcWeightedPct(allDevices)+'%',c:calcWeightedPct(allDevices)>=80?'text-green':calcWeightedPct(allDevices)>=40?'text-orange':'text-red'},{l:'INSTALLED',v:totalInstalled+'/'+totalDevices,c:totalInstalled===totalDevices&&totalDevices>0?'text-green':'text-cyan'}].map(function(s,i){
          return <div key={i} className="bg-card rounded-xl p-4 border border-border"><div className="text-[11px] text-dgray uppercase">{s.l}</div><div className={'text-2xl font-extrabold '+(s.c||'text-cyan')}>{s.v}</div></div>
        })}
      </div>
      <div className="bg-card rounded-xl p-4 border border-border mb-5">
        <div className="text-[10px] text-dgray mb-2 uppercase font-semibold">COMMISSIONING PIPELINE</div>
        <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
          {loopStages.filter(function(s){return s!=='address_set'}).map(function(s){
            var cnt=stageCount(allDevices,s)
            var spct=totalDevices>0?Math.round(cnt/totalDevices*100):0
            var clr=spct>=100?'text-green':spct>0?'text-cyan':'text-dgray'
            return (<div key={s} className="text-center">
              <div className="text-[9px] text-dgray mb-0.5">{stgLbl[s]}</div>
              <div className={'text-sm font-bold '+clr}>{cnt}/{totalDevices}</div>
              <div className="text-[9px] text-dgray">{spct}%</div>
              <div className="w-full h-1 bg-navy rounded mt-1"><div className={'h-full rounded '+(spct>=100?'bg-green':spct>0?'bg-teal':'bg-red/20')} style={{width:spct+'%'}}/></div>
            </div>)
          })}
        </div>
      </div>
      {view==='loops'?renderLoopView():view==='gateways'?renderGatewayView():renderLocationView()}
    </div>
  )

  function renderLoopView(){
    return (<div>
      <div className="flex justify-end mb-3"><button onClick={function(){setShowAdd(!showAdd)}} className="px-4 py-2 bg-teal text-white text-xs font-semibold rounded-md hover:bg-teal/80 uppercase">+ ADD LOOP</button></div>
      {showAdd&&(<div className="bg-card rounded-xl border border-teal p-4 mb-4">
        <h3 className="text-sm font-semibold mb-3 uppercase">NEW COMMUNICATION LOOP</h3>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-3">
          <div><label className="text-[10px] text-dgray block mb-1">FLOOR</label><input value={newLoop.floor} onChange={function(e){setNewLoop(Object.assign({},newLoop,{floor:e.target.value}))}} placeholder="GF" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal"/></div>
          <div><label className="text-[10px] text-dgray block mb-1">ZONE (OPT)</label><input value={newLoop.zone} onChange={function(e){setNewLoop(Object.assign({},newLoop,{zone:e.target.value}))}} placeholder="Z1" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal"/></div>
          <div><label className="text-[10px] text-dgray block mb-1">DDC REF</label><input value={newLoop.ddc_ref} onChange={function(e){setNewLoop(Object.assign({},newLoop,{ddc_ref:e.target.value}))}} placeholder="DDC-GF-01" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal"/></div>
          <div><label className="text-[10px] text-dgray block mb-1">GATEWAY</label><input value={newLoop.gateway} onChange={function(e){setNewLoop(Object.assign({},newLoop,{gateway:e.target.value}))}} placeholder="GW-01" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal"/></div>
          <div><label className="text-[10px] text-dgray block mb-1">LOOP NAME</label><input value={newLoop.name} onChange={function(e){setNewLoop(Object.assign({},newLoop,{name:e.target.value}))}} placeholder="LOOP 1" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal"/></div>
          <div><label className="text-[10px] text-dgray block mb-1">PROTOCOL</label><select value={newLoop.protocol} onChange={function(e){setNewLoop(Object.assign({},newLoop,{protocol:e.target.value}))}} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal">{protocols.map(function(p){return <option key={p} value={p}>{p}</option>})}</select></div>
        </div>
        <div className="flex gap-2"><button onClick={addLoop} className="px-4 py-1.5 bg-teal text-white text-xs font-semibold rounded hover:bg-teal/80 uppercase">CREATE LOOP</button><button onClick={function(){setShowAdd(false)}} className="px-4 py-1.5 bg-card2 text-dgray text-xs rounded hover:text-white uppercase">CANCEL</button></div>
      </div>)}
      {loops.length>0&&(<div className="hidden md:grid bg-card2 rounded-t-lg px-4 py-2 grid-cols-12 gap-2 text-[9px] text-dgray uppercase font-semibold border border-border/50 border-b-0">
        <div className="col-span-1">FLOOR</div><div className="col-span-1">ZONE</div><div className="col-span-2">DDC REF</div><div className="col-span-2">GATEWAY</div><div className="col-span-2">LOOP NAME</div><div className="col-span-1">PROTOCOL</div><div className="col-span-1 text-center">DEVICES</div><div className="col-span-2 text-right">PROGRESS</div>
      </div>)}
      {loops.map(function(loop,li){
        var isExp=expanded===loop.id,dc=loop.devices.length
        var pct=calcWeightedPct(loop.devices),isDT=dragDev&&dragDev.type==='loop'&&dragDev.fromLoopId!==loop.id
        // Multi-floor loops (traced across drawings) + cable-issue remarks per device
        var floorSet={};loop.devices.forEach(function(d){if(d.floor)floorSet[d.floor]=true});var floorArr=Object.keys(floorSet)
        var cbl={};(loop.cable_remarks||[]).forEach(function(r){var t=(r.from||'?')+' → '+(r.to||'?')+': '+r.text;if(r.from)cbl[r.from]=(cbl[r.from]?cbl[r.from]+'\n':'')+t;if(r.to)cbl[r.to]=(cbl[r.to]?cbl[r.to]+'\n':'')+t})
        return (<div key={loop.id} className={'bg-card border border-border/50 overflow-hidden transition '+(isDT?'border-cyan border-2':'')+(li===loops.length-1?' rounded-b-lg':'')}
          onDragOver={function(e){if(dragDev&&dragDev.type==='loop')e.preventDefault()}} onDrop={function(){if(dragDev&&dragDev.type==='loop')dropOnLoop(loop.id)}}>
          <div className="px-4 py-2.5 flex flex-wrap md:grid md:grid-cols-12 gap-2 items-center cursor-pointer hover:bg-card2/50" onClick={function(){setExpanded(isExp?null:loop.id)}}>
            <div className="hidden md:block md:col-span-1 text-[11px] font-bold text-orange">{loop.floor||'-'}</div>
            <div className="hidden md:block md:col-span-1 text-[11px] text-orange">{loop.zone||'-'}</div>
            <div className="hidden md:block md:col-span-2 text-[11px] text-cyan font-medium">{loop.ddc_ref||'-'}</div>
            <div className="hidden md:block md:col-span-2 text-[11px] text-cyan">{loop.gateway||'-'}</div>
            <div className="flex-1 md:flex-none md:col-span-2 text-sm font-bold uppercase">{loop.name}
              {(loop.cable_remarks||[]).length>0&&(<span title={(loop.cable_remarks||[]).map(function(r){return (r.from||'?')+' → '+(r.to||'?')+': '+r.text}).join('\n')} className="ml-1.5 text-[9px] font-bold bg-red/20 text-red px-1.5 py-0.5 rounded align-middle">⚠ {(loop.cable_remarks||[]).length}</span>)}
              {floorArr.length>1&&(<span title={'DEVICES ON: '+floorArr.join(', ')} className="ml-1.5 text-[8px] font-bold bg-orange/20 text-orange px-1.5 py-0.5 rounded align-middle">{floorArr.join('/')}</span>)}
            </div>
            <div className="md:col-span-1"><span className="text-[9px] bg-purple/20 text-purple px-1.5 py-0.5 rounded">{loop.protocol}</span></div>
            <div className="md:col-span-1 text-center text-[11px] text-dgray">{dc} DEV</div>
            <div className="md:col-span-2 flex items-center justify-end gap-2">
              <div className="w-16 h-1.5 bg-navy rounded overflow-hidden"><div className={'h-full rounded '+(pct>=100?'bg-green':pct>=50?'bg-teal':pct>0?'bg-orange':'bg-red')} style={{width:pct+'%'}}/></div>
              <span className="text-[10px] text-dgray w-8 text-right">{pct}%</span>
              <button onClick={function(e){e.stopPropagation();deleteLoop(loop.id)}} className="text-[10px] text-red/40 hover:text-red ml-1">X</button>
              <span className="text-dgray text-xs w-3">{isExp?'V':'>'}</span>
            </div>
          </div>
          {isExp&&(<div className="px-4 py-3 border-t border-border/30">
            <div className="flex gap-4 mb-3 text-[10px] flex-wrap">
              {[{l:'FLOOR',f:'floor',w:'w-10',c:'text-orange font-bold'},{l:'ZONE',f:'zone',w:'w-10',c:'text-orange'},{l:'DDC',f:'ddc_ref',w:'w-24',c:'text-cyan'},{l:'GATEWAY',f:'gateway',w:'w-20',c:'text-cyan'},{l:'NAME',f:'name',w:'w-32',c:'text-white'}].map(function(x){
                return <div key={x.f} className="flex items-center gap-1"><span className="text-dgray">{x.l}:</span><input value={loop[x.f]||''} onChange={function(e){handleLoopField(loop.id,x.f,e.target.value)}} onBlur={function(){handleLoopBlur(loop.id,x.f)}} style={{textTransform:'uppercase'}} className={'bg-transparent border-b border-transparent focus:border-teal text-[11px] outline-none '+x.w+' '+x.c} placeholder="-"/></div>
              })}
              <div className="flex items-center gap-1"><span className="text-dgray">PROTOCOL:</span><select value={loop.protocol} onChange={function(e){handleLoopField(loop.id,'protocol',e.target.value)}} className="bg-transparent text-[11px] text-purple outline-none cursor-pointer uppercase">{protocols.map(function(p){return <option key={p} value={p}>{p}</option>})}</select></div>
            </div>
            {addDevTo===loop.id?(<div className="bg-card2 rounded-lg p-3 mb-3 border border-border">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-2">
                <div><label className="text-[9px] text-dgray block mb-0.5">TYPE</label><select value={newDev.device_type} onChange={function(e){setNewDev(Object.assign({},newDev,{device_type:e.target.value}))}} className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none uppercase">{deviceTypeOptions.map(function(dt){return <option key={dt} value={dt}>{dt}</option>})}</select></div>
                <div><label className="text-[9px] text-dgray block mb-0.5">EQUIP TAG</label><input value={newDev.tag} onChange={function(e){setNewDev(Object.assign({},newDev,{tag:e.target.value}))}} placeholder="FCU-01" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none"/></div>
                <div><label className="text-[9px] text-dgray block mb-0.5">ROOM</label><input value={newDev.room_name} onChange={function(e){setNewDev(Object.assign({},newDev,{room_name:e.target.value}))}} placeholder="ROOM 101" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none"/></div>
                <div><label className="text-[9px] text-dgray block mb-0.5">ADDRESS</label><input value={newDev.address} onChange={function(e){setNewDev(Object.assign({},newDev,{address:e.target.value}))}} placeholder="1" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none"/></div>
                <div className="flex items-end gap-1"><button onClick={function(){addDevice(loop.id)}} className="px-3 py-1 bg-teal text-white text-[11px] font-semibold rounded hover:bg-teal/80 uppercase">ADD</button><button onClick={function(){setAddDevTo(null)}} className="px-3 py-1 bg-card text-dgray text-[11px] rounded hover:text-white">X</button></div>
              </div>
            </div>):(<div className="flex items-center gap-4 mb-3"><button onClick={function(){setAddDevTo(loop.id)}} className="text-[11px] text-teal hover:text-cyan font-medium uppercase">+ ADD DEVICE</button><button onClick={function(){onUpdateLoops(loops.map(function(x){return x.id===loop.id?Object.assign({},x,{devices:sortDevsByAddr(x.devices)}):x}))}} title="ARRANGE DEVICES SMALLEST ADDRESS FIRST — YOU CAN STILL DRAG TO REORDER" className="text-[11px] text-dgray hover:text-cyan font-medium uppercase">⇅ SORT BY ADDR</button></div>)}
            {loop.devices.length>0?(<div className="overflow-x-auto"><table className="w-full"><thead><tr className="border-b border-border/50">
              <th className="text-[9px] text-dgray text-center px-1 py-1.5 w-6"></th>
              <th className="text-[9px] text-dgray text-left px-2 py-1.5">TYPE</th>
              <th className="text-[9px] text-dgray text-left px-2 py-1.5">EQUIP TAG</th>
              <th className="text-[9px] text-dgray text-left px-2 py-1.5">ROOM</th>
              <th className="text-[9px] text-dgray text-center px-2 py-1.5">ADDR</th>
              {loopStages.map(function(s){return <th key={s} className="text-[9px] text-dgray text-center px-1 py-1.5">{stgLbl[s]}</th>})}
              <th className="text-[9px] text-dgray text-left px-2 py-1.5 min-w-[140px]">REMARKS</th><th className="w-6"></th>
            </tr></thead><tbody>
              {loop.devices.map(function(dev,di){
                var isRT=dragIdx&&dragIdx.loopId===loop.id&&dragIdx.fromIndex!==di
                return (<tr key={dev.id} className={'border-b border-border/20 hover:bg-teal/4 align-top '+(isRT?'bg-teal/8':'')} draggable={true}
                  onDragStart={function(e){e.dataTransfer.effectAllowed='move';startReorder(loop.id,di);startDragLoop(dev.id,loop.id)}}
                  onDragOver={function(e){e.preventDefault()}}
                  onDrop={function(e){e.stopPropagation();if(dragIdx&&dragIdx.loopId===loop.id)dropReorder(loop.id,di)}}
                  onDragEnd={function(){setDragDev(null);setDragIdx(null)}}>
                  <td className="text-center px-1 py-1.5 cursor-grab text-dgray text-[10px]">::</td>
                  <td className="px-1 py-1.5"><select value={dev.device_type} onChange={function(e){handleDeviceField(loop.id,dev.id,'device_type',e.target.value)}} className="bg-transparent text-[10px] text-purple uppercase outline-none cursor-pointer w-full">{deviceTypeOptions.map(function(dt){return <option key={dt} value={dt}>{dt}</option>})}{deviceTypeOptions.indexOf(dev.device_type)<0&&<option value={dev.device_type}>{dev.device_type}</option>}</select></td>
                  <td className="px-2 py-1.5"><div className="flex items-center gap-1">{cbl[dev.tag]&&(<span title={cbl[dev.tag]} className="text-[10px] text-red shrink-0 cursor-help">⚠</span>)}<input type="text" value={dev.tag||''} onChange={function(e){handleDeviceField(loop.id,dev.id,'tag',e.target.value)}} onBlur={function(){handleDeviceBlur(loop.id,dev.id,'tag')}} style={{textTransform:'uppercase'}} className="bg-transparent border-b border-transparent focus:border-teal text-[11px] text-white font-medium outline-none w-24" placeholder="-"/></div></td>
                  <td className="px-2 py-1.5"><div className="flex items-center gap-1"><input type="text" value={dev.room_name} onChange={function(e){handleDeviceField(loop.id,dev.id,'room_name',e.target.value)}} onBlur={function(){handleDeviceBlur(loop.id,dev.id,'room_name')}} style={{textTransform:'uppercase'}} className="bg-transparent border-b border-transparent focus:border-teal text-[11px] text-white outline-none w-full" placeholder="-"/>{dev.floor&&floorArr.length>1&&(<span className="text-[8px] text-orange shrink-0">{dev.floor}</span>)}</div></td>
                  <td className="text-center px-2 py-1.5"><input type="text" value={dev.address} onChange={function(e){handleDeviceField(loop.id,dev.id,'address',e.target.value)}} onBlur={function(){handleDeviceBlur(loop.id,dev.id,'address')}} style={{textTransform:'uppercase'}} className="bg-transparent border-b border-transparent focus:border-teal text-[11px] text-cyan text-center outline-none w-10 mx-auto" placeholder="-"/></td>
                  {loopStages.map(function(s){var ch=dev[s],idx=loopStages.indexOf(s),prev=idx===0||dev[loopStages[idx-1]];return <td key={s} className="text-center px-1 py-1.5"><StgBtn checked={ch} prevDone={prev} onClick={function(){handleToggle(loop.id,dev.id,s)}}/></td>})}
                  <td className="px-2 py-1.5 min-w-[140px]"><textarea rows="1" title={dev.remarks||''} value={dev.remarks||''} onChange={function(e){handleDeviceField(loop.id,dev.id,'remarks',e.target.value)}} onBlur={function(e){autoShrink(e);handleDeviceBlur(loop.id,dev.id,'remarks')}} onInput={autoGrow} onFocus={autoGrow} style={{textTransform:'uppercase',resize:'none',overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis'}} className="bg-transparent border border-transparent focus:border-teal text-[10px] text-orange italic outline-none w-full rounded px-1 py-0.5" placeholder="REMARKS..."/></td>
                  <td className="text-center px-1 py-1.5"><button onClick={function(){removeDevice(loop.id,dev.id)}} className="text-[9px] text-red/40 hover:text-red">X</button></td>
                </tr>)
              })}
            </tbody></table></div>):(<div className="text-[11px] text-dgray italic py-2 uppercase">NO DEVICES YET. CLICK + ADD DEVICE.</div>)}
          </div>)}
        </div>)
      })}
      {loops.length===0&&!showAdd&&(<div className="bg-card rounded-xl border border-border p-8 text-center"><div className="text-dgray text-sm uppercase">NO COMMUNICATION LOOPS YET.</div></div>)}
      {dragDev&&dragDev.type==='loop'&&(<div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-cyan/20 text-cyan text-xs px-4 py-2 rounded-lg border border-cyan z-50 uppercase">DRAG TO REORDER OR MOVE TO ANOTHER LOOP</div>)}
    </div>)
  }

  // ─── GATEWAY / RTR VIEW ─────────────────────────────────
  // Gateway = Modbus devices head-end · RTR = BACnet MSTP-to-IP router
  // Hierarchy: GATEWAY/RTR → DDC REF → IP → BACNET ID → loops → devices
  function renderGatewayView(){
    var showAddGw=addDevTo==='__gw__'
    function loopsOf(g){return loops.filter(function(l){return up(l.gateway)===up(g.name)&&up(g.name)!==''})}
    var assignedLoopIds={}
    gateways.forEach(function(g){loopsOf(g).forEach(function(l){assignedLoopIds[l.id]=true})})
    var unassignedLoops=loops.filter(function(l){return !assignedLoopIds[l.id]})

    function updateGw(gid,field,val){
      onUpdateGateways(gateways.map(function(g){if(g.id!==gid)return g;var o={};o[field]=val;return Object.assign({},g,o)}))
    }
    function deleteGw(gid){
      var g=gateways.find(function(x){return x.id===gid})
      if(!g)return
      // Unlink its loops so they show as unassigned again
      onUpdateLoops(loops.map(function(l){return up(l.gateway)===up(g.name)?Object.assign({},l,{gateway:''}):l}))
      onUpdateGateways(gateways.filter(function(x){return x.id!==gid}))
    }
    function assignLoop(loopId,gwName){
      onUpdateLoops(loops.map(function(l){return l.id===loopId?Object.assign({},l,{gateway:up(gwName)}):l}))
    }
    function addGw(){
      if(!newLoop.name.trim())return
      onUpdateGateways(gateways.concat([{id:'gw-'+Date.now(),name:up(newLoop.name),kind:newLoop.protocol==='RTR'?'RTR':'GATEWAY',ddc_ref:up(newLoop.ddc_ref),ip:up(newLoop.gateway),bacnet_id:up(newLoop.zone),notes:''}]))
      setNewLoop({name:'',protocol:'MODBUS RTU',gateway:'',ddc_ref:'',floor:'',zone:''})
      setAddDevTo(null)
    }

    // Gateway commissioning: two independent ways to stand up the gateway side of a Modbus loop —
    // export a config.csv for a real FieldServer box (loaded on site, manually), or run this
    // toolkit as the gateway itself (no physical box). Kept as one small expandable strip per
    // gateway card, not a permanent fixture — this isn't every-day info like the loop table above.
    function openConfigForm(g){
      setDgCtl(function(prev){var next=Object.assign({},prev);next[g.id]=Object.assign({mode:'config',cfgTitle:g.name,cfgNodeId:g.bacnet_id||'',cfgNetNum:'1',cfgProtoName:g.name,bacnetAddr:'127.0.0.1/8:47850',instance:'5115'},prev[g.id],{mode:'config'});return next})
    }
    function openGatewayForm(g){
      setDgCtl(function(prev){var next=Object.assign({},prev);next[g.id]=Object.assign({mode:'gateway',bacnetAddr:'127.0.0.1/8:47850',instance:'5115'},prev[g.id],{mode:'gateway'});return next})
    }
    function closeCommForm(gid){
      setDgCtl(function(prev){var next=Object.assign({},prev);if(next[gid])next[gid]=Object.assign({},next[gid],{mode:null});return next})
    }
    function dgSet(gid,patch){setDgCtl(function(prev){var next=Object.assign({},prev);next[gid]=Object.assign({},next[gid],patch);return next})}
    function generateConfig(g){
      var c=dgCtl[g.id]||{}
      dgSet(g.id,{busy:'generate',err:''})
      ca.modbusGenerateConfig({project_id:projectId,gateway_key:ca.gatewayKeyFor(g.name),gateway_identity:{
        title:c.cfgTitle||g.name, system_node_id:parseInt(c.cfgNodeId||'0',10)||0,
        network_number:parseInt(c.cfgNetNum||'1',10)||1, protonode_name:c.cfgProtoName||g.name}})
        .then(function(res){
          var blob=new Blob([res.content],{type:'text/csv'})
          var url=URL.createObjectURL(blob)
          var a=document.createElement('a'); a.href=url; a.download=res.filename||(g.name+'_config.csv')
          document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
          dgSet(g.id,{busy:null,lastResult:res.device_count+' devices, '+(res.warnings||[]).length+' warnings'})
        })
        .catch(function(e){dgSet(g.id,{busy:null,err:e.message})})
    }
    function startGateway(g){
      var c=dgCtl[g.id]||{}
      var bt=busTarget()
      dgSet(g.id,{busy:'start',err:''})
      ca.modbusGatewayStart(Object.assign({project_id:projectId,gateway_key:ca.gatewayKeyFor(g.name),
        bacnet_address:c.bacnetAddr||'127.0.0.1/8:47850',instance:parseInt(c.instance||'5115',10)},bt))
        .then(function(res){dgSet(g.id,{busy:null,gwStatus:res})})
        .catch(function(e){dgSet(g.id,{busy:null,err:e.message})})
    }
    function stopGateway(g){
      dgSet(g.id,{busy:'stop',err:''})
      ca.modbusGatewayStop({gateway_key:ca.gatewayKeyFor(g.name)})
        .then(function(res){dgSet(g.id,{busy:null,gwStatus:res})})
        .catch(function(e){dgSet(g.id,{busy:null,err:e.message})})
    }
    function checkGatewayStatus(g){
      ca.modbusGatewayStatus({gateway_key:ca.gatewayKeyFor(g.name)}).then(function(res){dgSet(g.id,{gwStatus:res})}).catch(function(){})
    }

    return (<div>
      <div className="flex justify-between items-center mb-3 gap-3">
        <div className="text-xs text-dgray uppercase">GATEWAY = MODBUS HEAD-END · RTR = BACNET MSTP/IP ROUTER. ASSIGN LOOPS ONCE — SYNCED WITH LOOP VIEW, LOCATION VIEW AND TRACED DRAWINGS.</div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[10px] text-dgray uppercase">BUS</span>
          <input type="text" value={bus} onChange={function(e){setBus(e.target.value);localStorage.setItem('kmc_modbus_bus',e.target.value)}}
            placeholder="COM5 or host:port" title="This laptop's RS-485 serial port, or host:port for a TCP test bus"
            className="w-32 px-1.5 py-1 text-[10px] bg-navy border border-border rounded text-dgray focus:text-white outline-none focus:border-teal"/>
        </div>
        <button onClick={function(){setAddDevTo(showAddGw?null:'__gw__')}} className="px-4 py-2 bg-teal text-white text-xs font-semibold rounded-md hover:bg-teal/80 uppercase shrink-0">+ ADD GATEWAY/RTR</button>
      </div>

      {showAddGw&&(<div className="bg-card rounded-xl border border-teal p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-3">
          <div><label className="text-[10px] text-dgray block mb-1">NAME/NUMBER</label><input value={newLoop.name} onChange={function(e){setNewLoop(Object.assign({},newLoop,{name:e.target.value}))}} placeholder="GW-01 / RTR-01" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal"/></div>
          <div><label className="text-[10px] text-dgray block mb-1">TYPE</label><select value={newLoop.protocol} onChange={function(e){setNewLoop(Object.assign({},newLoop,{protocol:e.target.value}))}} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal uppercase"><option value="GATEWAY">GATEWAY (MODBUS)</option><option value="RTR">RTR (BACNET)</option></select></div>
          <div><label className="text-[10px] text-dgray block mb-1">DDC REF</label><input value={newLoop.ddc_ref} onChange={function(e){setNewLoop(Object.assign({},newLoop,{ddc_ref:e.target.value}))}} placeholder="DDC-GF-01" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal"/></div>
          <div><label className="text-[10px] text-dgray block mb-1">IP ADDRESS</label><input value={newLoop.gateway} onChange={function(e){setNewLoop(Object.assign({},newLoop,{gateway:e.target.value}))}} placeholder="192.168.1.10" className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal"/></div>
          <div><label className="text-[10px] text-dgray block mb-1">BACNET ID</label><input value={newLoop.zone} onChange={function(e){setNewLoop(Object.assign({},newLoop,{zone:e.target.value}))}} placeholder="2401" className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal"/></div>
          <div className="flex items-end gap-2"><button onClick={addGw} className="px-4 py-1.5 bg-teal text-white text-xs font-semibold rounded hover:bg-teal/80 uppercase">CREATE</button><button onClick={function(){setAddDevTo(null)}} className="px-3 py-1.5 bg-card2 text-dgray text-xs rounded hover:text-white uppercase">X</button></div>
        </div>
      </div>)}

      {gateways.length>0&&(<div className="hidden md:grid bg-card2 rounded-t-lg px-4 py-2 grid-cols-12 gap-2 text-[9px] text-dgray uppercase font-semibold border border-border/50 border-b-0">
        <div className="col-span-2">GATEWAY/RTR</div><div className="col-span-1">TYPE</div><div className="col-span-2">DDC REF</div><div className="col-span-2">IP ADDRESS</div><div className="col-span-1">BACNET ID</div><div className="col-span-1 text-center">LOOPS</div><div className="col-span-3 text-right">PROGRESS</div>
      </div>)}
      {gateways.map(function(g,gi){
        var gLoops=loopsOf(g)
        var gDevs=[];gLoops.forEach(function(l){gDevs=gDevs.concat(l.devices)})
        var gPct=calcWeightedPct(gDevs)
        var isRtr=g.kind==='RTR'
        var isGExp=expandedGw===g.id
        return (<div key={g.id} className={'bg-card border border-border/50 overflow-hidden '+(gi===gateways.length-1?'rounded-b-lg':'')}>
          {/* Gateway row — click to expand its loops */}
          <div className="px-4 py-2.5 flex flex-wrap md:grid md:grid-cols-12 gap-2 items-center cursor-pointer hover:bg-card2/50" onClick={function(){setExpandedGw(isGExp?null:g.id);setExpandedGwLoop(null)}}>
            <div className="flex-1 md:flex-none md:col-span-2 flex items-center gap-1.5">
              <span className="text-dgray text-xs w-3">{isGExp?'▾':'▸'}</span>
              <input value={g.name||''} onClick={function(e){e.stopPropagation()}} onChange={function(e){updateGw(g.id,'name',up(e.target.value))}} style={{textTransform:'uppercase'}} className="bg-transparent border-b border-transparent focus:border-teal text-sm font-bold text-white outline-none w-full min-w-0"/>
            </div>
            <div className="md:col-span-1" onClick={function(e){e.stopPropagation()}}>
              <select value={g.kind||'GATEWAY'} onChange={function(e){updateGw(g.id,'kind',e.target.value)}} className={'bg-transparent text-[9px] font-bold outline-none cursor-pointer uppercase '+(isRtr?'text-purple':'text-teal')}>
                <option value="GATEWAY">GATEWAY</option><option value="RTR">RTR</option>
              </select>
            </div>
            <div className="hidden md:block md:col-span-2" onClick={function(e){e.stopPropagation()}}><input value={g.ddc_ref||''} onChange={function(e){updateGw(g.id,'ddc_ref',up(e.target.value))}} style={{textTransform:'uppercase'}} placeholder="-" className="bg-transparent border-b border-transparent focus:border-teal text-[11px] text-cyan outline-none w-full"/></div>
            <div className="hidden md:block md:col-span-2" onClick={function(e){e.stopPropagation()}}><input value={g.ip||''} onChange={function(e){updateGw(g.id,'ip',e.target.value)}} placeholder="-" className="bg-transparent border-b border-transparent focus:border-teal text-[11px] text-orange outline-none w-full"/></div>
            <div className="hidden md:block md:col-span-1" onClick={function(e){e.stopPropagation()}}><input value={g.bacnet_id||''} onChange={function(e){updateGw(g.id,'bacnet_id',e.target.value)}} placeholder="-" className="bg-transparent border-b border-transparent focus:border-teal text-[11px] text-purple outline-none w-full"/></div>
            <div className="md:col-span-1 text-center text-[11px] text-dgray">{gLoops.length} ({gDevs.length} DEV)</div>
            <div className="md:col-span-3 flex items-center justify-end gap-2">
              <div className="w-16 h-1.5 bg-navy rounded overflow-hidden"><div className={'h-full rounded '+(gPct>=100?'bg-green':gPct>=50?'bg-teal':gPct>0?'bg-orange':'bg-red')} style={{width:gPct+'%'}}/></div>
              <span className="text-[10px] text-dgray w-8 text-right">{gPct}%</span>
              {projectId&&!isRtr&&(<span className="flex items-center gap-1" onClick={function(e){e.stopPropagation()}}>
                <button onClick={function(){openConfigForm(g)}} title="EXPORT A config.csv FOR A REAL FIELDSERVER — LOAD IT ON SITE MANUALLY" className={'px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded border '+((dgCtl[g.id]||{}).mode==='config'?'bg-teal/20 border-teal text-teal':'border-border text-dgray hover:text-teal')}>CONFIG</button>
                <button onClick={function(){openGatewayForm(g)}} title="RUN THIS TOOLKIT AS THE GATEWAY — NO PHYSICAL FIELDSERVER" className={'px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded border '+((dgCtl[g.id]||{}).mode==='gateway'?'bg-orange/20 border-orange text-orange':'border-border text-dgray hover:text-orange')}>GATEWAY</button>
              </span>)}
              <button onClick={function(e){e.stopPropagation();deleteGw(g.id)}} className="text-[10px] text-red/40 hover:text-red ml-1">X</button>
            </div>
          </div>

          {/* CONFIG / GATEWAY commissioning strip — collapsed unless opened */}
          {(dgCtl[g.id]||{}).mode&&(function(){
            var c=dgCtl[g.id]
            return (<div className="px-4 py-2.5 bg-navy/30 border-t border-border/30 border-b border-border/30 text-[10px]">
              {c.mode==='config'?(<div className="flex flex-wrap items-end gap-2">
                <div><label className="block text-dgray mb-0.5">TITLE</label><input value={c.cfgTitle||''} onChange={function(e){dgSet(g.id,{cfgTitle:e.target.value})}} className="w-28 bg-navy border border-border rounded px-1.5 py-1 text-white outline-none focus:border-teal"/></div>
                <div><label className="block text-dgray mb-0.5">SYSTEM NODE ID</label><input value={c.cfgNodeId||''} onChange={function(e){dgSet(g.id,{cfgNodeId:e.target.value})}} placeholder="e.g. 5115" className="w-24 bg-navy border border-border rounded px-1.5 py-1 text-white outline-none focus:border-teal"/></div>
                <div><label className="block text-dgray mb-0.5">NETWORK NUMBER</label><input value={c.cfgNetNum||''} onChange={function(e){dgSet(g.id,{cfgNetNum:e.target.value})}} placeholder="e.g. 55" className="w-20 bg-navy border border-border rounded px-1.5 py-1 text-white outline-none focus:border-teal"/></div>
                <div><label className="block text-dgray mb-0.5">PROTONODE NAME</label><input value={c.cfgProtoName||''} onChange={function(e){dgSet(g.id,{cfgProtoName:e.target.value})}} placeholder="PROTONODE-8" className="w-28 bg-navy border border-border rounded px-1.5 py-1 text-white outline-none focus:border-teal"/></div>
                <button onClick={function(){generateConfig(g)}} disabled={c.busy==='generate'} className="px-3 py-1 bg-teal text-white font-semibold uppercase rounded hover:bg-teal/80 disabled:opacity-40">{c.busy==='generate'?'GENERATING…':'DOWNLOAD CONFIG.CSV'}</button>
                <button onClick={function(){closeCommForm(g.id)}} className="text-dgray hover:text-white px-1">X</button>
                {c.lastResult&&<span className="text-green w-full">{c.lastResult}</span>}
              </div>):(<div className="flex flex-wrap items-end gap-2">
                <div><label className="block text-dgray mb-0.5">BACNET ADDRESS</label><input value={c.bacnetAddr||''} onChange={function(e){dgSet(g.id,{bacnetAddr:e.target.value})}} placeholder="192.168.1.60/24:47808" className="w-40 bg-navy border border-border rounded px-1.5 py-1 text-white outline-none focus:border-orange"/></div>
                <div><label className="block text-dgray mb-0.5">DEVICE INSTANCE</label><input value={c.instance||''} onChange={function(e){dgSet(g.id,{instance:e.target.value})}} className="w-20 bg-navy border border-border rounded px-1.5 py-1 text-white outline-none focus:border-orange"/></div>
                {c.gwStatus&&c.gwStatus.running?(
                  <button onClick={function(){stopGateway(g)}} disabled={c.busy==='stop'} className="px-3 py-1 bg-red/20 text-red font-semibold uppercase rounded hover:bg-red/30 disabled:opacity-40">{c.busy==='stop'?'STOPPING…':'STOP'}</button>
                ):(
                  <button onClick={function(){startGateway(g)}} disabled={c.busy==='start'||!bus.trim()} title={!bus.trim()?'SET BUS ABOVE FIRST':''} className="px-3 py-1 bg-orange/20 text-orange font-semibold uppercase rounded hover:bg-orange/30 disabled:opacity-40">{c.busy==='start'?'STARTING…':'START'}</button>
                )}
                <button onClick={function(){checkGatewayStatus(g)}} className="px-2 py-1 border border-border text-dgray hover:text-white rounded uppercase">REFRESH</button>
                <button onClick={function(){closeCommForm(g.id)}} className="text-dgray hover:text-white px-1">X</button>
                {c.gwStatus&&(<span className={'w-full '+(c.gwStatus.running?'text-green':'text-dgray')}>
                  {c.gwStatus.running?('RUNNING — PID '+c.gwStatus.pid+', UP '+c.gwStatus.uptime_s+'S'):'NOT RUNNING'}
                </span>)}
              </div>)}
              {c.err&&<div className="text-red mt-1">{c.err}</div>}
            </div>)
          })()}

          {/* Expanded: loops under this gateway */}
          {isGExp&&(<div className="border-t border-border/30">
            {gLoops.length===0&&(<div className="px-8 py-3 text-[11px] text-dgray italic uppercase">NO LOOPS ASSIGNED — USE THE DROPDOWNS IN THE UNASSIGNED SECTION BELOW</div>)}
            {gLoops.map(function(l){
              var lPct=calcWeightedPct(l.devices)
              var isLExp=expandedGwLoop===l.id
              return (<div key={l.id}>
                <div className="pl-8 pr-4 py-2 flex flex-wrap items-center gap-2 cursor-pointer hover:bg-card2/40 border-b border-border/20" onClick={function(){setExpandedGwLoop(isLExp?null:l.id)}}>
                  <span className="text-dgray text-xs w-3">{isLExp?'▾':'▸'}</span>
                  <span className="text-xs font-bold text-white uppercase">{l.name}</span>
                  {l.floor&&<span className="text-[9px] text-orange uppercase">{l.floor}</span>}
                  <span className="text-[9px] bg-purple/20 text-purple px-1.5 py-0.5 rounded">{l.protocol}</span>
                  <select value={l.port||''} onClick={function(e){e.stopPropagation()}} onChange={function(e){handleLoopField(l.id,'port',e.target.value)}}
                    title="WHICH RS-485 PORT ON THE PHYSICAL FIELDSERVER THIS LOOP IS WIRED TO"
                    className={'text-[9px] font-bold px-1.5 py-0.5 rounded border outline-none cursor-pointer '+(l.port?'bg-cyan/10 border-cyan/40 text-cyan':'bg-red/10 border-red/40 text-red')}>
                    <option value="">PORT?</option>
                    <option value="R1">R1</option>
                    <option value="R2">R2</option>
                  </select>
                  <span className="text-[10px] text-dgray">{l.devices.length} DEV</span>
                  <div className="w-14 h-1 bg-navy rounded overflow-hidden"><div className={'h-full rounded '+(lPct>=100?'bg-green':lPct>0?'bg-teal':'bg-red/30')} style={{width:lPct+'%'}}/></div>
                  <span className="ml-auto flex items-center gap-3">
                    {projectId&&(<span className="flex items-center gap-1.5" onClick={function(e){e.stopPropagation()}}>
                      <button onClick={function(){runPreflight(l)}} disabled={!!(modbusComm[l.id]||{}).busy} title="CHECK SCHEDULE FOR DUPLICATE/MISSING ADDRESSES — NO HARDWARE NEEDED" className="px-2 py-0.5 text-[9px] font-semibold uppercase rounded border border-teal/50 text-teal hover:bg-teal/10 disabled:opacity-40">PREFLIGHT</button>
                      <button onClick={function(){runScan(l)}} disabled={!!(modbusComm[l.id]||{}).busy||!bus.trim()} title="SCAN THE BUS FOR RESPONDING ADDRESSES" className="px-2 py-0.5 text-[9px] font-semibold uppercase rounded border border-cyan/50 text-cyan hover:bg-cyan/10 disabled:opacity-40">SCAN</button>
                      <button onClick={function(){runVerify(l)}} disabled={!!(modbusComm[l.id]||{}).busy||!bus.trim()} title="READ EVERY DEVICE ON THIS LOOP AT ITS EXPECTED ADDRESS" className="px-2 py-0.5 text-[9px] font-semibold uppercase rounded border border-orange/50 text-orange hover:bg-orange/10 disabled:opacity-40">VERIFY</button>
                    </span>)}
                    <button onClick={function(e){e.stopPropagation();onUpdateLoops(loops.map(function(x){return x.id===l.id?Object.assign({},x,{devices:sortDevsByAddr(x.devices)}):x}))}} title="ARRANGE DEVICES SMALLEST ADDRESS FIRST" className="text-[9px] text-teal hover:text-cyan uppercase">SORT BY ADDR</button>
                    <button onClick={function(e){e.stopPropagation();assignLoop(l.id,'')}} className="text-[9px] text-dgray hover:text-red uppercase">UNASSIGN</button>
                  </span>
                </div>
                {(function(){
                  var mc=modbusComm[l.id]
                  if(!mc)return null
                  return (<div className="pl-8 pr-4 py-1.5 border-b border-border/20 bg-navy/20 text-[10px] flex flex-wrap items-center gap-2">
                    {mc.busy&&<span className="text-dgray uppercase">{mc.busy}ING…</span>}
                    {mc.err&&<span className="text-red">{mc.err}</span>}
                    {mc.preflightWarnings&&(mc.preflightWarnings.length===0
                      ? <span className="text-green uppercase">PREFLIGHT: NO ISSUES</span>
                      : <span className="text-orange uppercase">PREFLIGHT: {mc.preflightWarnings.length} WARNING{mc.preflightWarnings.length===1?'':'S'} — {mc.preflightWarnings.slice(0,3).map(function(w){return w.kind}).join(', ')}</span>)}
                    {mc.scanFound&&(mc.scanFound.length===0
                      ? <span className="text-red uppercase">SCAN: NO DEVICES RESPONDED</span>
                      : <span className="text-cyan uppercase">SCAN FOUND: {mc.scanFound.join(', ')}</span>)}
                    {mc.summary&&(<>
                      <span className="text-dgray">{mc.summary.checked} CHECKED</span>
                      <span className="text-green">{mc.summary.pass} PASS</span>
                      {mc.summary.fail>0&&<span className="text-red">{mc.summary.fail} FAIL</span>}
                      {mc.checks&&mc.checks.length>0&&(
                        <button onClick={function(){setModbusFor(l.id,{showDetails:!mc.showDetails})}} className="text-dgray hover:text-cyan underline decoration-dotted uppercase">{mc.showDetails?'HIDE':'DETAILS'}</button>
                      )}
                    </>)}
                    {mc.showDetails&&mc.checks&&mc.checks.map(function(c,i){
                      return <span key={i} className="text-[9px] bg-card2 px-1.5 py-0.5 rounded"><span className="text-white">{c.tag}</span> <span className="text-red">{c.status}</span></span>
                    })}
                  </div>)
                })()}
                {isLExp&&(<div className="pl-10 pr-4 py-2 bg-navy/40 border-b border-border/20 overflow-x-auto">
                  <table className="w-full"><thead><tr className="border-b border-border/50">
                    <th className="text-[9px] text-dgray text-left px-2 py-1.5">TYPE</th>
                    <th className="text-[9px] text-dgray text-left px-2 py-1.5">EQUIP TAG</th>
                    <th className="text-[9px] text-dgray text-left px-2 py-1.5">ROOM</th>
                    <th className="text-[9px] text-dgray text-center px-2 py-1.5">ADDR</th>
                    {loopStages.map(function(s){return <th key={s} className="text-[9px] text-dgray text-center px-1 py-1.5">{stgLbl[s]}</th>})}
                  </tr></thead><tbody>
                    {l.devices.map(function(dev){
                      return (<tr key={dev.id} className="border-b border-border/20 hover:bg-teal/4">
                        <td className="px-1 py-1.5"><select value={dev.device_type} onChange={function(e){handleDeviceField(l.id,dev.id,'device_type',e.target.value)}} className="bg-transparent text-[10px] text-purple uppercase outline-none cursor-pointer w-full">{deviceTypeOptions.map(function(dt){return <option key={dt} value={dt}>{dt}</option>})}{deviceTypeOptions.indexOf(dev.device_type)<0&&<option value={dev.device_type}>{dev.device_type}</option>}</select></td>
                        <td className="text-[11px] px-2 py-1.5 text-white font-medium uppercase">{dev.tag||'-'}</td>
                        <td className="text-[11px] px-2 py-1.5 text-lgray uppercase">{dev.room_name||'-'}</td>
                        <td className="text-[11px] px-2 py-1.5 text-cyan text-center">{dev.address||'-'}</td>
                        {loopStages.map(function(s){var ch=dev[s],idx=loopStages.indexOf(s),prev=idx===0||dev[loopStages[idx-1]];return <td key={s} className="text-center px-1 py-1.5"><StgBtn checked={ch} prevDone={prev} onClick={function(){handleToggle(l.id,dev.id,s)}}/></td>})}
                      </tr>)
                    })}
                  </tbody></table>
                  <div className="text-[8px] text-dgray uppercase mt-1.5">EDIT TAGS/ROOMS/ADDRESSES IN LOOP VIEW — DEVICE TYPE AND STAGES ARE LIVE HERE</div>
                </div>)}
              </div>)
            })}
          </div>)}
        </div>)
      })}

      {gateways.length===0&&(<div className="bg-card rounded-xl border border-border p-8 text-center mb-3"><div className="text-dgray text-sm uppercase">NO GATEWAYS OR RTRS YET. ADD ONE TO BUILD THE NETWORK TREE.</div></div>)}

      {unassignedLoops.length>0&&(<div className="bg-card rounded-xl border border-orange/30 p-4">
        <div className="text-[10px] text-orange font-bold uppercase mb-2">LOOPS WITHOUT A GATEWAY/RTR ({unassignedLoops.length})</div>
        {unassignedLoops.map(function(l){
          return (<div key={l.id} className="flex flex-wrap items-center gap-2 py-1.5 border-b border-border/20">
            <span className="text-xs font-bold text-white uppercase">{l.name}</span>
            {l.floor&&<span className="text-[9px] text-orange uppercase">{l.floor}</span>}
            <span className="text-[10px] text-dgray">{l.devices.length} DEV</span>
            {l.gateway&&<span className="text-[9px] text-dgray uppercase">(GATEWAY "{l.gateway}" NOT DEFINED)</span>}
            <select value="" onChange={function(e){if(e.target.value)assignLoop(l.id,e.target.value)}} className="ml-auto bg-navy border border-border rounded px-2 py-1 text-[10px] text-white outline-none uppercase cursor-pointer">
              <option value="">ASSIGN TO...</option>
              {gateways.map(function(g){return <option key={g.id} value={g.name}>{g.name} ({g.kind})</option>})}
            </select>
          </div>)
        })}
      </div>)}
    </div>)
  }

  function renderLocationView(){
    return (<div>
      <div className="flex justify-between items-center mb-3">
        <div className="text-xs text-dgray uppercase">GROUP DEVICES BY AREA. FULL COMMISSIONING CHECKLIST PER DEVICE.</div>
        <button onClick={function(){setShowAddArea(!showAddArea)}} className="px-4 py-2 bg-teal text-white text-xs font-semibold rounded-md hover:bg-teal/80 uppercase">+ ADD AREA GROUP</button>
      </div>
      {showAddArea&&(<div className="bg-card rounded-xl border border-teal p-4 mb-4">
        <h3 className="text-sm font-semibold mb-2 uppercase">NEW AREA GROUP{newArea.floor?<span className="text-teal"> — {newArea.floor}</span>:null}</h3>
        <div className="flex gap-3 items-end">
          <div className="flex-1"><label className="text-[10px] text-dgray block mb-1">AREA NAME</label><input value={newArea.name} onChange={function(e){setNewArea(Object.assign({},newArea,{name:e.target.value}))}} placeholder="EAST WING - ZONE 2" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal"/></div>
          <div><label className="text-[10px] text-dgray block mb-1">FLOOR</label><input value={newArea.floor} onChange={function(e){setNewArea(Object.assign({},newArea,{floor:e.target.value}))}} placeholder="GF" style={{textTransform:'uppercase'}} className="w-20 bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal"/></div>
          <button onClick={addArea} className="px-4 py-1.5 bg-teal text-white text-xs font-semibold rounded hover:bg-teal/80 uppercase">CREATE</button>
          <button onClick={function(){setShowAddArea(false)}} className="px-4 py-1.5 bg-card2 text-dgray text-xs rounded hover:text-white uppercase">CANCEL</button>
        </div>
      </div>)}

      {(function(){
        // Group areas under collapsible floor headers
        var floorGroups={},floorList=[]
        areas.forEach(function(a){
          var f=areaFloorOf(a)
          if(!floorGroups[f]){floorGroups[f]=[];floorList.push(f)}
          floorGroups[f].push(a)
        })
        floorList.sort(function(x,y){if(x==='UNSPECIFIED')return 1;if(y==='UNSPECIFIED')return -1;return x<y?-1:1})
        var devMapAll={};allDevices.forEach(function(d){devMapAll[d.id]=d})
        return floorList.map(function(fl){
          var fAreas=floorGroups[fl]
          var fDevs=[]
          fAreas.forEach(function(a){a.device_ids.forEach(function(id){if(devMapAll[id])fDevs.push(devMapAll[id])})})
          var fPct=calcWeightedPct(fDevs)
          var isC=locCollapsed[fl]
          return (<div key={fl} className="mb-4">
            <div className="flex items-center gap-3 px-4 py-2.5 bg-card2 rounded-xl border border-border cursor-pointer hover:bg-card2/80 mb-2" onClick={function(){var n=Object.assign({},locCollapsed);n[fl]=!isC;setLocCollapsed(n)}}>
              <span className="text-dgray text-xs">{isC?'▸':'▾'}</span>
              <span className="text-sm font-extrabold text-orange uppercase">{fl}</span>
              <span className="text-[10px] text-dgray uppercase">{fAreas.length} AREA{fAreas.length===1?'':'S'} · {fDevs.length} DEVICES</span>
              <span className="ml-auto flex items-center gap-2" onClick={function(e){e.stopPropagation()}}>
                <div className="w-16 h-1.5 bg-navy rounded overflow-hidden"><div className={'h-full rounded '+(fPct>=100?'bg-green':fPct>=50?'bg-teal':fPct>0?'bg-orange':'bg-red/30')} style={{width:fPct+'%'}}/></div>
                <span className="text-[10px] text-dgray w-8 text-right">{fPct}%</span>
                <button onClick={function(){setNewArea({name:'',floor:fl==='UNSPECIFIED'?'':fl});setShowAddArea(true)}} title="NEW AREA ON THIS FLOOR" className="px-2 py-1 bg-teal/20 text-teal text-[9px] font-bold rounded uppercase hover:bg-teal/30">+ AREA</button>
              </span>
            </div>
            {!isC&&fAreas.map(function(area){
        var isExp=expanded==='area-'+area.id
        var devMap={};allDevices.forEach(function(d){devMap[d.id]=d})
        var ad=area.device_ids.map(function(id){return devMap[id]}).filter(function(d){return !!d})
        var ai=ad.filter(function(d){return d.device_installed}).length
        var adone=ad.filter(function(d){return loopStages.every(function(s){return d[s]})}).length
        var pct=calcWeightedPct(ad)
        var isDT=dragDev&&dragDev.type==='area'&&dragDev.fromAreaId!==area.id
        return (<div key={area.id} className={'bg-card rounded-xl border mb-3 overflow-hidden transition '+(isDT?'border-cyan border-2':'border-border')}
          onDragOver={function(e){e.preventDefault()}} onDrop={function(){dropOnArea(area.id)}}>
          <div className="bg-card2 px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-card2/80" onClick={function(){setExpanded(isExp?null:'area-'+area.id)}}>
            <div className="flex items-center gap-3">
              <span className="flex flex-col -my-1" onClick={function(e){e.stopPropagation()}}>
                <button onClick={function(){moveArea(area.id,-1)}} title="MOVE AREA UP" className="text-[10px] text-dgray hover:text-teal leading-none px-1">▲</button>
                <button onClick={function(){moveArea(area.id,1)}} title="MOVE AREA DOWN" className="text-[10px] text-dgray hover:text-teal leading-none px-1">▼</button>
              </span>
              <input value={area.name} onClick={function(e){e.stopPropagation()}} onChange={function(e){renameArea(area.id,e.target.value)}} onBlur={function(){renameAreaBlur(area.id)}} style={{textTransform:'uppercase'}} className="bg-transparent text-sm font-bold text-white outline-none border-b border-transparent focus:border-teal w-56"/>
              <span className="flex items-center gap-1" onClick={function(e){e.stopPropagation()}}><span className="text-[9px] text-dgray uppercase">FLOOR:</span><input value={area.floor||''} onChange={function(e){onUpdateAreas(areas.map(function(a){return a.id===area.id?Object.assign({},a,{floor:up(e.target.value)}):a}))}} placeholder={areaFloorOf(area)} style={{textTransform:'uppercase'}} className="bg-transparent text-[10px] text-orange font-bold outline-none border-b border-transparent focus:border-teal w-12"/></span>
              <span className="text-[10px] text-dgray uppercase">{ad.length} DEVICES</span><span className="text-[10px] text-dgray">|</span>
              <span className="text-[10px] text-green uppercase">{ai} INSTALLED</span><span className="text-[10px] text-dgray">|</span>
              <span className="text-[10px] text-green uppercase">{adone} DONE</span>
              <span className="text-[10px] text-dgray">|</span>
              <span className="text-[10px] text-dgray uppercase">LOOP:</span>
              <select value={ad.length>0&&ad[0].loop_id?ad[0].loop_id:''} onClick={function(e){e.stopPropagation()}} onChange={function(e){e.stopPropagation();if(e.target.value)bulkAssignToLoop(area.id,e.target.value)}} className="bg-navy text-[10px] text-cyan px-1.5 py-0.5 rounded border border-border outline-none cursor-pointer uppercase">
                {loops.map(function(l){return <option key={l.id} value={l.id}>{l.name}</option>})}
              </select>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5"><div className="w-20 h-1.5 bg-navy rounded overflow-hidden"><div className={'h-full rounded '+(pct>=100?'bg-green':pct>0?'bg-teal':'bg-red')} style={{width:pct+'%'}}/></div><span className="text-[10px] text-dgray">{pct}%</span></div>
              <button onClick={function(e){e.stopPropagation();deleteArea(area.id)}} className="text-[10px] text-red/50 hover:text-red uppercase">REMOVE</button>
              <span className="text-dgray text-xs">{isExp?'V':'>'}</span>
            </div>
          </div>
          {isExp&&(<div className="px-4 py-3">
            {addDevArea===area.id?(<div className="bg-card2 rounded-lg p-3 mb-3 border border-border">
              <div className="text-[9px] text-dgray mb-1 uppercase">NEW DEVICE (ADDED TO UNASSIGNED LOOP - MOVE TO PROPER LOOP LATER)</div>
              <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                <div><label className="text-[9px] text-dgray block mb-0.5">TYPE</label><select value={newDev.device_type} onChange={function(e){setNewDev(Object.assign({},newDev,{device_type:e.target.value}))}} className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none uppercase">{deviceTypeOptions.map(function(dt){return <option key={dt} value={dt}>{dt}</option>})}</select></div>
                <div><label className="text-[9px] text-dgray block mb-0.5">EQUIP TAG</label><input value={newDev.tag} onChange={function(e){setNewDev(Object.assign({},newDev,{tag:e.target.value}))}} placeholder="FCU-01" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none"/></div>
                <div><label className="text-[9px] text-dgray block mb-0.5">ROOM</label><input value={newDev.room_name} onChange={function(e){setNewDev(Object.assign({},newDev,{room_name:e.target.value}))}} placeholder="ROOM 101" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none"/></div>
                <div><label className="text-[9px] text-dgray block mb-0.5">ADDRESS</label><input value={newDev.address} onChange={function(e){setNewDev(Object.assign({},newDev,{address:e.target.value}))}} placeholder="1" style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none"/></div>
                <div className="flex items-end gap-1"><button onClick={function(){addDeviceToArea(area.id)}} className="px-3 py-1 bg-teal text-white text-[11px] font-semibold rounded hover:bg-teal/80 uppercase">ADD</button><button onClick={function(){setAddDevArea(null)}} className="px-3 py-1 bg-card text-dgray text-[11px] rounded hover:text-white">X</button></div>
              </div>
            </div>):(<button onClick={function(){setAddDevArea(area.id)}} className="text-[11px] text-teal hover:text-cyan font-medium mb-3 block uppercase">+ ADD DEVICE TO THIS AREA</button>)}

            {ad.length>0?(<div className="overflow-x-auto"><table className="w-full mb-3"><thead><tr className="border-b border-border/50">
              <th className="text-[9px] text-dgray text-center px-1 py-1.5 w-6"></th>
              <th className="text-[9px] text-dgray text-left px-2 py-1.5">EQUIP TAG</th>
              <th className="text-[9px] text-dgray text-left px-2 py-1.5">TYPE</th>
              <th className="text-[9px] text-dgray text-left px-2 py-1.5">ROOM</th>
              <th className="text-[9px] text-dgray text-left px-2 py-1.5">LOOP</th>
              <th className="text-[9px] text-dgray text-center px-2 py-1.5">ADDR</th>
              {loopStages.filter(function(s){return s!=='address_set'}).map(function(s){return <th key={s} className="text-[9px] text-dgray text-center px-1 py-1.5">{stgLbl[s]}</th>})}
              <th className="text-[9px] text-dgray text-left px-2 py-1.5 min-w-[140px]">REMARKS</th>
              <th className="w-6"></th>
            </tr></thead><tbody>
              {ad.map(function(d,di){
                var isAR=dragAreaIdx&&dragAreaIdx.areaId===area.id&&dragAreaIdx.fromIndex!==di
                return (<tr key={d.id} className={'border-b border-border/20 hover:bg-teal/4 align-top '+(isAR?'bg-teal/8':'')} draggable={true}
                  onDragStart={function(e){e.dataTransfer.effectAllowed='move';startReorderArea(area.id,di);startDragArea(d.id,area.id)}}
                  onDragOver={function(e){e.preventDefault()}}
                  onDrop={function(e){e.stopPropagation();if(dragAreaIdx&&dragAreaIdx.areaId===area.id)dropReorderArea(area.id,di)}}
                  onDragEnd={function(){setDragDev(null);setDragAreaIdx(null)}}>
                  <td className="text-center px-1 py-1.5 cursor-grab text-dgray text-[10px]">::</td>
                  <td className="px-2 py-1.5"><input type="text" value={d.tag||''} onChange={function(e){handleDevFieldById(d.id,'tag',e.target.value)}} onBlur={function(){handleDevBlurById(d.id,'tag')}} style={{textTransform:'uppercase'}} className="bg-transparent border-b border-transparent focus:border-teal text-[11px] text-white font-medium outline-none w-24" placeholder="-"/></td>
                  <td className="px-1 py-1.5"><select value={d.device_type} onChange={function(e){handleDevFieldById(d.id,'device_type',e.target.value)}} className="bg-transparent text-[10px] text-purple uppercase outline-none cursor-pointer w-full">{deviceTypeOptions.map(function(dt){return <option key={dt} value={dt}>{dt}</option>})}{deviceTypeOptions.indexOf(d.device_type)<0&&<option value={d.device_type}>{d.device_type}</option>}</select></td>
                  <td className="px-2 py-1.5"><input type="text" value={d.room_name||''} onChange={function(e){handleDevFieldById(d.id,'room_name',e.target.value)}} onBlur={function(){handleDevBlurById(d.id,'room_name')}} style={{textTransform:'uppercase'}} className="bg-transparent border-b border-transparent focus:border-teal text-[11px] text-white outline-none w-full" placeholder="-"/></td>
                  <td className="text-[10px] px-2 py-1.5 text-dgray uppercase">{d.loop_name}</td>
                  <td className="text-center px-2 py-1.5"><input type="text" value={d.address||''} onChange={function(e){handleDevFieldById(d.id,'address',e.target.value)}} onBlur={function(){handleDevBlurById(d.id,'address')}} style={{textTransform:'uppercase'}} className="bg-transparent border-b border-transparent focus:border-teal text-[11px] text-cyan text-center outline-none w-10 mx-auto" placeholder="-"/></td>
                  {loopStages.filter(function(s){return s!=='address_set'}).map(function(s){var ch=d[s],idx=loopStages.indexOf(s),prev=idx===0||d[loopStages[idx-1]];return <td key={s} className="text-center px-1 py-1.5"><StgBtn checked={ch} prevDone={prev} onClick={function(){handleToggleByDevId(d.id,s)}}/></td>})}
                  <td className="px-2 py-1.5 min-w-[140px]"><textarea rows="1" title={d.remarks||''} value={d.remarks||''} onChange={function(e){handleDevFieldById(d.id,'remarks',e.target.value)}} onBlur={function(e){autoShrink(e);handleDevBlurById(d.id,'remarks')}} onInput={autoGrow} onFocus={autoGrow} style={{textTransform:'uppercase',resize:'none',overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis'}} className="bg-transparent border border-transparent focus:border-teal text-[10px] text-orange italic outline-none w-full rounded px-1 py-0.5" placeholder="REMARKS..."/></td>
                  <td className="text-center px-1 py-1.5"><button onClick={function(){toggleDeviceInArea(area.id,d.id)}} className="text-[9px] text-red/40 hover:text-red">X</button></td>
                </tr>)
              })}
            </tbody></table></div>):(<div className="text-[11px] text-dgray italic mb-3 uppercase">NO DEVICES ASSIGNED.</div>)}
            {unassigned.length>0&&(<div>
              <div className="text-[10px] text-dgray uppercase font-semibold mb-1">UNASSIGNED DEVICES - CLICK TO ADD:</div>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                {unassigned.map(function(d){return <button key={d.id} onClick={function(){toggleDeviceInArea(area.id,d.id)}} className="text-[10px] bg-card2 hover:bg-teal/20 text-white px-2 py-1 rounded border border-border hover:border-teal transition uppercase">{d.tag||d.id} <span className="text-dgray">({d.loop_name})</span></button>})}
              </div>
            </div>)}
          </div>)}
        </div>)
            })}
          </div>)
        })
      })()}
      {areas.length===0&&!showAddArea&&(<div className="bg-card rounded-xl border border-border p-8 text-center"><div className="text-dgray text-sm uppercase">NO AREA GROUPS YET.</div><div className="text-[11px] text-dgray mt-1 uppercase">CREATE AREAS TO ORGANIZE DEVICES FOR CLIENT REPORTS.</div></div>)}
      {unassigned.length>0&&areas.length>0&&(<div className="bg-orange/5 rounded-xl border border-orange/30 p-4 mt-3">
        <div className="flex items-center justify-between">
          <div><div className="text-xs text-orange font-semibold uppercase">{unassigned.length} DEVICE(S) NOT ASSIGNED TO ANY AREA</div><div className="text-[10px] text-dgray mt-1 uppercase">EXPAND AN AREA GROUP TO ASSIGN THEM, OR DELETE THEM.</div></div>
          <button onClick={function(){if(confirm('DELETE ALL '+unassigned.length+' UNASSIGNED DEVICES?')){var uids={};unassigned.forEach(function(d){uids[d.id]=true});onUpdateLoops(loops.map(function(l){return Object.assign({},l,{devices:l.devices.filter(function(d){return !uids[d.id]})})}));}}} className="px-3 py-1.5 bg-red/20 text-red text-[10px] font-semibold rounded hover:bg-red/30 uppercase whitespace-nowrap ml-3">DELETE ALL</button>
        </div>
      </div>)}
      {dragDev&&dragDev.type==='area'&&(<div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-cyan/20 text-cyan text-xs px-4 py-2 rounded-lg border border-cyan z-50 uppercase">DRAG DEVICE TO ANOTHER AREA</div>)}
    </div>)
  }
}
