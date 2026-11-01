/* VMD → VRMA. Original implementation, MIT license. */
(function (root) {
'use strict';
const I=[0,0,0,1], Z=[0,0,0];
const add=(a,b)=>a.map((v,i)=>v+b[i]), sub=(a,b)=>a.map((v,i)=>v-b[i]), mul=(a,s)=>a.map(v=>v*s);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0), length=a=>Math.hypot(...a), unit=a=>mul(a,1/(length(a)||1));
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const norm=q=>length(q)<1e-10?I.slice():unit(q), inv=q=>[-q[0],-q[1],-q[2],q[3]];
function qm(a,b){return [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];}
function rotate(q,v){return qm(qm(q,[...v,0]),inv(q)).slice(0,3);}
function axis(a,r){return [...mul(unit(a),Math.sin(r/2)),Math.cos(r/2)];}
function between(a,b){a=unit(a);b=unit(b);const d=dot(a,b);if(d<-.999999){let c=cross(a,[1,0,0]);if(length(c)<.001)c=cross(a,[0,1,0]);return axis(c,Math.PI);}return norm([...cross(a,b),1+d]);}
function slerp(a,b,t){let d=dot(a,b);if(d<0){b=mul(b,-1);d=-d;}if(d>.9995)return norm(a.map((v,i)=>v+(b[i]-v)*t));const theta=Math.acos(clamp(d,-1,1)),s=Math.sin(theta);return a.map((v,i)=>(v*Math.sin((1-t)*theta)+b[i]*Math.sin(t*theta))/s);}
function canonical(s){return s.normalize('NFKC').replace(/\s/g,'');}
class Reader {
 constructor(buffer){this.v=new DataView(buffer);this.o=0;this.decoder=new TextDecoder('shift-jis');}
 need(n){if(n<0||this.o+n>this.v.byteLength)throw Error('VMDが途中で切れているか、データ件数が不正です。');}
 u8(){this.need(1);return this.v.getUint8(this.o++);}
 u32(){this.need(4);const v=this.v.getUint32(this.o,true);this.o+=4;return v;}
 f(){this.need(4);const v=this.v.getFloat32(this.o,true);this.o+=4;if(!Number.isFinite(v))throw Error('VMDに不正な数値が含まれています。');return v;}
 bytes(n){this.need(n);const a=new Uint8Array(this.v.buffer,this.o,n).slice();this.o+=n;return a;}
 text(n){const a=this.bytes(n),z=a.indexOf(0);return this.decoder.decode(z<0?a:a.subarray(0,z));}
 count(size){const n=this.u32();if(n>1000000||n*size>this.v.byteLength-this.o)throw Error('VMDのデータ件数が不正、または大きすぎます。');return n;}
 remaining(){return this.v.byteLength-this.o;}
}
function organize(map){for(const [name,keys] of map){const unique=new Map(keys.map(k=>[k.frame,k]));map.set(name,[...unique.values()].sort((a,b)=>a.frame-b.frame));}}
function parseVMD(buffer){
 if(buffer.byteLength>64*1024*1024)throw Error('読み込めるVMDは64MBまでです。');
 const r=new Reader(buffer),magic=r.text(30);if(!['Vocaloid Motion Data 0002','Vocaloid Motion Data file'].includes(magic))throw Error('MMDのVMD形式ではありません。ダンス用の .vmd を選んでください。');
 const model=r.text(magic.endsWith('0002')?20:10),bones=new Map(),morphs=new Map(),iks=new Map();let maxFrame=0;
 const insert=(map,name,k)=>{name=canonical(name);if(!map.has(name))map.set(name,[]);map.get(name).push(k);};
 const boneCount=r.count(111);
 for(let i=0;i<boneCount;i++){const name=r.text(15),frame=r.u32(),p=[r.f(),r.f(),-r.f()],q=norm([-r.f(),-r.f(),r.f(),r.f()]),curve=r.bytes(64);insert(bones,name,{frame,p,q,curve});maxFrame=Math.max(maxFrame,frame);}
 const morphCount=r.count(23);
 for(let i=0;i<morphCount;i++){const name=r.text(15),frame=r.u32(),weight=r.f();insert(morphs,name,{frame,weight});maxFrame=Math.max(maxFrame,frame);}
 const skipped={camera:0,light:0,shadow:0,visibility:0};
 for(const [key,size] of [['camera',61],['light',28],['shadow',9]]){if(!r.remaining())break;const n=r.count(size);skipped[key]=n;r.bytes(n*size);}
 if(r.remaining()){const n=r.count(9);skipped.visibility=n;for(let i=0;i<n;i++){const frame=r.u32();r.u8();const count=r.count(21);for(let j=0;j<count;j++)insert(iks,r.text(20),{frame,enabled:r.u8()!==0});}}
 organize(bones);organize(morphs);organize(iks);
 if(!boneCount&&!morphCount)throw Error('人体モーションがありません。カメラ専用VMDは変換できません。');
 if(maxFrame>30*60*20)throw Error('対応するモーションの長さは20分までです。');
 return {model,bones,morphs,iks,maxFrame,boneCount,morphCount,skipped,trailing:r.remaining()};
}
function bracket(keys,f){let lo=0,hi=keys.length-1;if(f<=keys[0].frame)return [keys[0],keys[0],0];if(f>=keys[hi].frame)return [keys[hi],keys[hi],0];while(lo+1<hi){const m=(lo+hi)>>1;if(keys[m].frame<=f)lo=m;else hi=m;}return [keys[lo],keys[hi],(f-keys[lo].frame)/(keys[hi].frame-keys[lo].frame)];}
function bezier(t,c,k){const x1=clamp(c[k]/127,0,1),y1=clamp(c[k+4]/127,0,1),x2=clamp(c[k+8]/127,0,1),y2=clamp(c[k+12]/127,0,1);if(x1===y1&&x2===y2)return t;const cubic=(u,a,b)=>3*(1-u)*(1-u)*u*a+3*(1-u)*u*u*b+u*u*u;let lo=0,hi=1,u=t;for(let i=0;i<18;i++){if(cubic(u,x1,x2)<t)lo=u;else hi=u;u=(lo+hi)/2;}return cubic(u,y1,y2);}
function sample(keys,f){if(!keys?.length)return {p:Z,q:I};const [a,b,t]=bracket(keys,f);if(a===b)return a;return {p:a.p.map((v,k)=>v+(b.p[k]-v)*bezier(t,b.curve,k)),q:slerp(a.q,b.q,bezier(t,b.curve,3))};}
function weight(keys,f){if(!keys?.length)return 0;const [a,b,t]=bracket(keys,f);return clamp(a.weight+(b.weight-a.weight)*t,0,1);}
function ikOn(keys,f){if(!keys?.length||f<keys[0].frame)return true;let lo=0,hi=keys.length;while(lo+1<hi){const m=(lo+hi)>>1;if(keys[m].frame<=f)lo=m;else hi=m;}return keys[lo].enabled;}
const MORPHS={aa:['あ'],ih:['い'],ou:['う'],ee:['え'],oh:['お'],blink:['まばたき'],blinkLeft:['ウィンク','ウィンク2','ウィンク左'],blinkRight:['ウィンク右','ウィンク2右'],happy:['笑い','にこり'],angry:['怒り'],sad:['悲しい'],relaxed:['なごみ'],surprised:['びっくり']};
function makeRig(angle=35){
 const src=[],nodes=[],humanBones={},binding=[],byName=new Map();
 function source(name,parent,p){const n=src.length;src.push({name,parent,p});byName.set(name,n);return n;}
 function target(name,parent,p,s,c=I){const n=nodes.length;nodes.push({name,translation:p});if(parent>=0)(nodes[parent].children??=[]).push(n);humanBones[name]={node:n};binding.push({s,c,parent});return n;}
 const root=source('全ての親',-1,Z),center=source('センター',root,[0,1,0]),groove=source('グルーブ',center,Z),waist=source('腰',groove,Z),lower=source('下半身',waist,Z),upper=source('上半身',waist,[0,.12,0]),upper2=source('上半身2',upper,[0,.15,0]);
 const hips=target('hips',-1,[0,1,0],lower),spine=target('spine',hips,[0,.12,0],upper),chest=target('chest',spine,[0,.15,0],upper2),neckS=source('首',upper2,[0,.18,0]),neck=target('neck',chest,[0,.18,0],neckS),headS=source('頭',neckS,[0,.08,0]);target('head',neck,[0,.08,0],headS);
 const legs=[];
 for(const [jp,en,sign] of [['左','left',1],['右','right',-1]]){
  const c=axis([0,0,1],-sign*angle*Math.PI/180);
  const shoulderS=source(jp+'肩',upper2,[sign*.07,.12,0]),shoulder=target(en+'Shoulder',chest,[sign*.07,.12,0],shoulderS);
  const armS=source(jp+'腕',shoulderS,[sign*.1,0,0]),arm=target(en+'UpperArm',shoulder,[sign*.1,0,0],armS,c);
  const twistS=source(jp+'腕捩',armS,Z),elbowS=source(jp+'ひじ',twistS,rotate(c,[sign*.27,0,0])),elbow=target(en+'LowerArm',arm,[sign*.27,0,0],elbowS,c);
  const handTwist=source(jp+'手捩',elbowS,Z),handS=source(jp+'手首',handTwist,rotate(c,[sign*.24,0,0])),hand=target(en+'Hand',elbow,[sign*.24,0,0],handS,c);
  for(const [finger,label,depth] of [['親指','Thumb',.035],['人指','Index',.023],['中指','Middle',0],['薬指','Ring',-.023],['小指','Little',-.045]]){
   let ps=handS,pt=hand;const parts=label==='Thumb'?['Metacarpal','Proximal','Distal']:['Proximal','Intermediate','Distal'];
   for(let j=0;j<3;j++){const p=j===0?[sign*(label==='Thumb'?.025:.075),0,depth]:[sign*.03,0,label==='Thumb'?.03:0];const s=source(jp+finger+(label==='Thumb'?j:j+1),ps,rotate(c,p));const t=target(en+label+parts[j],pt,p,s,c);ps=s;pt=t;}
  }
  const thighS=source(jp+'足',lower,[sign*.09,-.05,0]),thigh=target(en+'UpperLeg',hips,[sign*.09,-.05,0],thighS),kneeS=source(jp+'ひざ',thighS,[0,-.43,0]),knee=target(en+'LowerLeg',thigh,[0,-.43,0],kneeS),footS=source(jp+'足首',kneeS,[0,-.44,0]),foot=target(en+'Foot',knee,[0,-.44,0],footS),toeS=source(jp+'つま先',footS,[0,-.03,.12]);target(en+'Toes',foot,[0,-.03,.12],toeS);
  const ikParent=source(jp+'足IK親',root,[sign*.09,0,0]),controller=source(jp+'足IK',ikParent,[0,.08,0]);
  legs.push({jp,thighS,kneeS,footS,controller});
 }
 return {src,nodes,humanBones,binding,byName,legs,root};
}
function pose(rig,vmd,frame,options){
 const {src,binding}=rig,p=[],q=[];const local=[];
 for(let i=0;i<src.length;i++){const b=src[i],s=sample(vmd.bones.get(b.name),frame);local[i]=s.q;const t=add(b.p,mul(s.p,options.scale));p[i]=b.parent<0?t:add(p[b.parent],rotate(q[b.parent],t));q[i]=b.parent<0?s.q:qm(q[b.parent],s.q);}
 let unreachable=0;
 if(options.ik)for(const leg of rig.legs){const {jp,thighS:a,kneeS:b,footS:c,controller}=leg;if(!vmd.bones.has(jp+'足IK')||!ikOn(vmd.iks.get(jp+'足IK'),frame))continue;
  const target=p[controller],delta=sub(target,p[a]),raw=length(delta),dist=clamp(raw,.010001,.869999),dir=raw>1e-7?unit(delta):[0,-1,0];if(raw>.871)unreachable++;
  let forward=rotate(q[a],[0,0,1]);let bend=sub(forward,mul(dir,dot(forward,dir)));if(length(bend)<1e-5){forward=rotate(q[rig.root],[1,0,0]);bend=sub(forward,mul(dir,dot(forward,dir)));}bend=unit(bend);
  const along=(.43*.43-.44*.44+dist*dist)/(2*dist),height=Math.sqrt(Math.max(0,.43*.43-along*along));const knee=add(p[a],add(mul(dir,along),mul(bend,height))),ankle=add(p[a],mul(dir,dist));
  const old=q[a];q[a]=qm(between(rotate(old,[0,-1,0]),sub(knee,p[a])),old);
  q[b]=qm(between(rotate(q[a],[0,-1,0]),sub(ankle,knee)),q[a]);p[b]=knee;p[c]=ankle;q[c]=q[controller];
  for(let j=c+1;j<src.length;j++)if(src[j].parent===c){p[j]=add(p[c],rotate(q[c],src[j].p));q[j]=qm(q[c],local[j]);}
 }
 const world=binding.map(b=>norm(qm(q[b.s],b.c))),rotations=binding.map((b,i)=>b.parent<0?world[i]:norm(qm(inv(world[b.parent]),world[i])));
 return {rotations,hips:p[binding[0].s],unreachable};
}
function evaluate(rig,rotations,hips){const p=[],q=[];for(let i=0;i<rig.nodes.length;i++){const parent=rig.binding[i].parent;q[i]=parent<0?rotations[i]:qm(q[parent],rotations[i]);p[i]=parent<0?hips:add(p[parent],rotate(q[parent],rig.nodes[i].translation));}return {p,q};}
function convert(vmd,opts={},onProgress=()=>{}){
 const options={fps:30,scale:.08,armAngle:35,ik:true,expressions:true,...opts};
 if(![30,60].includes(options.fps)||!Number.isFinite(options.scale)||options.scale<.001||options.scale>1||!Number.isFinite(options.armAngle)||options.armAngle<0||options.armAngle>70)throw Error('変換設定の値が範囲外です。');
 const rig=makeRig(options.armAngle),recognized=[...vmd.bones.keys()].filter(n=>rig.byName.has(n));
 const exprs=options.expressions?Object.entries(MORPHS).map(([name,aliases])=>({name,keys:aliases.map(a=>vmd.morphs.get(canonical(a))).filter(Boolean)})).filter(e=>e.keys.length):[];
 if(!recognized.length&&!exprs.length)throw Error('対応する人体ボーン・表情が見つかりません。標準の日本語ボーン名を持つダンスVMDが必要です。');
 const count=Math.ceil(vmd.maxFrame*options.fps/30)+1;
 if(count*rig.nodes.length>2400000)throw Error('出力が大きすぎます。30fpsを選ぶか、モーションを短くしてください。');
 const times=new Float32Array(count),tracks=rig.nodes.map(()=>new Float32Array(count*4)),hips=new Float32Array(count*3),expressionTracks=exprs.map(()=>new Float32Array(count*3));let reach=0;
 for(let i=0;i<count;i++){const f=Math.min(vmd.maxFrame,i*30/options.fps);times[i]=f/30;const result=pose(rig,vmd,f,options);hips.set(result.hips,i*3);reach+=result.unreachable;
  for(let j=0;j<tracks.length;j++){let q=result.rotations[j];if(i&&dot(q,tracks[j].subarray((i-1)*4,i*4))<0)q=mul(q,-1);tracks[j].set(q,i*4);}
  exprs.forEach((e,j)=>{expressionTracks[j][i*3]=Math.max(...e.keys.map(k=>weight(k,f)));});if(i%120===0)onProgress(i/count);
 }
 const warnings=['元モデルの骨格を含まないVMDのため、標準体型による近似変換です。元のダンスとの完全一致は保証しません。'];
 const ignored=[...vmd.bones.keys()].filter(n=>!rig.byName.has(n));if(ignored.length)warnings.push('未対応ボーン: '+ignored.join('、'));
 const mappedMorphs=new Set(Object.values(MORPHS).flat().map(canonical)),ignoredMorphs=[...vmd.morphs.keys()].filter(n=>!options.expressions||!mappedMorphs.has(n));if(ignoredMorphs.length)warnings.push('未変換の表情: '+ignoredMorphs.join('、'));
 if(Object.values(vmd.skipped).some(Boolean))warnings.push('カメラ・照明・影・モデル表示切替は出力しません。足IKのON/OFFは反映します。');
 if(reach)warnings.push('足IKの目標が標準脚長の範囲を超えたサンプルがあります。足の位置がずれる場合は移動倍率を調整してください。');
 if(!options.ik&&[...vmd.bones.keys()].some(n=>n.endsWith('足IK')))warnings.push('足IKを無効にしたため、足IKの動きは出力していません。');
 const translated=[...vmd.bones].filter(([n,keys])=>rig.byName.has(n)&&!['全ての親','センター','グルーブ','腰','下半身'].includes(n)&&!n.includes('IK')&&keys.some(k=>length(k.p)>1e-5)).map(([n])=>n);if(translated.length)warnings.push('hips以外の移動はVRMAに保持できません: '+translated.join('、'));
 if(vmd.trailing)warnings.push('末尾の未解釈データ '+vmd.trailing+' バイトは出力していません。');
 const report={model:vmd.model,duration:vmd.maxFrame/30,boneKeys:vmd.boneCount,morphKeys:vmd.morphCount,recognizedBones:recognized,ignoredBones:ignored,ignoredMorphs,samples:count,options,warnings};
 const result={rig,times,tracks,hips,exprs:exprs.map(e=>e.name),expressionTracks,report};result.glb=exportGLB(result);onProgress(1);return result;
}
function exportGLB(result){
 const {rig,times,tracks,hips,exprs,expressionTracks}=result;
 const nodes=structuredClone(rig.nodes),extension={specVersion:'1.0',humanoid:{humanBones:rig.humanBones}},g={asset:{version:'2.0',generator:'VMD to VRMA Local 1.0'},extensionsUsed:['VRMC_vrm_animation'],extensions:{VRMC_vrm_animation:extension},scene:0,scenes:[{nodes:[0]}],nodes,animations:[{name:'VMD Dance',samplers:[],channels:[]}],buffers:[],bufferViews:[],accessors:[]};
 const chunks=[];let byteLength=0;
 function accessor(data,type,bounds=false){const view=g.bufferViews.length;g.bufferViews.push({buffer:0,byteOffset:byteLength,byteLength:data.byteLength});chunks.push(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));byteLength+=data.byteLength;const a={bufferView:view,componentType:5126,count:data.length/({SCALAR:1,VEC3:3,VEC4:4}[type]),type};if(bounds){a.min=[data[0]];a.max=[data[data.length-1]];}g.accessors.push(a);return g.accessors.length-1;}
 const time=accessor(times,'SCALAR',true),anim=g.animations[0];
 function channel(node,path,data,type){const sampler=anim.samplers.length;anim.samplers.push({input:time,output:accessor(data,type),interpolation:'LINEAR'});anim.channels.push({sampler,target:{node,path}});}
 tracks.forEach((data,i)=>channel(i,'rotation',data,'VEC4'));channel(0,'translation',hips,'VEC3');
 if(exprs.length){extension.expressions={preset:{}};exprs.forEach((name,i)=>{const node=nodes.length;nodes.push({name:'expression_'+name});g.scenes[0].nodes.push(node);extension.expressions.preset[name]={node};channel(node,'translation',expressionTracks[i],'VEC3');});}
 g.buffers.push({byteLength});const json=new TextEncoder().encode(JSON.stringify(g)),jsonSize=(json.length+3)&~3,binSize=(byteLength+3)&~3,total=12+8+jsonSize+8+binSize,out=new Uint8Array(total),v=new DataView(out.buffer);
 v.setUint32(0,0x46546c67,true);v.setUint32(4,2,true);v.setUint32(8,total,true);v.setUint32(12,jsonSize,true);v.setUint32(16,0x4e4f534a,true);out.fill(32,20,20+jsonSize);out.set(json,20);v.setUint32(20+jsonSize,binSize,true);v.setUint32(24+jsonSize,0x004e4942,true);let off=28+jsonSize;for(const c of chunks){out.set(c,off);off+=c.length;}return out.buffer;
}
function demo(){const bones=new Map(),curve=new Uint8Array(64);for(let k=0;k<4;k++){curve[k]=20;curve[k+4]=20;curve[k+8]=107;curve[k+12]=107;}
 const addTrack=(name,fn)=>{const keys=[];for(let f=0;f<=180;f+=15)keys.push({frame:f,curve,...fn(f/30)});bones.set(name,keys);};
 addTrack('センター',t=>({p:[Math.sin(t*Math.PI)*.65,Math.sin(t*Math.PI*2)*.18,0],q:axis([0,1,0],Math.sin(t*Math.PI)*.12)}));
 for(const [jp,s] of [['左',1],['右',-1]]){addTrack(jp+'腕',t=>({p:Z,q:axis([0,0,1],s*(.2+.65*Math.sin(t*Math.PI)))}));addTrack(jp+'ひじ',t=>({p:Z,q:axis([0,1,0],s*(.6+.4*Math.sin(t*Math.PI)))}));addTrack(jp+'足IK',t=>({p:[0,Math.max(0,Math.sin(t*Math.PI+s*Math.PI/2))*.9,0],q:I}));}
 return {model:'内蔵テストモーション',bones,morphs:new Map(),iks:new Map(),maxFrame:180,boneCount:[...bones.values()].reduce((n,k)=>n+k.length,0),morphCount:0,skipped:{},trailing:0};
}
const api={parseVMD,convert,exportGLB,makeRig,pose,evaluate,demo,sample,bezier,math:{qm,rotate,axis,between,slerp,dot,length},canonical};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.VMDVRMA=api;
})(typeof globalThis!=='undefined'?globalThis:this);
