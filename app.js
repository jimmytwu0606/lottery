// ── GitHub 自動載入 ────────────────────────────────────
const GITHUB_OWNER  = "jimmytwu0606";
const GITHUB_REPO   = "lottery";
const CSV_FOLDER    = "";  // CSV 放 repo 根目錄；改成 "data" 就是 data/ 子目錄

async function loadFromGitHub(){
  const statusEl = document.getElementById("load-status");
  const btn      = document.getElementById("github-load-btn");
  if(statusEl) statusEl.textContent = "掃描 GitHub 檔案中...";
  if(btn){ btn.disabled = true; btn.textContent = "載入中..."; }

  try {
    const folder  = CSV_FOLDER ? CSV_FOLDER + "/" : "";
    const apiUrl  = "https://api.github.com/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO + "/contents/" + folder;
    const res     = await fetch(apiUrl);
    if(!res.ok) throw new Error("GitHub API 回應 " + res.status);
    const files   = await res.json();
    const csvFiles = files.filter(f => f.name.toLowerCase().endsWith(".csv"));
    if(!csvFiles.length){ if(statusEl) statusEl.textContent = "⚠️ 找不到 CSV 檔案，請先上傳資料"; return; }

    if(statusEl) statusEl.textContent = "找到 " + csvFiles.length + " 個 CSV，下載中...";

    const csvMap = {};
    for(const file of csvFiles){
      const g = detectGame(file.name);
      if(!g) continue;
      if(statusEl) statusEl.textContent = "下載 " + file.name + "...";
      const r       = await fetch(file.download_url);
      const content = await r.text();
      if(!csvMap[g]) csvMap[g] = [];
      csvMap[g].push({name: file.name, content});
    }

    let loaded = 0;
    for(const [game, list] of Object.entries(csvMap)){
      try{
        DB[game] = analyzeCSVs(game, list);
        loaded++;
        const d = document.getElementById("dot-" + game);
        if(d) d.className = "dot ok";
      } catch(e){ console.error(game, e); }
    }

    document.getElementById("upload-zone").style.display = "none";
    const ac = document.getElementById("app-content");
    ac.style.display = "flex"; ac.style.flexDirection = "column"; ac.style.gap = "14px";
    switchGame(Object.keys(DB)[0] || "今彩539");
    const tot = Object.values(DB).reduce((s,d) => s + d.total, 0);
    document.getElementById("status-txt").textContent  = "✓ " + loaded + "種 " + tot.toLocaleString() + "期";
    document.getElementById("status-txt").style.color = "#639922";

  } catch(err){
    console.error(err);
    if(statusEl) statusEl.textContent = "❌ 載入失敗：" + err.message;
    if(btn){ btn.disabled = false; btn.textContent = "⚡ 重試"; }
  }
}


const PRIZES = {
  "今彩539":{odds:575757,formula:"C(39,5)=575,757",tiers:[
    {name:"頭獎",match:"5碼全中",odds:575757,color:"#D85A30"},
    {name:"貳獎",match:"任4碼中",odds:3387,color:"#993C1D"},
    {name:"參獎",match:"任3碼中",odds:103,color:"#E27D4A"}
  ]},
  "威力彩":{odds:22085448,formula:"C(38,6)×8=22,085,448",tiers:[
    {name:"頭獎",match:"6+第二區",odds:22085448,color:"#D85A30"},
    {name:"貳獎",match:"6碼全中",odds:2760681,color:"#993C1D"},
    {name:"參獎",match:"5碼+第二區",odds:115028,color:"#185FA5"},
    {name:"肆獎",match:"5碼全中",odds:14379,color:"#378ADD"},
    {name:"伍獎",match:"4碼+第二區",odds:2968,color:"#3B6D11"},
    {name:"陸獎",match:"3碼+第二區",odds:223,color:"#639922"},
    {name:"柒獎",match:"4碼或2碼+第二區",odds:371,color:"#888780"}
  ]},
  "大樂透":{odds:13983816,formula:"C(49,6)=13,983,816",tiers:[
    {name:"頭獎",match:"6碼全中",odds:13983816,color:"#D85A30"},
    {name:"貳獎",match:"5碼+特別號",odds:2330636,color:"#993C1D"},
    {name:"參獎",match:"5碼全中",odds:54201,color:"#185FA5"},
    {name:"肆獎",match:"4碼+特別號",odds:22197,color:"#378ADD"},
    {name:"伍獎",match:"4碼全中",odds:1032,color:"#3B6D11"},
    {name:"陸獎",match:"3碼+特別號",odds:60,color:"#639922"}
  ]},
  "39樂合彩":{odds:575757,formula:"C(39,5)=575,757",tiers:[
    {name:"5中5",match:"選5全中",odds:575757,color:"#D85A30"},
    {name:"5中4",match:"選5中4",odds:3387,color:"#993C1D"},
    {name:"5中3",match:"選5中3",odds:103,color:"#E27D4A"},
    {name:"4中4",match:"選4全中",odds:82251,color:"#185FA5"},
    {name:"3中3",match:"選3全中",odds:9139,color:"#378ADD"},
    {name:"2中2",match:"選2全中",odds:741,color:"#3B6D11"}
  ]},
  "49樂合彩":{odds:13983816,formula:"C(49,6)=13,983,816",tiers:[
    {name:"6中6",match:"選6全中",odds:13983816,color:"#D85A30"},
    {name:"6中5",match:"選6中5",odds:54201,color:"#993C1D"},
    {name:"5中5",match:"選5全中",odds:1906884,color:"#185FA5"},
    {name:"4中4",match:"選4全中",odds:211876,color:"#378ADD"},
    {name:"3中3",match:"選3全中",odds:18424,color:"#3B6D11"},
    {name:"2中2",match:"選2全中",odds:1176,color:"#639922"}
  ]},
  "3星彩":{odds:1000,formula:"10^3=1,000",tiers:[
    {name:"頭獎",match:"3碼順序完全相符",odds:1000,color:"#D85A30"},
    {name:"貳獎",match:"3碼任意順序",odds:167,color:"#993C1D"},
    {name:"參獎",match:"對子組合",odds:333,color:"#E27D4A"}
  ]},
  "4星彩":{odds:10000,formula:"10^4=10,000",tiers:[
    {name:"頭獎",match:"4碼順序完全相符",odds:10000,color:"#D85A30"},
    {name:"貳獎",match:"4碼任意順序",odds:417,color:"#993C1D"},
    {name:"參獎",match:"3碼順序相符",odds:1000,color:"#E27D4A"}
  ]}
};

const GAME_CFG = {
  "今彩539": {cols:["獎號1","獎號2","獎號3","獎號4","獎號5"],mainRange:39,pick:5,secondRange:0,color:"#D85A30",desc:"39選5，每日一期"},
  "威力彩":  {cols:["獎號1","獎號2","獎號3","獎號4","獎號5","獎號6"],secondCol:"第二區",mainRange:38,pick:6,secondRange:8,color:"#185FA5",desc:"38選6＋第二區"},
  "大樂透":  {cols:["獎號1","獎號2","獎號3","獎號4","獎號5","獎號6"],specialCol:"特別號",mainRange:49,pick:6,secondRange:0,color:"#3B6D11",desc:"49選6＋特別號"},
  "39樂合彩":{cols:["獎號1","獎號2","獎號3","獎號4","獎號5"],mainRange:39,pick:5,secondRange:0,color:"#BA7517",desc:"依今彩539開獎"},
  "49樂合彩":{cols:["獎號1","獎號2","獎號3","獎號4","獎號5","獎號6"],mainRange:49,pick:6,secondRange:0,color:"#534AB7",desc:"依大樂透開獎"},
  "3星彩":   {cols:["獎號1","獎號2","獎號3"],mainRange:10,pick:3,secondRange:0,isDigit:true,color:"#A32D2D",desc:"0~9各選1碼，共3碼"},
  "4星彩":   {cols:["獎號1","獎號2","獎號3","獎號4"],mainRange:10,pick:4,secondRange:0,isDigit:true,color:"#D4537E",desc:"0~9各選1碼，共4碼"}
};

const GAME_KEYWORDS = [
  ["威力彩","威力彩"],["大樂透","大樂透"],["今彩539","今彩539"],
  ["39樂合彩","39樂合彩"],["49樂合彩","49樂合彩"],
  ["3星彩","3星彩"],["4星彩","4星彩"]
];

const STRATS = [
  {id:"hot",  label:"🔥 熱號派",   sub:"出現頻率最高"},
  {id:"cold", label:"❄️ 冷號派",   sub:"最久沒出現"},
  {id:"bal",  label:"⚖️ 平衡派",   sub:"熱冷各半"},
  {id:"rise", label:"📈 竄升派",   sub:"近50期暴增"},
  {id:"ai",   label:"🤖 AI加權派", sub:"頻率+共現加權"},
  {id:"rnd",  label:"🎲 隨機派",   sub:"純隨機機選"}
];

let DB = {}, currentGame = null, currentStrat = "hot", selectedNum = null;
let patternFilter = "all", patternSort = "default";
let genCount = 1; // 1 或 10
let genHistory = {};
let patternDistCache = {};

function gc(g){ return (DB[g]||GAME_CFG[g]||{color:"#D85A30"}).color||"#D85A30"; }

// ── 全頁面拖曳 ─────────────────────────────────────────
document.addEventListener("dragover", function(e){ e.preventDefault(); document.body.classList.add("dragging"); });
document.addEventListener("dragleave", function(e){ if(!e.relatedTarget) document.body.classList.remove("dragging"); });
document.addEventListener("drop", function(e){ e.preventDefault(); document.body.classList.remove("dragging"); handleFiles(e.dataTransfer.files); });

// ── 檔案處理 ───────────────────────────────────────────
async function handleFiles(files){
  if(!files||!files.length) return;
  document.getElementById("upload-zone").style.display="none";
  document.getElementById("progress-area").style.display="block";
  document.getElementById("app-content").style.display="none";
  const pl=document.getElementById("prog-list"); pl.innerHTML="";
  const csvMap={};

  for(const file of files){
    const item=document.createElement("div"); item.className="prog-item";
    item.innerHTML='<span class="prog-icon">⏳</span><span class="prog-name">'+file.name+'</span><span class="prog-status">處理中...</span>';
    pl.appendChild(item);
    const sEl=item.querySelector(".prog-status"), iEl=item.querySelector(".prog-icon");
    try{
      const fname=file.name.toLowerCase();
      if(fname.endsWith(".zip")){
        const zip=await JSZip.loadAsync(file); let cnt=0;
        for(const [name,entry] of Object.entries(zip.files)){
          if(name.toLowerCase().endsWith(".csv")&&!entry.dir){
            const content=await entry.async("string");
            const g=detectGame(name);
            if(g){if(!csvMap[g])csvMap[g]=[];csvMap[g].push({name,content});cnt++;}
          }
        }
        iEl.textContent="✅"; sEl.textContent="解壓 "+cnt+" 個CSV";
      } else if(fname.endsWith(".csv")){
        const content=await file.text(); const g=detectGame(file.name);
        if(g){if(!csvMap[g])csvMap[g]=[];csvMap[g].push({name:file.name,content});iEl.textContent="✅";sEl.textContent="已讀取";}
        else{iEl.textContent="⚠️";sEl.textContent="無法識別";}
      }
    }catch(err){iEl.textContent="❌";sEl.textContent="錯誤";console.error(file.name,err);}
  }

  let loaded=0;
  for(const [game,list] of Object.entries(csvMap)){
    try{DB[game]=analyzeCSVs(game,list);loaded++;const d=document.getElementById("dot-"+game);if(d)d.className="dot ok";}
    catch(e){console.error(game,e);}
  }
  await new Promise(r=>setTimeout(r,400));
  document.getElementById("progress-area").style.display="none";
  const ac=document.getElementById("app-content");
  ac.style.display="flex"; ac.style.flexDirection="column"; ac.style.gap="14px";
  const first=Object.keys(DB)[0]||"今彩539"; switchGame(first);
  const tot=Object.values(DB).reduce((s,d)=>s+d.total,0);
  document.getElementById("status-txt").textContent="✓ "+loaded+"種 "+tot.toLocaleString()+"期";
  document.getElementById("status-txt").style.color="#639922";
}

function detectGame(filename){
  let name=filename;
  const si=Math.max(name.lastIndexOf("/"),name.lastIndexOf("\\"));
  if(si>=0) name=name.substring(si+1);
  const di=name.lastIndexOf(".");
  if(di>0) name=name.substring(0,di);
  for(const [key,gname] of GAME_KEYWORDS) if(name.indexOf(key)>=0) return gname;
  return null;
}

// ── CSV 解析與分析 ─────────────────────────────────────
function parseCSV(content){
  const hasCR=content.indexOf("\r\n")>=0;
  const lines=content.trim().split(hasCR?"\r\n":"\n");
  if(lines.length<2) return [];
  const raw0=lines[0];
  const bom=raw0.charCodeAt(0)===0xFEFF?raw0.substring(1):raw0;
  const headers=bom.split(",").map(h=>h.trim());
  return lines.slice(1).map(line=>{
    const vals=line.split(","); const row={};
    headers.forEach((h,j)=>{row[h]=(vals[j]||"").trim();}); return row;
  });
}

function analyzeCSVs(game,csvList){
  const cfg=GAME_CFG[game];
  const allRows=[]; csvList.forEach(function(item){allRows.push.apply(allRows,parseCSV(item.content));});
  const seen=new Set();
  const rows=allRows.filter(r=>{const k=r["期別"];if(!k||seen.has(k))return false;seen.add(k);return true;});
  rows.sort((a,b)=>(a["期別"]||"").localeCompare(b["期別"]||""));
  const draws=rows.map(r=>cfg.cols.map(c=>parseInt(r[c])||0));
  const total=draws.length;
  const freq={},recentFreq={},pairFreq={},secondFreq={};
  const w20=draws.slice(-20),w50=draws.slice(-50),w100=draws.slice(-100);
  const appearIdx={};

  for(let i=0;i<draws.length;i++){
    const nums=draws[i];
    for(const n of nums){
      freq[n]=(freq[n]||0)+1;
      if(!appearIdx[n])appearIdx[n]=[];
      appearIdx[n].push(i);
    }
    if(!cfg.isDigit){
      const s=nums.slice().sort((a,b)=>a-b);
      for(let x=0;x<s.length;x++) for(let y=x+1;y<s.length;y++){const k=s[x]+","+s[y];pairFreq[k]=(pairFreq[k]||0)+1;}
    }
    if(cfg.secondCol){const sv=parseInt(rows[i][cfg.secondCol]);if(!isNaN(sv))secondFreq[sv]=(secondFreq[sv]||0)+1;}
  }
  for(const nums of draws.slice(-50)) for(const n of nums) recentFreq[n]=(recentFreq[n]||0)+1;

  const topPairs=Object.entries(pairFreq).map(([k,v])=>{const ab=k.split(",");return{a:parseInt(ab[0]),b:parseInt(ab[1]),count:v};}).sort((x,y)=>y.count-x.count);
  const allNums=cfg.isDigit?Array.from({length:cfg.mainRange},(_,i)=>i):Array.from({length:cfg.mainRange},(_,i)=>i+1);
  const intervals={},streaks={},trend={};
  const fRate=(arr,n)=>arr.length?arr.filter(nums=>nums.indexOf(n)>=0).length/arr.length:0;

  for(const n of allNums){
    const idxs=appearIdx[n]||[];
    if(idxs.length>=2){
      const gaps=idxs.slice(1).map((v,i)=>v-idxs[i]);
      const avg=gaps.reduce((s,x)=>s+x,0)/gaps.length;
      const std=Math.sqrt(gaps.map(g=>(g-avg)*(g-avg)).reduce((s,x)=>s+x,0)/gaps.length);
      intervals[n]={avg:Math.round(avg*10)/10,min:Math.min.apply(null,gaps),max:Math.max.apply(null,gaps),std:Math.round(std*10)/10,lastGap:total-1-idxs[idxs.length-1]};
    } else {
      intervals[n]={avg:0,min:0,max:0,std:0,lastGap:idxs.length?total-1-idxs[0]:total};
    }
    let maxHit=0,maxMiss=0,curH=0,curM=0;
    for(const nums of draws){if(nums.indexOf(n)>=0){curH++;curM=0;}else{curM++;curH=0;}if(curH>maxHit)maxHit=curH;if(curM>maxMiss)maxMiss=curM;}
    let curStreak=0,curType=null;
    for(let i=draws.length-1;i>=0;i--){const has=draws[i].indexOf(n)>=0;if(curType===null)curType=has?"hit":"miss";if(has&&curType==="hit")curStreak++;else if(!has&&curType==="miss")curStreak++;else break;}
    streaks[n]={maxHit,maxMiss,curType,curStreak};
    const rAll=fRate(draws,n),r100=fRate(w100,n),r50=fRate(w50,n),r20=fRate(w20,n);
    const score=rAll?Math.round((r20-rAll)/rAll*100):0;
    const state=score>=30?"🔥急速升溫":score>=10?"📈升溫":score<=-30?"❄️急速降溫":score<=-10?"📉降溫":"➡️平穩";
    trend[n]={rAll:Math.round(rAll*1000)/10,r100:Math.round(r100*1000)/10,r50:Math.round(r50*1000)/10,r20:Math.round(r20*1000)/10,score,state};
  }

  const mid=Math.floor(total/2);
  const pf1={},pf2={};
  for(const nums of draws.slice(0,mid)){const s=nums.slice().sort((a,b)=>a-b);for(let i=0;i<s.length;i++)for(let j=i+1;j<s.length;j++){const k=s[i]+","+s[j];pf1[k]=(pf1[k]||0)+1;}}
  for(const nums of draws.slice(mid)){const s=nums.slice().sort((a,b)=>a-b);for(let i=0;i<s.length;i++)for(let j=i+1;j<s.length;j++){const k=s[i]+","+s[j];pf2[k]=(pf2[k]||0)+1;}}
  const allPairKeys=new Set(Object.keys(pf1).concat(Object.keys(pf2)));
  const pairChanges=[];
  for(const k of allPairKeys){
    const ab=k.split(",");const a=parseInt(ab[0]),b=parseInt(ab[1]);
    const both=(pf1[k]||0)+(pf2[k]||0);if(both<3)continue;
    const f1=(pf1[k]||0)/mid*100,f2=(pf2[k]||0)/(total-mid)*100;
    const change=f1>0?Math.round((f2-f1)/f1*100):200;
    pairChanges.push({a,b,f1:Math.round(f1*100)/100,f2:Math.round(f2*100)/100,change,both});
  }
  pairChanges.sort((x,y)=>y.change-x.change);

  return{total,mainRange:cfg.mainRange,pick:cfg.pick,secondRange:cfg.secondRange||0,
    isDigit:cfg.isDigit||false,color:cfg.color,desc:cfg.desc,
    freq,recentFreq,secondFreq,pairFreq,topPairs:topPairs.slice(0,20),
    intervals,streaks,trend,pairChanges,allNums};
}

// ── 歷史規律指數 ───────────────────────────────────────
function calcNumScore(n,db){
  const iv=db.intervals[n]||{avg:0,std:1,lastGap:0};
  const freq=db.freq[n]||0,rfreq=db.recentFreq[n]||0;
  const total=db.total,pick=db.pick,range=db.mainRange;
  const avgFreq=total*pick/range;
  const avg20=Math.min(20,total)*pick/range;
  const avg=iv.avg||(range/pick);
  const std=iv.std||Math.max(avg*0.3,1);
  const lastGap=iv.lastGap!==undefined?iv.lastGap:total;
  const z=(lastGap-avg)/std;
  const overdue=Math.min(100,Math.max(0,50+z*15));
  const rAll=avgFreq>0?freq/avgFreq:0;
  const r20=avg20>0?rfreq/avg20:0;
  const heat=Math.min(100,Math.max(0,rAll>0?r20/rAll*50:30));
  const base=Math.min(100,rAll*60);
  return overdue*0.5+heat*0.3+base*0.2;
}

function calcComboPatternScore(nums,db){
  const ns=nums.map(n=>calcNumScore(n,db));
  const avgNs=ns.reduce((s,v)=>s+v,0)/ns.length;
  const pm=db.pairFreq||{};
  const mx=Math.max.apply(null,Object.values(pm).map(Number).concat([1]));
  let co=0,cnt=0;
  for(let i=0;i<nums.length;i++)for(let j=i+1;j<nums.length;j++){
    const k=Math.min(nums[i],nums[j])+","+Math.max(nums[i],nums[j]);
    co+=pm[k]||0;cnt++;
  }
  const coScore=cnt?co/(mx*cnt)*100:0;
  return Math.round((avgNs*0.7+coScore*0.3)*10)/10;
}

function buildPatternDist(game){
  const db=DB[game];
  if(!db||db.isDigit) return [];
  const all=db.allNums||Array.from({length:db.mainRange},(_,i)=>i+1);
  const k=db.pick,SAMPLES=2000;
  const scores=[];
  for(let i=0;i<SAMPLES;i++){
    const arr=all.slice();
    for(let j=arr.length-1;j>arr.length-k-1;j--){const r=Math.floor(Math.random()*(j+1));const tmp=arr[j];arr[j]=arr[r];arr[r]=tmp;}
    scores.push(calcComboPatternScore(arr.slice(arr.length-k).sort((a,b)=>a-b),db));
  }
  return scores.sort((a,b)=>a-b);
}

function getPercentile(score,dist){
  if(!dist||!dist.length) return 50;
  let lo=0,hi=dist.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(dist[mid]<=score)lo=mid+1;else hi=mid;}
  return Math.round(lo/dist.length*100);
}

function patternRating(pct){
  const top=100-pct;
  if(pct>=95)return{label:"極強 Top "+top+"%",detail:"規律指數贏過 "+pct+"% 的隨機組合",color:"#D85A30",bg:"#FAECE7"};
  if(pct>=80)return{label:"偏強 Top "+top+"%",detail:"規律指數贏過 "+pct+"% 的隨機組合",color:"#BA7517",bg:"#FAEEDA"};
  if(pct>=50)return{label:"中等 Top "+top+"%",detail:"規律指數贏過 "+pct+"% 的隨機組合",color:"#3B6D11",bg:"#EAF3DE"};
  if(pct>=20)return{label:"偏弱 Top "+top+"%",detail:"規律指數贏過 "+pct+"% 的隨機組合",color:"#185FA5",bg:"#E6F1FB"};
  return          {label:"較低 Top "+top+"%",detail:"規律指數贏過 "+pct+"% 的隨機組合",color:"#888780",bg:"#EDECEA"};
}

// ── UI ─────────────────────────────────────────────────
function switchGame(g){
  if(!DB[g]){alert(g+" 尚未載入資料");return;}
  currentGame=g;selectedNum=null;
  document.querySelectorAll(".game-btn").forEach(b=>{
    const isActive=b.textContent.replace(/\s/g,"").indexOf(g.replace(/\s/g,""))>=0;
    b.classList.toggle("active",isActive);
    b.style.borderLeftColor=isActive?gc(g):"transparent";
  });
  document.getElementById("main-title").textContent=g+" 選號分析";
  document.getElementById("main-title").style.color=gc(g);
  document.getElementById("game-desc").textContent=DB[g].desc||"";
  document.getElementById("gen-btn").style.background=gc(g);
  renderCards();renderStrats();renderCountBtns();renderFreq();renderPairs();
  renderPattern(patternFilter);renderPairChange();renderFullOdds();
  clearResult();renderHistory();
}

function switchTab(t,el){
  document.querySelectorAll(".tab-pane").forEach(p=>p.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b=>{b.classList.remove("active");b.style.borderBottomColor="transparent";b.style.color="#888";});
  document.getElementById("tab-"+t).classList.add("active");
  el.classList.add("active");el.style.borderBottomColor=gc(currentGame);el.style.color="#2C2C2A";
}

function renderCards(){
  const db=DB[currentGame],p=PRIZES[currentGame];
  const nums=Object.keys(db.freq).map(Number);
  const hot=nums.reduce((a,b)=>db.freq[a]>=db.freq[b]?a:b);
  const cold=nums.reduce((a,b)=>db.freq[a]<=db.freq[b]?a:b);
  document.getElementById("c-total").textContent=db.total.toLocaleString();
  const hEl=document.getElementById("c-hot");hEl.textContent=hot+"號";hEl.style.color=gc(currentGame);
  const cEl=document.getElementById("c-cold");cEl.textContent=cold+"號";cEl.style.color="#378ADD";
  const jEl=document.getElementById("c-jack");jEl.textContent="1/"+p.odds.toLocaleString();jEl.style.color=gc(currentGame);
}

function renderStrats(){
  const g=document.getElementById("strat-grid");g.innerHTML="";
  STRATS.forEach(s=>{
    const btn=document.createElement("button");btn.className="strat-btn"+(s.id===currentStrat?" active":"");
    if(s.id===currentStrat){btn.style.borderColor=gc(currentGame);btn.style.color=gc(currentGame);}
    btn.innerHTML="<div>"+s.label+"</div><div class='strat-sub'>"+s.sub+"</div>";
    btn.onclick=function(){currentStrat=s.id;renderStrats();};
    g.appendChild(btn);
  });
}

// 產生組數按鈕
function renderCountBtns(){
  const wrap=document.getElementById("count-btn-wrap");if(!wrap)return;
  [1,10].forEach(n=>{
    const btn=wrap.querySelector('[data-count="'+n+'"]');
    if(!btn)return;
    btn.style.background=genCount===n?gc(currentGame):"transparent";
    btn.style.color=genCount===n?"#fff":"#888";
    btn.style.borderColor=genCount===n?gc(currentGame):"#ddd";
  });
}

function setGenCount(n){genCount=n;renderCountBtns();}

function renderFreq(){
  const db=DB[currentGame],isDigit=db.isDigit;
  const nums=isDigit?Array.from({length:db.mainRange},(_,i)=>i):Array.from({length:db.mainRange},(_,i)=>i+1);
  const vals=nums.map(n=>db.freq[n]||0);
  const mx=Math.max.apply(null,vals),mn=Math.min.apply(null,vals);
  const g=document.getElementById("freq-grid");g.innerHTML="";
  g.style.gridTemplateColumns="repeat("+(db.mainRange<=10?10:db.mainRange<=39?13:10)+",1fr)";
  document.getElementById("freq-title").textContent=isDigit?"各位數出現次數":"號碼出現次數（橘=熱 藍=冷）";
  nums.forEach(n=>{
    const v=db.freq[n]||0,ratio=mx>mn?(v-mn)/(mx-mn):0.5;
    let bg,color;
    if(v>=mx-Math.round((mx-mn)*0.15)){bg="#FAECE7";color="#993C1D";}
    else if(v<=mn+Math.round((mx-mn)*0.15)){bg="#E6F1FB";color="#185FA5";}
    else{const r=Math.round(228-ratio*38);bg="rgb("+r+","+r+","+(r-4)+")";color="#444";}
    const cell=document.createElement("div");cell.className="freq-cell";
    cell.style.background=bg;cell.style.color=color;cell.title=n+"："+v+"次";
    cell.innerHTML="<div class='freq-num'>"+n+"</div><div>"+v+"</div>";
    g.appendChild(cell);
  });
  const sec=document.getElementById("second-section"),secRow=document.getElementById("second-row");
  if(db.secondRange&&Object.keys(db.secondFreq||{}).length){
    sec.style.display="";secRow.innerHTML="";
    const sv=Array.from({length:db.secondRange},(_,i)=>db.secondFreq[i+1]||0);
    const smx=Math.max.apply(null,sv);
    sv.forEach((v,i)=>{
      const c=document.createElement("div");c.className="second-cell";
      c.style.background="rgba(55,138,221,"+(0.12+v/smx*0.6)+")";c.style.color="#0C447C";
      c.title="第二區"+(i+1)+"號："+v+"次";
      c.innerHTML="<div style='font-size:9px;opacity:.65'>"+(i+1)+"號</div><div>"+v+"</div>";
      secRow.appendChild(c);
    });
  } else sec.style.display="none";
  document.getElementById("history-note").textContent="共 "+db.total.toLocaleString()+" 期歷史資料";
}

function renderPairs(){
  const db=DB[currentGame],cont=document.getElementById("pairs-content");cont.innerHTML="";
  if(db.isDigit){cont.innerHTML="<div style='color:#888;font-size:13px;padding:20px 0'>數字型彩券不適用配對分析</div>";return;}
  if(!db.topPairs||!db.topPairs.length){cont.innerHTML="<div style='color:#888;font-size:13px;padding:20px 0'>無配對資料</div>";return;}
  const title=document.createElement("div");title.className="sec-title";title.textContent="Top 20 兩號同時出現次數";
  const list=document.createElement("div");list.className="rank-list";
  const mx=db.topPairs[0].count;
  db.topPairs.forEach((p,i)=>{
    const row=document.createElement("div");row.className="rank-row";
    row.innerHTML="<span class='rank-n'>"+(i+1)+"</span><span class='mini-ball' style='background:"+gc(currentGame)+"'>"+p.a+"</span><span class='mini-ball' style='background:"+gc(currentGame)+"'>"+p.b+"</span><div class='bar-wrap'><div class='bar-fill' style='width:"+(p.count/mx*100)+"%%;background:"+gc(currentGame)+"'></div></div><span class='cnt-lbl'>"+p.count+"次 "+(p.count/db.total*100).toFixed(1)+"%</span>";
    list.appendChild(row);
  });
  cont.appendChild(title);cont.appendChild(list);
}

// ── 號碼規律（含排序） ──────────────────────────────────
function renderPattern(filter){
  patternFilter=filter;
  const db=DB[currentGame];
  if(db.isDigit){document.getElementById("pattern-grid").innerHTML="<div style='color:#888;font-size:13px;padding:20px 0'>數字型彩券不適用規律分析</div>";return;}
  const freq=db.freq,total=db.total;
  const avgFreq=Object.values(freq).reduce((s,v)=>s+v,0)/(db.allNums||[]).length;
  const grid=document.getElementById("pattern-grid");grid.innerHTML="";
  document.getElementById("pattern-detail").style.display="none";selectedNum=null;

  let nums=(db.allNums||[]).filter(n=>{
    const t=db.trend[n];if(!t)return true;
    if(filter==="hot")return freq[n]>=avgFreq*1.1;
    if(filter==="cold")return freq[n]<avgFreq*0.9;
    if(filter==="rising")return t.score>=10;
    if(filter==="cooling")return t.score<=-10;
    return true;
  });
  nums=sortNums(nums,db);

  nums.forEach(n=>{
    const iv=db.intervals[n]||{},st=db.streaks[n]||{},tr=db.trend[n]||{};
    const card=document.createElement("div");card.className="pattern-card";
    const isHot=freq[n]>=avgFreq*1.1,isCold=freq[n]<avgFreq*0.9;
    const ballBg=isHot?gc(currentGame):isCold?"#378ADD":"#888780";
    const stateColor=tr.score>=30?"#D85A30":tr.score>=10?"#BA7517":tr.score<=-30?"#185FA5":tr.score<=-10?"#5F5E5A":"#888";
    const curStr=st.curType==="hit"?"🟢 連續出現 "+st.curStreak+" 期":"⚫ 連續缺席 "+st.curStreak+" 期";
    const overdue=(iv.lastGap||0)>=(iv.avg||999)*1.5;
    const tBars=["全","百","50","20"].map((lbl,i)=>{
      const vals=[tr.rAll,tr.r100,tr.r50,tr.r20];
      const v=vals[i]||0,mx2=Math.max.apply(null,vals.filter(Boolean).concat([1]));
      const h=Math.max(3,Math.round(v/mx2*22));
      const c=i===3?(tr.score>=10?"#D85A30":tr.score<=-10?"#378ADD":"#aaa"):"#ddd";
      return "<div style='flex:1;display:flex;flex-direction:column;align-items:center;gap:2px'><div style='width:100%;height:"+h+"px;border-radius:2px 2px 0 0;background:"+c+"'></div><div style='font-size:8px;color:#aaa'>"+lbl+"</div></div>";
    }).join("");
    card.innerHTML=
      "<div class='pc-header'>"+
        "<div class='pc-ball' style='background:"+ballBg+"'>"+n+"</div>"+
        "<div><div style='font-size:14px;font-weight:700'>號碼 "+n+"</div><div style='font-size:10px;color:#888'>共出現 "+(freq[n]||0)+" 次</div></div>"+
        "<div class='pc-state' style='color:"+stateColor+"'>"+tr.state+"</div>"+
      "</div>"+
      "<div class='pc-rows'>"+
        "<div class='pc-row'><span class='pc-label'>平均間隔</span><span class='pc-val'>"+(iv.avg||0)+" 期</span></div>"+
        "<div class='pc-row'><span class='pc-label'>最長缺席</span><span class='pc-val'>"+(iv.max||0)+" 期</span></div>"+
        "<div class='pc-row'><span class='pc-label'>距今已隔</span><span class='pc-val' style='color:"+(overdue?"#D85A30":"inherit")+";font-weight:"+(overdue?"700":"600")+"'>"+(iv.lastGap||0)+" 期"+(overdue?" ⚠️":"")+"</span></div>"+
        "<div class='pc-row'><span class='pc-label'>現況</span><span class='pc-val' style='font-size:10px'>"+curStr+"</span></div>"+
      "</div>"+
      "<div style='display:flex;gap:2px;align-items:flex-end;height:28px;margin-top:8px'>"+tBars+"</div>";
    card.onclick=function(){showNumDetail(n,card);};
    grid.appendChild(card);
  });
}

function sortNums(nums,db){
  const freq=db.freq,iv=db.intervals,st=db.streaks,tr=db.trend;
  switch(patternSort){
    case "freq_desc":    return nums.slice().sort((a,b)=>(freq[b]||0)-(freq[a]||0));
    case "freq_asc":     return nums.slice().sort((a,b)=>(freq[a]||0)-(freq[b]||0));
    case "interval":     return nums.slice().sort((a,b)=>(iv[b]&&iv[b].avg||0)-(iv[a]&&iv[a].avg||0));
    case "lastgap_desc": return nums.slice().sort((a,b)=>(iv[b]&&iv[b].lastGap||0)-(iv[a]&&iv[a].lastGap||0));
    case "lastgap_asc":  return nums.slice().sort((a,b)=>(iv[a]&&iv[a].lastGap||0)-(iv[b]&&iv[b].lastGap||0));
    case "miss_desc":    return nums.slice().sort((a,b)=>(iv[b]&&iv[b].max||0)-(iv[a]&&iv[a].max||0));
    case "trend_desc":   return nums.slice().sort((a,b)=>(tr[b]&&tr[b].score||0)-(tr[a]&&tr[a].score||0));
    case "trend_asc":    return nums.slice().sort((a,b)=>(tr[a]&&tr[a].score||0)-(tr[b]&&tr[b].score||0));
    case "streak_miss":  return nums.slice().sort((a,b)=>(st[b]&&st[b].maxMiss||0)-(st[a]&&st[a].maxMiss||0));
    default: return nums;
  }
}

function setSort(val){
  patternSort=val;
  document.querySelectorAll(".sort-opt").forEach(b=>{
    const active=b.dataset.sort===val;
    b.classList.toggle("active",active);
    b.style.background=active?gc(currentGame)+"20":"";
    b.style.color=active?gc(currentGame):"";
    b.style.borderColor=active?gc(currentGame):"";
  });
  renderPattern(patternFilter);
}

function showNumDetail(n,card){
  const db=DB[currentGame];
  const iv=db.intervals[n]||{},st=db.streaks[n]||{},tr=db.trend[n]||{};
  const detail=document.getElementById("pattern-detail");
  if(selectedNum===n){detail.style.display="none";card.classList.remove("selected");card.style.borderColor="#e8e7e4";card.style.borderWidth="1px";selectedNum=null;return;}
  document.querySelectorAll(".pattern-card").forEach(c=>{c.classList.remove("selected");c.style.borderColor="#e8e7e4";c.style.borderWidth="1px";});
  card.classList.add("selected");card.style.borderColor=gc(currentGame);card.style.borderWidth="2px";selectedNum=n;
  const tBars=["全期","近100期","近50期","近20期"].map((lbl,i)=>{
    const vals=[tr.rAll,tr.r100,tr.r50,tr.r20];
    const v=vals[i]||0,mx=Math.max.apply(null,vals.filter(Boolean).concat([1]));
    const h=Math.max(4,Math.round(v/mx*36));
    const c=i===3?(tr.score>=10?"#D85A30":tr.score<=-10?"#378ADD":"#aaa"):i===2?(tr.score>=10?"rgba(216,90,48,.5)":tr.score<=-10?"rgba(55,138,221,.5)":"#ccc"):"#ddd";
    return "<div class='trend-bar-wrap'><div class='trend-bar' style='height:"+h+"px;background:"+c+"'></div><div class='trend-lbl'>"+v+"%</div><div class='trend-lbl'>"+lbl+"</div></div>";
  }).join("");
  const curStr=st.curType==="hit"?"🟢 連續出現中（已連續 "+st.curStreak+" 期）":"⚫ 連續缺席中（已缺席 "+st.curStreak+" 期）";
  const overdue=(iv.lastGap||0)>=(iv.avg||999)*1.5;
  detail.style.display="block";detail.style.borderTop="3px solid "+gc(currentGame);
  detail.innerHTML=
    "<div style='font-size:14px;font-weight:700;margin-bottom:12px;color:"+gc(currentGame)+"'>號碼 "+n+" 詳細規律分析</div>"+
    "<div class='detail-grid'>"+
      "<div class='detail-box'>"+
        "<div class='detail-title'>⏱ 間隔週期</div>"+
        "<div style='font-size:24px;font-weight:700;margin-bottom:2px'>"+(iv.avg||0)+" 期</div>"+
        "<div style='font-size:11px;color:#888'>平均每 "+(iv.avg||0)+" 期出現一次</div>"+
        "<div style='margin-top:10px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;text-align:center'>"+
          "<div style='background:#F5F4F0;border-radius:6px;padding:6px'><div style='font-size:13px;font-weight:700'>"+(iv.min||0)+"</div><div style='font-size:10px;color:#888'>最短間隔</div></div>"+
          "<div style='background:#F5F4F0;border-radius:6px;padding:6px'><div style='font-size:13px;font-weight:700'>"+(iv.max||0)+"</div><div style='font-size:10px;color:#888'>最長間隔</div></div>"+
          "<div style='background:"+(overdue?"#FAECE7":"#F5F4F0")+";border-radius:6px;padding:6px'><div style='font-size:13px;font-weight:700;color:"+(overdue?"#D85A30":"inherit")+";'>"+(iv.lastGap||0)+"</div><div style='font-size:10px;color:#888'>距今已隔</div></div>"+
        "</div>"+
        (overdue?"<div style='margin-top:8px;font-size:11px;color:#D85A30;background:#FAECE7;padding:6px 8px;border-radius:6px'>⚠️ 已超過平均間隔 "+Math.round((iv.lastGap||0)-(iv.avg||0))+" 期</div>":"")+
      "</div>"+
      "<div class='detail-box'>"+
        "<div class='detail-title'>🔗 連續紀錄</div>"+
        "<div style='font-size:13px;font-weight:600;margin-bottom:10px'>"+curStr+"</div>"+
        "<div style='display:grid;grid-template-columns:1fr 1fr;gap:6px;text-align:center'>"+
          "<div style='background:#EAF3DE;border-radius:6px;padding:6px'><div style='font-size:13px;font-weight:700;color:#3B6D11'>"+(st.maxHit||0)+" 期</div><div style='font-size:10px;color:#888'>最長連續出現</div></div>"+
          "<div style='background:#FCEBEB;border-radius:6px;padding:6px'><div style='font-size:13px;font-weight:700;color:#A32D2D'>"+(st.maxMiss||0)+" 期</div><div style='font-size:10px;color:#888'>最長連續缺席</div></div>"+
        "</div>"+
      "</div>"+
      "<div class='detail-box' style='grid-column:1/-1'>"+
        "<div class='detail-title'>📈 熱度趨勢（出現比例）</div>"+
        "<div class='trend-row'>"+tBars+"</div>"+
        "<div style='font-size:12px;color:"+(tr.score>=10?"#D85A30":tr.score<=-10?"#378ADD":"#888")+"'>"+tr.state+"　近20期 "+tr.r20+"%，全期平均 "+tr.rAll+"%（"+(tr.score>=0?"+":"")+tr.score+"%）</div>"+
      "</div>"+
    "</div>";
  detail.scrollIntoView({behavior:"smooth",block:"nearest"});
}

function renderPairChange(){
  const db=DB[currentGame],cont=document.getElementById("pairchange-content");cont.innerHTML="";
  if(db.isDigit){cont.innerHTML="<div style='color:#888;font-size:13px;padding:20px 0'>數字型彩券不適用</div>";return;}
  if(!db.pairChanges||!db.pairChanges.length){cont.innerHTML="<div style='color:#888;font-size:13px;padding:20px 0'>資料不足</div>";return;}
  const mid=Math.floor(db.total/2);
  const rising=db.pairChanges.slice(0,10);
  const cooling=db.pairChanges.slice().sort((a,b)=>a.change-b.change).slice(0,10);
  const note=document.createElement("div");note.style="font-size:11px;color:#aaa;margin-bottom:14px";
  note.textContent="比較前 "+mid+" 期 vs 後 "+(db.total-mid)+" 期的配對共現頻率變化";
  cont.appendChild(note);
  function mkSec(title,pairs,isRising){
    const sec=document.createElement("div");sec.innerHTML="<div class='sec-title'>"+title+"</div>";
    const list=document.createElement("div");list.className="rank-list";
    pairs.forEach((p,i)=>{
      const row=document.createElement("div");row.className="pair-change-row";
      const arrow=isRising?"📈":"📉",clr=isRising?"#D85A30":"#378ADD";
      const ch=(isRising?"+":"")+p.change+"%";
      row.innerHTML="<span class='rank-n'>"+(i+1)+"</span><span style='min-width:18px'>"+arrow+"</span><span class='mini-ball' style='background:"+gc(currentGame)+"'>"+p.a+"</span><span class='mini-ball' style='background:"+gc(currentGame)+"'>"+p.b+"</span><div style='flex:1;font-size:11px;color:#888'>前半 "+p.f1+"% → 後半 "+p.f2+"%</div><span style='font-weight:700;color:"+clr+";min-width:50px;text-align:right'>"+ch+"</span>";
      list.appendChild(row);
    });
    sec.appendChild(list);return sec;
  }
  cont.appendChild(mkSec("📈 關聯強度上升最多",rising,true));
  cont.appendChild(document.createElement("br"));
  cont.appendChild(mkSec("📉 關聯強度下降最多",cooling,false));
}

function renderFullOdds(){
  const p=PRIZES[currentGame],cont=document.getElementById("full-odds-content");cont.innerHTML="";
  cont.innerHTML="<div class='sec-title'>中獎機率完整說明</div><div style='font-size:11px;color:#888;margin-bottom:12px'>計算公式："+p.formula+"</div>";
  const table=document.createElement("table");table.className="odds-table";
  table.innerHTML="<thead><tr><th>獎項</th><th>中獎條件</th><th>機率</th><th>每N注中1次</th></tr></thead>";
  const tbody=document.createElement("tbody");
  p.tiers.forEach(t=>{
    const tr=document.createElement("tr");
    const pct=(1/t.odds*100).toFixed(t.odds>10000?5:t.odds>1000?3:1);
    const diff=t.odds<200?{l:"容易",c:"#3B6D11",bg:"#EAF3DE"}:t.odds<2000?{l:"普通",c:"#BA7517",bg:"#FAEEDA"}:t.odds<100000?{l:"困難",c:"#185FA5",bg:"#E6F1FB"}:{l:"極難",c:"#A32D2D",bg:"#FCEBEB"};
    tr.innerHTML="<td><span class='badge' style='background:"+t.color+"20;color:"+t.color+"'>"+t.name+"</span></td><td style='font-size:11px;color:#5F5E5A'>"+t.match+"</td><td style='font-weight:600;color:"+t.color+"'>"+pct+"%</td><td><span class='badge' style='background:"+diff.bg+";color:"+diff.c+"'>"+diff.l+"</span> "+t.odds.toLocaleString()+"</td>";
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);cont.appendChild(table);
  const note=document.createElement("div");note.style="font-size:10px;color:#aaa;margin-top:12px;line-height:1.6";
  note.textContent="※ 以上為每注理論機率，實際中獎依官方公告為準。彩券純供娛樂，請理性購買。";cont.appendChild(note);
}

// ── 選號邏輯 ───────────────────────────────────────────
function clearResult(){
  document.getElementById("result-placeholder").style.display="";
  document.getElementById("result-placeholder").textContent="選好策略後按下方按鈕產生號碼";
  const br=document.getElementById("balls-row");br.style.display="none";br.innerHTML="";
  document.getElementById("score-row").textContent="";
  document.getElementById("odds-panel").style.display="none";
}

function sample(arr,k){const a=arr.slice(),r=[];for(let i=0;i<k&&a.length;i++){const idx=Math.floor(Math.random()*a.length);r.push(a.splice(idx,1)[0]);}return r;}
function weightedSample(all,w,k){const pool=all.slice(),res=[];for(let i=0;i<k&&pool.length;i++){const tot=pool.reduce((s,x)=>s+(w[x]||0.01),0);let r=Math.random()*tot;for(let j=0;j<pool.length;j++){r-=w[pool[j]]||0.01;if(r<=0){res.push(pool.splice(j,1)[0]);break;}}}return res;}

function pickNums(){
  const db=DB[currentGame],k=db.pick,isDigit=db.isDigit;
  const all=isDigit?Array.from({length:db.mainRange},(_,i)=>i):Array.from({length:db.mainRange},(_,i)=>i+1);
  const freq=db.freq,rfreq=db.recentFreq,tot=db.total,avgA=tot*k/db.mainRange,avgR=Math.min(50,tot)*k/db.mainRange;
  let nums;
  if(isDigit){
    nums=[];
    for(let i=0;i<k;i++){
      if(currentStrat==="hot"){const s=all.slice().sort((a,b)=>(freq[b]||0)-(freq[a]||0));nums.push(s[Math.floor(Math.random()*3)]);}
      else if(currentStrat==="cold"){const s=all.slice().sort((a,b)=>(freq[a]||0)-(freq[b]||0));nums.push(s[Math.floor(Math.random()*3)]);}
      else nums.push(all[Math.floor(Math.random()*all.length)]);
    }
    return{nums,second:null};
  }
  if(currentStrat==="hot")nums=sample(all.slice().sort((a,b)=>(freq[b]||0)-(freq[a]||0)).slice(0,k*3),k);
  else if(currentStrat==="cold")nums=sample(all.slice().sort((a,b)=>(freq[a]||0)-(freq[b]||0)).slice(0,k*3),k);
  else if(currentStrat==="bal"){
    const hot=all.slice().sort((a,b)=>(freq[b]||0)-(freq[a]||0)).slice(0,k*2);
    const cold=all.slice().sort((a,b)=>(freq[a]||0)-(freq[b]||0)).slice(0,k*2);
    const h=sample(hot,Math.floor(k/2)),c=sample(cold.filter(x=>h.indexOf(x)<0),k-Math.floor(k/2));
    nums=h.concat(c);if(nums.length<k)nums=nums.concat(sample(all.filter(x=>nums.indexOf(x)<0),k-nums.length));
  }
  else if(currentStrat==="rise"){
    const rising=all.filter(n=>(rfreq[n]||0)/avgR>(freq[n]||0)/avgA*1.15).sort((a,b)=>((rfreq[b]||0)/avgR)-((rfreq[a]||0)/avgR));
    nums=rising.length>=k?sample(rising.slice(0,k*2),k):rising.concat(sample(all.filter(x=>rising.indexOf(x)<0),k-rising.length));
  }
  else if(currentStrat==="ai"){
    const pm=db.pairFreq||{},pmx=Math.max.apply(null,Object.values(pm).map(Number).concat([1])),w={};
    all.forEach(n=>{const fs=(freq[n]||0)/avgA,ps=all.reduce((acc,m)=>{if(m===n)return acc;const kk=Math.min(n,m)+","+Math.max(n,m);return acc+(pm[kk]||0)/pmx;},0);w[n]=fs*0.5+ps*0.02+0.01;});
    nums=weightedSample(all,w,k);
  }
  else nums=sample(all,k);
  const uniq=[];nums.forEach(x=>{if(uniq.indexOf(x)<0)uniq.push(x);});nums=uniq.sort((a,b)=>a-b);
  while(nums.length<k){const ex=all.find(x=>nums.indexOf(x)<0);if(!ex)break;nums.push(ex);nums.sort((a,b)=>a-b);}
  let second=null;
  if(db.secondRange){
    const sf=db.secondFreq||{},sall=Array.from({length:db.secondRange},(_,i)=>i+1);
    if(currentStrat==="hot")second=sall.reduce((a,b)=>(sf[a]||0)>=(sf[b]||0)?a:b);
    else if(currentStrat==="cold")second=sall.reduce((a,b)=>(sf[a]||0)<=(sf[b]||0)?a:b);
    else second=sall[Math.floor(Math.random()*sall.length)];
  }
  return{nums,second};
}

function coScore(nums){
  const db=DB[currentGame];if(!db.pairFreq||db.isDigit)return null;
  let score=0,cnt=0;
  for(let i=0;i<nums.length;i++)for(let j=i+1;j<nums.length;j++){
    const k=Math.min(nums[i],nums[j])+","+Math.max(nums[i],nums[j]);score+=db.pairFreq[k]||0;cnt++;
  }
  const mx=Math.max.apply(null,Object.values(db.pairFreq).map(Number).concat([1]));
  return cnt?Math.round(score/(mx*cnt)*100):0;
}

// ── 建立一張號碼球 HTML ────────────────────────────────
function makeBalls(nums,second,db,color){
  const isDigit=db.isDigit;
  let html=nums.map(n=>"<span class='ball"+(isDigit?"-digit":"")+"' style='background:"+color+"'>"+String(n).padStart(isDigit?1:2,"0")+"</span>").join("");
  if(second!==null) html+="<span class='plus-sign'>+</span><span class='ball-second'>"+String(second).padStart(2,"0")+"</span>";
  return html;
}

// ── 產生號碼（1或10組）────────────────────────────────
function generate(){
  if(!currentGame||!DB[currentGame]){alert("請先載入資料！");return;}
  const db=DB[currentGame],p=PRIZES[currentGame],color=gc(currentGame);

  // 確保規律指數分佈已建立
  if(!db.isDigit&&!patternDistCache[currentGame]){
    patternDistCache[currentGame]=buildPatternDist(currentGame);
  }

  // 產生 genCount 組
  const results=[];
  for(let i=0;i<genCount;i++){
    const {nums,second}=pickNums();
    const co=coScore(nums);
    const pScore=!db.isDigit?calcComboPatternScore(nums,db):null;
    const pPct=pScore!==null?getPercentile(pScore,patternDistCache[currentGame]||[]):null;
    const pRat=pPct!==null?patternRating(pPct):null;
    let pairNote="";
    if(db.topPairs&&db.topPairs.length)
      for(const pr of db.topPairs.slice(0,5))
        if(nums.indexOf(pr.a)>=0&&nums.indexOf(pr.b)>=0){pairNote=" · 含強配對 "+pr.a+"×"+pr.b;break;}
    results.push({nums,second,co,pScore,pPct,pRat,pairNote});
  }

  // ── 顯示最新一組（大球區）────────────────────────────
  const first=results[0];
  document.getElementById("result-placeholder").style.display="none";
  const row=document.getElementById("balls-row");
  row.innerHTML=makeBalls(first.nums,first.second,db,color);
  row.style.display="flex";
  document.getElementById("score-row").textContent=
    first.co!==null?"共現分數 "+first.co+"/100"+first.pairNote:"";

  // 規律指數
  const piEl=document.getElementById("pattern-index-row");
  if(piEl){
    if(first.pRat&&first.pScore!==null){
      piEl.style.display="block";
      piEl.style.background=first.pRat.bg;
      piEl.style.borderLeftColor=first.pRat.color;
      piEl.innerHTML=
        "<div style='display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap'>"+
          "<div>"+
            "<div style='font-size:12px;font-weight:700;color:"+first.pRat.color+"'>📊 歷史規律指數 "+first.pScore.toFixed(1)+"　"+first.pRat.label+"</div>"+
            "<div style='font-size:11px;color:#888;margin-top:2px'>"+first.pRat.detail+"</div>"+
          "</div>"+
        "</div>"+
        "<div style='font-size:10px;color:#aaa;margin-top:5px'>⚠️ 反映歷史統計規律，不代表實際中獎機率。沒中請別怪我。</div>";
    } else {
      piEl.style.display="none";
    }
  }

  // 中獎機率面板（只顯示第一組）
  const panel=document.getElementById("odds-panel");panel.style.display="block";panel.style.borderTopColor=color;
  const tbody=document.getElementById("odds-body");tbody.innerHTML="";
  p.tiers.forEach(t=>{
    const tr=document.createElement("tr");
    const pct=(1/t.odds*100).toFixed(t.odds>10000?5:t.odds>1000?3:1);
    const diff=t.odds<200?{l:"容易",c:"#3B6D11",bg:"#EAF3DE"}:t.odds<2000?{l:"普通",c:"#BA7517",bg:"#FAEEDA"}:t.odds<100000?{l:"困難",c:"#185FA5",bg:"#E6F1FB"}:{l:"極難",c:"#A32D2D",bg:"#FCEBEB"};
    tr.innerHTML="<td><span class='badge' style='background:"+t.color+"20;color:"+t.color+"'>"+t.name+"</span></td><td style='font-size:11px;color:#5F5E5A'>"+t.match+"</td><td style='font-weight:600;color:"+t.color+"'>"+pct+"%</td><td><span class='badge' style='background:"+diff.bg+";color:"+diff.c+"'>"+diff.l+"</span></td>";
    tbody.appendChild(tr);
  });
  document.getElementById("odds-note").textContent="頭獎：每 "+p.odds.toLocaleString()+" 注約中 1 次";

  // ── 加入歷史紀錄 ─────────────────────────────────────
  if(!genHistory[currentGame])genHistory[currentGame]=[];
  const strat=STRATS.find(s=>s.id===currentStrat)||{label:currentStrat};
  const time=new Date().toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",second:"2-digit"});

  // 每組都加進去
  results.forEach(rec=>{
    genHistory[currentGame].unshift({
      nums:rec.nums.slice(),second:rec.second,
      co:rec.co,pScore:rec.pScore,pPct:rec.pPct,pRat:rec.pRat,
      pairNote:rec.pairNote,strat,time
    });
  });
  if(genHistory[currentGame].length>50)genHistory[currentGame]=genHistory[currentGame].slice(0,50);
  renderHistory();
}

// ── 歷史紀錄渲染 ───────────────────────────────────────
function renderHistory(){
  const cont=document.getElementById("history-list");if(!cont)return;
  const hist=genHistory[currentGame]||[];
  if(!hist.length){
    cont.innerHTML="<div style='color:#aaa;font-size:12px;padding:12px 0;text-align:center'>尚未產生任何號碼</div>";
    return;
  }
  const db=DB[currentGame],color=gc(currentGame);
  cont.innerHTML="";

  // 依排序整理（複製陣列，不改原始順序）
  let sorted = hist.slice();
  if(histSort==="pat_desc") sorted.sort((a,b)=>(b.pScore||0)-(a.pScore||0));
  else if(histSort==="pat_asc")  sorted.sort((a,b)=>(a.pScore||0)-(b.pScore||0));
  else if(histSort==="co_desc")  sorted.sort((a,b)=>(b.co||0)-(a.co||0));
  else if(histSort==="co_asc")   sorted.sort((a,b)=>(a.co||0)-(b.co||0));
  // time: 保持原本 unshift 順序（最新在前）

  sorted.forEach((rec,idx)=>{
    const card=document.createElement("div");card.className="hist-card";
    const ballsHtml=makeBalls(rec.nums,rec.second,db,color);

    // 規律指數小標籤
    let ratHtml="";
    if(rec.pRat&&rec.pScore!==null){
      ratHtml="<span class='badge' style='background:"+rec.pRat.bg+";color:"+rec.pRat.color+"'>"+rec.pRat.label+"</span>";
    }

    card.innerHTML=
      "<div style='display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-bottom:5px'>"+
        ballsHtml+
      "</div>"+
      "<div style='display:flex;align-items:center;gap:5px;flex-wrap:wrap'>"+
        "<span style='font-size:10px;color:#aaa'>"+rec.time+"</span>"+
        "<span class='badge' style='background:#EDECEA;color:#5F5E5A;font-size:10px'>"+rec.strat.label+"</span>"+
        (rec.co!==null?"<span style='font-size:11px;color:#888'>共現 "+rec.co+"/100</span>":"")+
        (rec.pScore!==null?"<span style='font-size:11px;color:#888'>規律 "+rec.pScore.toFixed(1)+"</span>":"")+
        ratHtml+
      "</div>";

    // 點擊展開中獎機率
    card.style.cursor="pointer";
    card.onclick=function(){
      const ex=card.querySelector(".hist-expand");
      if(ex){ex.remove();return;}
      const p=PRIZES[currentGame];if(!p)return;
      const div=document.createElement("div");div.className="hist-expand";
      div.style="margin-top:8px;border-top:1px solid #eee;padding-top:8px";
      div.innerHTML=p.tiers.map(t=>{
        const pct=(1/t.odds*100).toFixed(t.odds>10000?5:t.odds>1000?3:1);
        return "<div style='display:flex;justify-content:space-between;font-size:11px;padding:2px 0'>"+
          "<span style='color:"+t.color+";font-weight:600'>"+t.name+"</span>"+
          "<span style='color:#888'>"+t.match+"</span>"+
          "<span style='font-weight:600'>"+pct+"%</span></div>";
      }).join("")+
      (rec.pRat?"<div style='margin-top:6px;font-size:10px;color:#aaa'>📊 規律指數 "+rec.pScore.toFixed(1)+" — "+rec.pRat.detail+"</div>":"");
      card.appendChild(div);
    };
    cont.appendChild(card);
  });
}

let histSort = "time";

function setHistSort(val){
  histSort = val;
  document.querySelectorAll(".hist-sort").forEach(b=>{
    const active = b.dataset.hsort === val;
    b.classList.toggle("active", active);
    b.style.background = active ? gc(currentGame)+"20" : "";
    b.style.color = active ? gc(currentGame) : "";
    b.style.borderColor = active ? gc(currentGame) : "";
    b.style.fontWeight = active ? "700" : "600";
  });
  renderHistory();
}

function clearHistory(){
  if(!currentGame)return;
  genHistory[currentGame]=[];
  renderHistory();
}

function showUpload(){
  document.getElementById("upload-zone").style.display="block";
  document.getElementById("app-content").style.display="none";
  document.getElementById("progress-area").style.display="none";
}

