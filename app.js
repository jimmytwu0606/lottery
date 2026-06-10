// ── GitHub 自動載入 ────────────────────────────────────
const GITHUB_OWNER  = "jimmytwu0606";
const GITHUB_REPO   = "lottery";
const CSV_FOLDER    = "";  // CSV 放 repo 根目錄；改成 "data" 就是 data/ 子目錄

// ── Google Sheets API ──────────────────────────────────
const GS_API = "https://script.google.com/macros/s/AKfycbwMyThlYMP3pLTr_cKLO5sgLhFV51vZnzHqDa0gyxLPffhA-35iz-0K7dioKwWlXcvr/exec";

async function gsPost(action, data){
  try{
    await fetch(GS_API, {
      method:"POST", mode:"no-cors",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({action, data})
    });
    return {ok:true};
  } catch(e){
    console.warn("GS write failed:", e);
    return {ok:false, error:e.message};
  }
}

async function gsGet(sheet, limit=100){
  try{
    const url = GS_API + "?action=read&sheet="+sheet+"&limit="+limit;
    const res = await fetch(url);
    return await res.json();
  } catch(e){
    console.warn("GS read failed:", e);
    return {ok:false, rows:[]};
  }
}

// ── 官網開獎資料同步（透過 Apps Script 後端撈官方 API）──
// 按下按鈕 → GAS 去 api.taiwanlottery.com 撈最近 N 個月
// → 比對 draws_<彩種> 工作表已有期別 → 只把「還沒存入的」補進去
async function syncOfficialDraws(){
  const btn = document.getElementById("sync-draws-btn");
  const statusEl = document.getElementById("load-status");
  if(btn){ btn.disabled = true; btn.textContent = "☁️ 同步中..."; }
  if(statusEl) statusEl.textContent = "正在向官網撈取最新開獎資料...";

  try{
    const res = await fetch(GS_API + "?action=sync_draws&months=2");
    const j   = await res.json();
    if(!j.ok) throw new Error(j.error || "同步失敗");

    const parts = (j.results||[]).map(r =>
      r.ok ? `${r.game} +${r.added}（共${r.total}期）` : `${r.game} ❌`
    );
    const totalAdded = (j.results||[]).reduce((s,r)=>s+(r.added||0),0);
    if(statusEl) statusEl.textContent =
      totalAdded > 0
        ? "✅ 已補存 " + totalAdded + " 期：" + parts.join("、")
        : "✅ Sheet 已是最新，沒有缺漏期別";

    // 同步完，把 Sheet 上比本地新的期別合併進分析資料
    await mergeSheetDraws();

    // 自動對獎：拿新開獎結果比對 gen_history 還沒對過的紀錄
    try{
      const cr = await fetch(GS_API + "?action=check_gen");
      const cj = await cr.json();
      if(cj.ok && cj.checked > 0 && statusEl){
        statusEl.textContent += `｜🎯 已自動對獎 ${cj.checked} 筆` + (cj.won ? `，中獎 ${cj.won} 筆！` : "，皆未中");
      }
    } catch(e){ console.warn("check_gen failed:", e); }
  } catch(e){
    console.warn("sync_draws failed:", e);
    if(statusEl) statusEl.textContent = "❌ 同步失敗：" + e.message + "（請確認 Apps Script 已更新並重新部署）";
  }
  if(btn){ btn.disabled = false; btn.textContent = "☁️ 同步官網開獎 → Sheet"; }
}

// ── 把 Sheet 上的開獎資料合併進目前 DB ──────────────────
// 讀 draws_<彩種>，把期別比本地 CSV 還新的列接成 CSV 餵給 buildDB
async function mergeSheetDraws(){
  const cached = loadCache();
  const csvMap = cached ? cached.csvMap : {};
  let merged = 0;

  for(const game of Object.keys(GAME_CFG)){
    try{
      const res = await fetch(GS_API + "?action=read_draws&game=" + encodeURIComponent(game) + "&limit=400");
      const j   = await res.json();
      if(!j.ok || !j.rows || !j.rows.length || !j.headers) continue;

      const csv = [ j.headers.join(",") ]
        .concat(j.rows.map(r => j.headers.map(h => r[h] ?? "").join(",")))
        .join("\n");

      if(!csvMap[game]) csvMap[game] = [];
      // 同名來源只保留最新一份
      csvMap[game] = csvMap[game].filter(f => f.name !== "__sheet_draws__");
      csvMap[game].push({name:"__sheet_draws__", content: csv});
      merged++;
    } catch(e){ /* 個別彩種失敗不影響其他 */ }
  }

  if(merged){
    saveCache(csvMap);
    applyCSVMap(csvMap, false, Date.now());
  }
}

// ── 時間格式化（支援 ISO / zh-TW 各種格式）──────────────
function fmtTime(raw){
  if(!raw) return "";
  const s = String(raw);
  // ISO 格式 2026-06-01T15:44:00.000Z → 加8小時轉台灣時間
  if(s.includes("T") && s.includes("Z")){
    try{
      const d = new Date(s);
      return d.toLocaleString("zh-TW",{
        timeZone:"Asia/Taipei",
        year:"numeric",month:"2-digit",day:"2-digit",
        hour:"2-digit",minute:"2-digit",hour12:false
      }).replace(/\//g,"/");
    } catch(e){ return s; }
  }
  // 已經是正常格式就直接回傳
  return s;
}


// ── 快取設定 ───────────────────────────────────────────
const CACHE_KEY     = "lottery_csv_cache";
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24小時（毫秒）

function saveCache(csvMap){
  try{
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      csvMap
    }));
  } catch(e){ console.warn("快取寫入失敗（可能空間不足）", e); }
}

function loadCache(){
  try{
    const raw = localStorage.getItem(CACHE_KEY);
    if(!raw) return null;
    const obj = JSON.parse(raw);
    if(!obj || !obj.ts || !obj.csvMap) return null;
    const age = Date.now() - obj.ts;
    if(age > CACHE_MAX_AGE) return null; // 過期
    return obj;
  } catch(e){ return null; }
}

function clearCache(){
  localStorage.removeItem(CACHE_KEY);
}

function cacheAgeText(ts){
  const mins = Math.floor((Date.now() - ts) / 60000);
  if(mins < 1)   return "剛剛更新";
  if(mins < 60)  return mins + " 分鐘前";
  const hrs = Math.floor(mins / 60);
  if(hrs < 24)   return hrs + " 小時前";
  return Math.floor(hrs / 24) + " 天前";
}

// ── 啟動時自動嘗試快取 ─────────────────────────────────
window.addEventListener("DOMContentLoaded", function(){
  const cached = loadCache();
  if(cached){
    applyCSVMap(cached.csvMap, true, cached.ts);
  }
});

// ── 從 csvMap 建立 DB 並顯示 UI ─────────────────────────
function applyCSVMap(csvMap, fromCache, cacheTs){
  let loaded = 0;
  for(const [game, list] of Object.entries(csvMap)){
    try{
      DB[game] = analyzeCSVs(game, list);
      loaded++;
      const d = document.getElementById("dot-" + game);
      if(d) d.className = "dot ok";
    } catch(e){ console.error(game, e); }
  }
  if(!loaded) return false;

  document.getElementById("upload-zone").style.display = "none";
  const ac = document.getElementById("app-content");
  ac.style.display = "flex"; ac.style.flexDirection = "column"; ac.style.gap = "14px";
  switchGame(Object.keys(DB)[0] || "今彩539");

  const tot = Object.values(DB).reduce((s,d) => s + d.total, 0);
  const statusEl = document.getElementById("status-txt");
  if(fromCache){
    statusEl.innerHTML = "✓ " + loaded + "種 " + tot.toLocaleString() + "期<br>"
      + "<span style='font-size:10px;color:#888780'>" + cacheAgeText(cacheTs) + "（快取）</span>";
  } else {
    statusEl.textContent = "✓ " + loaded + "種 " + tot.toLocaleString() + "期";
  }
  statusEl.style.color = "#639922";

  // 更新側邊欄按鈕
  const refreshBtn = document.getElementById("refresh-btn");
  if(refreshBtn) refreshBtn.style.display = "block";

  return true;
}

// ── 強制從 GitHub 重新下載 ─────────────────────────────
async function loadFromGitHub(forceRefresh){
  const statusEl = document.getElementById("load-status");
  const btn      = document.getElementById("github-load-btn");

  // 如果不是強制刷新，先看快取
  if(!forceRefresh){
    const cached = loadCache();
    if(cached){
      const ok = applyCSVMap(cached.csvMap, true, cached.ts);
      if(ok){
        if(statusEl) statusEl.textContent = "✅ 已從快取載入（" + cacheAgeText(cached.ts) + "）";
        if(btn){ btn.disabled = false; btn.textContent = "⚡ 自動載入最新資料"; }
        return;
      }
    }
  }

  if(statusEl) statusEl.textContent = "掃描 GitHub 檔案中...";
  if(btn){ btn.disabled = true; btn.textContent = "下載中..."; }

  try {
    const folder  = CSV_FOLDER ? CSV_FOLDER + "/" : "";
    const apiUrl  = "https://api.github.com/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO + "/contents/" + folder;
    const res     = await fetch(apiUrl);
    if(!res.ok) throw new Error("GitHub API 回應 " + res.status);
    const files   = await res.json();

    // ZIP 優先，沒有 ZIP 再找 CSV
    const zipFiles = files.filter(f => f.name.toLowerCase().endsWith(".zip"));
    const csvFiles = files.filter(f => f.name.toLowerCase().endsWith(".csv"));

    if(!zipFiles.length && !csvFiles.length){
      if(statusEl) statusEl.textContent = "⚠️ 找不到 ZIP 或 CSV 檔案";
      if(btn){ btn.disabled = false; btn.textContent = "⚡ 重試"; }
      return;
    }

    const csvMap = {};

    // ── 處理 ZIP ──
    if(zipFiles.length){
      if(statusEl) statusEl.textContent = "找到 " + zipFiles.length + " 個 ZIP，下載解壓中...";
      for(const file of zipFiles){
        if(statusEl) statusEl.textContent = "下載 " + file.name + "...";
        const r    = await fetch(file.download_url);
        const blob = await r.blob();
        const zip  = await JSZip.loadAsync(blob);
        for(const [name, entry] of Object.entries(zip.files)){
          if(name.toLowerCase().endsWith(".csv") && !entry.dir){
            const text = await entry.async("string");
            const g    = detectGame(name);
            if(!g) continue;
            if(!csvMap[g]) csvMap[g] = [];
            csvMap[g].push({name, content: text});
          }
        }
      }
    }

    // ── 處理散 CSV（補充 ZIP 沒有的彩種）──
    for(const file of csvFiles){
      const g = detectGame(file.name);
      if(!g || csvMap[g]) continue; // ZIP 已有就跳過
      if(statusEl) statusEl.textContent = "下載 " + file.name + "...";
      const r       = await fetch(file.download_url);
      const text    = await r.text();
      if(!csvMap[g]) csvMap[g] = [];
      csvMap[g].push({name: file.name, content: text});
    }

    // 存快取
    saveCache(csvMap);

    applyCSVMap(csvMap, false, Date.now());
    if(statusEl) statusEl.textContent = "✅ 下載完成，已更新快取";
    if(btn){ btn.disabled = false; btn.textContent = "⚡ 自動載入最新資料"; }

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
    intervals,streaks,trend,pairChanges,allNums,
    draws,  // 回測用：每期號碼陣列
    rows    // 自動抓最新期用：含期別欄位
  };
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
  // top = 前百分之幾，最低顯示 1%
  const top = Math.max(1, 100 - pct);
  const detail = "規律指數贏過 " + pct + "% 的隨機組合";
  if(pct>=95) return{label:"極強 前 "+top+"%", detail, color:"#D85A30", bg:"#FAECE7"};
  if(pct>=80) return{label:"偏強 前 "+top+"%", detail, color:"#BA7517", bg:"#FAEEDA"};
  if(pct>=50) return{label:"中等 前 "+top+"%", detail, color:"#3B6D11", bg:"#EAF3DE"};
  if(pct>=20) return{label:"偏弱 前 "+top+"%", detail, color:"#185FA5", bg:"#E6F1FB"};
  return           {label:"較低 前 "+top+"%", detail, color:"#888780", bg:"#EDECEA"};
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
  renderPattern(patternFilter);renderPairChange();renderFullOdds();renderVerify();renderTrend();
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
// ── AI 5維評分核心 ──────────────────────────────────────
// 維度：① 全期頻率  ② 近期熱度(近20期)  ③ 間隔超期程度
//        ④ 共現強度  ⑤ 近期竄升趨勢
// 各維度 0~1 正規化後加權合併
function calcAIScore(n, freq, total, draws, pf, pmx, range, pick){
  const allNums = range<=10
    ? Array.from({length:range},(_,i)=>i)
    : Array.from({length:range},(_,i)=>i+1);

  const avgFreq = total * pick / range;

  // ① 全期頻率（正規化）
  const maxFreq = Math.max(1, ...allNums.map(x=>freq[x]||0));
  const s_freq  = (freq[n]||0) / maxFreq;

  // ② 近期熱度（近20期出現率 vs 全期平均）
  const w20   = draws.slice(-20);
  const r20   = w20.length ? w20.filter(d=>d.indexOf(n)>=0).length/w20.length : 0;
  const rAll  = total>0 ? (freq[n]||0)/total : 0;
  const heat  = rAll>0 ? Math.min(2, r20/rAll) / 2 : 0.5; // 0~1，1=近期出現率是平均2倍

  // ③ 間隔超期（z-score 轉 0~1，超期越多分越高）
  let s_gap = 0.5;
  const idxs = [];
  draws.forEach((d,i)=>{ if(d.indexOf(n)>=0) idxs.push(i); });
  if(idxs.length>=2){
    const gaps = idxs.slice(1).map((v,i)=>v-idxs[i]);
    const avg  = gaps.reduce((s,x)=>s+x,0)/gaps.length;
    const std  = Math.sqrt(gaps.map(g=>(g-avg)**2).reduce((s,x)=>s+x,0)/gaps.length)||1;
    const lastGap = total-1-idxs[idxs.length-1];
    const z = (lastGap-avg)/std;
    s_gap = Math.min(1, Math.max(0, 0.5 + z*0.2)); // z=2.5時達到1
  } else if(idxs.length===0){
    s_gap = 1.0; // 從未出現，超期最高分
  }

  // ④ 共現強度（此號與所有其他號的平均共現率）
  let coSum = 0;
  allNums.forEach(m=>{
    if(m===n) return;
    const k = Math.min(n,m)+","+Math.max(n,m);
    coSum += (pf[k]||0)/pmx;
  });
  const s_co = allNums.length>1 ? coSum/(allNums.length-1) : 0;

  // ⑤ 竄升趨勢（近50期 vs 全期）
  const w50  = draws.slice(-50);
  const r50  = w50.length ? w50.filter(d=>d.indexOf(n)>=0).length/w50.length : 0;
  const rise = rAll>0 ? Math.min(1, Math.max(0, (r50-rAll)/rAll*0.5+0.5)) : 0.5;

  // 加權合併：頻率20% + 熱度25% + 超期20% + 共現20% + 竄升15%
  return s_freq*0.20 + heat*0.25 + s_gap*0.20 + s_co*0.20 + rise*0.15;
}

// 建立 AI 候選池（取加權前 pick*2 個號碼）
function buildAIPool(allNums, freq, total, draws, pf, pmx, pick, range){
  const scores = {};
  allNums.forEach(n=>{
    scores[n] = calcAIScore(n, freq, total, draws, pf, pmx, range, pick);
  });
  const sorted = allNums.slice().sort((a,b)=>scores[b]-scores[a]);
  return new Set(sorted.slice(0, pick*2));
}

// AI 加權隨機抽選（用 score 做加權，不是直接取 top）
function aiWeightedPick(db, all, k){
  const draws = db.draws||[];
  const pf    = db.pairFreq||{};
  const pmx   = Math.max(1,...Object.values(pf).map(Number).concat([1]));
  const w = {};
  all.forEach(n=>{
    w[n] = Math.max(0.001, calcAIScore(
      n, db.freq, db.total, draws, pf, pmx, db.mainRange, k
    ));
  });
  return weightedSample(all, w, k);
}

function pickNums(){
  const db=DB[currentGame],k=db.pick,isDigit=db.isDigit;
  const all=isDigit?Array.from({length:db.mainRange},(_,i)=>i):Array.from({length:db.mainRange},(_,i)=>i+1);
  const freq=db.freq,rfreq=db.recentFreq,tot=db.total,avgA=tot*k/db.mainRange,avgR=Math.min(50,tot)*k/db.mainRange;
  let nums;
  if(isDigit){
    nums=[];
    for(let i=0;i<k;i++){
      if(currentStrat==="hot"){const s=all.slice().sort((a,b)=>(freq[b]||0)-(freq[a]||0));nums.push(s[Math.floor(Math.random()*5)]);}
      else if(currentStrat==="cold"){const s=all.slice().sort((a,b)=>(freq[a]||0)-(freq[b]||0));nums.push(s[Math.floor(Math.random()*5)]);}
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
    nums = aiWeightedPick(db, all, k);
  }
  else nums=sample(all,k);
  const uniq=[];nums.forEach(x=>{if(uniq.indexOf(x)<0)uniq.push(x);});nums=uniq.sort((a,b)=>a-b);
  while(nums.length<k){const rest=all.filter(x=>nums.indexOf(x)<0);if(!rest.length)break;nums.push(rest[Math.floor(Math.random()*rest.length)]);nums.sort((a,b)=>a-b);}
  let second=null;
  if(db.secondRange){
    const sf=db.secondFreq||{},sall=Array.from({length:db.secondRange},(_,i)=>i+1);
    if(currentStrat==="hot"){const s=sall.slice().sort((a,b)=>(sf[b]||0)-(sf[a]||0));second=s[Math.floor(Math.random()*Math.min(3,s.length))];}
    else if(currentStrat==="cold"){const s=sall.slice().sort((a,b)=>(sf[a]||0)-(sf[b]||0));second=s[Math.floor(Math.random()*Math.min(3,s.length))];}
    else second=sall[Math.floor(Math.random()*sall.length)];
  }
  return{nums,second};
}

// ── 撞號（分彩）風險評分 ────────────────────────────────
// 0~100，越高代表越像「大眾愛簽的組合」，中獎時越可能跟人均分。
// 不影響中獎機率，只影響中獎時的期望獎金。
let avoidCrowd = false;
function setAvoidCrowd(v){ avoidCrowd = v; }

function crowdScore(nums, db){
  if(!db || db.isDigit || !nums || nums.length < 2) return null;
  const k = nums.length, range = db.mainRange;
  const s = nums.slice().sort((a,b)=>a-b);
  let score = 0;

  // 1) 生日區（1~31）佔比超出自然比例 → 最重的大眾偏好
  const lowShare = s.filter(n=>n>=1&&n<=31).length / k;
  const natural  = Math.min(31,range) / range;
  if(lowShare > natural) score += (lowShare-natural)/(1-natural+1e-9) * 40;
  if(lowShare === 1 && range > 31) score += 10;            // 全部都在生日區再加重

  // 2) 全部 ≤12（月份/日期組合）
  if(s[k-1] <= 12) score += 15;

  // 3) 連號
  let consec = 0;
  for(let i=1;i<k;i++) if(s[i]-s[i-1]===1) consec++;
  score += consec * 7;
  if(consec >= k-1) score += 20;                            // 整組連號（1,2,3,4,5,6）

  // 4) 等差數列（5,10,15...）
  if(k >= 3){
    const d = s[1]-s[0];
    if(d > 1 && s.every((n,i)=>i===0 || n-s[i-1]===d)) score += 25;
  }

  // 5) 同尾數 / 同倍數
  const mod5 = s.filter(n=>n%5===0).length;
  if(mod5 >= k-1) score += 12;

  // 6) 與上一期開獎重複（很多人照簽上期號碼）
  const last = db.draws && db.draws.length ? db.draws[db.draws.length-1] : null;
  if(last){
    const dup = s.filter(n=>last.indexOf(n)>=0).length;
    if(dup >= 3) score += dup * 6;
  }

  return Math.min(100, Math.round(score));
}

function crowdRating(score){
  if(score === null) return null;
  if(score < 25)  return {label:"分彩風險低", color:"#3B6D11", bg:"#EAF3DE", note:"冷門組合，若中頭彩較可能獨得"};
  if(score < 50)  return {label:"分彩風險中", color:"#BA7517", bg:"#FAEEDA", note:"含部分大眾偏好元素"};
  return            {label:"分彩風險高", color:"#A32D2D", bg:"#FCEBEB", note:"典型大眾組合，中獎易與多人均分"};
}

// 開啟「避開撞號」時：重抽直到風險夠低（機率不變，只挑冷門組合）
function pickNumsAvoidCrowd(db){
  let best = null, bestScore = 999;
  for(let t=0; t<25; t++){
    const r = pickNums();
    const cs = crowdScore(r.nums, db);
    if(cs === null) return r;
    if(cs < bestScore){ best = r; bestScore = cs; }
    if(cs < 25) return r;     // 夠冷門就收
  }
  return best;                 // 25 次內最冷門的一組
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
    const {nums,second}=(avoidCrowd&&!db.isDigit)?pickNumsAvoidCrowd(db):pickNums();
    const co=coScore(nums);
    const crowd=crowdScore(nums,db);
    const pScore=!db.isDigit?calcComboPatternScore(nums,db):null;
    const pPct=pScore!==null?getPercentile(pScore,patternDistCache[currentGame]||[]):null;
    const pRat=pPct!==null?patternRating(pPct):null;
    let pairNote="";
    if(db.topPairs&&db.topPairs.length)
      for(const pr of db.topPairs.slice(0,5))
        if(nums.indexOf(pr.a)>=0&&nums.indexOf(pr.b)>=0){pairNote=" · 含強配對 "+pr.a+"×"+pr.b;break;}
    results.push({nums,second,co,crowd,pScore,pPct,pRat,pairNote});
  }

  // ── 顯示最新一組（大球區）────────────────────────────
  const first=results[0];
  document.getElementById("result-placeholder").style.display="none";
  const row=document.getElementById("balls-row");
  row.innerHTML=makeBalls(first.nums,first.second,db,color);
  row.style.display="flex";
  document.getElementById("score-row").textContent=
    first.co!==null?"共現分數 "+first.co+"/100"+first.pairNote:"";

  // 分彩風險徽章（唯一真正影響期望獎金的指標）
  (function(){
    let el=document.getElementById("crowd-risk-row");
    if(!el){
      el=document.createElement("div");
      el.id="crowd-risk-row";
      el.style.cssText="margin-top:6px;font-size:12px";
      document.getElementById("score-row").after(el);
    }
    const cr=crowdRating(first.crowd);
    if(cr){
      el.style.display="block";
      el.innerHTML=`<span style="padding:2px 9px;border-radius:99px;background:${cr.bg};color:${cr.color};font-weight:700">🛡️ ${cr.label} ${first.crowd}/100</span> <span style="color:#999;font-size:11px">${cr.note}</span>`;
    } else el.style.display="none";
  })();

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
    const histRec = {
      nums:rec.nums.slice(),second:rec.second,
      co:rec.co,pScore:rec.pScore,pPct:rec.pPct,pRat:rec.pRat,
      pairNote:rec.pairNote,strat,time
    };
    genHistory[currentGame].unshift(histRec);
    // 存入 Google Sheets
    saveGenToGS(histRec);
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

// ═══════════════════════════════════════════════════════
// 開獎驗證 ── 今日中獎號碼 × 歷史規律分析
// ═══════════════════════════════════════════════════════

let verifySelected = [];      // 主區選號
let verifySecond   = null;    // 第二區（威力彩用）
let verifySpecial  = null;    // 特別號（大樂透用）

// ── 渲染整個 verify 分頁 ────────────────────────────────
function renderVerify(){
  const cont = document.getElementById("verify-content");
  if(!cont) return;
  if(!currentGame || !DB[currentGame]){
    cont.innerHTML = "<div style='color:#aaa;font-size:13px;padding:20px 0;text-align:center'>請先載入彩券資料</div>";
    return;
  }
  const db  = DB[currentGame];
  const cfg = GAME_CFG[currentGame];
  const color = gc(currentGame);

  // 重置選號（換彩種時清空）
  verifySelected = [];
  verifySecond   = null;
  verifySpecial  = null;

  // ── 標題 ──
  let html = `
  <div style="margin-bottom:12px">
    <div style="font-size:14px;font-weight:700;color:${color};margin-bottom:3px">🎯 開獎號碼驗證</div>
    <div style="font-size:11px;color:#888">輸入今日 ${currentGame} 的中獎號碼，分析與歷史規律的關聯</div>
  </div>`;

  // ── 號碼選擇區 ──
  const isDigit = cfg.isDigit;
  const pick = cfg.pick;
  const range = cfg.mainRange;

  html += `<div class="vcard">
    <div class="vcard-title">貼上開獎號碼</div>
    <div style="display:flex;gap:6px;align-items:stretch;margin-bottom:14px">
      <input id="verify-paste-input" type="text" placeholder="例：03、08、09、15、24、35，第二區 04"
        style="flex:1;padding:9px 12px;border:1.5px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit;color:#2C2C2A;outline:none;transition:border-color .15s"
        oninput="onVerifyPasteInput(this)"
        onkeydown="if(event.key==='Enter')parseVerifyPaste()"
        onfocus="this.style.borderColor='${color}'"
        onblur="this.style.borderColor='#ddd'"
      />
      <button onclick="parseVerifyPaste()"
        style="padding:9px 16px;background:${color};color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap">解析</button>
      <button onclick="autoFillLatestDraw()"
        style="padding:9px 14px;background:#EDECEA;color:#5F5E5A;border:none;border-radius:8px;font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap;flex-shrink:0">📅 最新期</button>
    </div>
    <div id="verify-paste-hint" style="font-size:11px;color:#aaa;margin-top:-10px;margin-bottom:10px"></div>
    <div class="vcard-title">或手動點選主區號碼（${pick} 個）</div>
    <div id="verify-main-grid" style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">`;

  if(isDigit){
    for(let i=0;i<range;i++){
      html += `<button class="verify-num-btn" id="vmb-${i}" onclick="toggleVerifyNum(${i})" style="background:#fff;color:#2C2C2A">${i}</button>`;
    }
  } else {
    for(let i=1;i<=range;i++){
      html += `<button class="verify-num-btn" id="vmb-${i}" onclick="toggleVerifyNum(${i})" style="background:#fff;color:#2C2C2A">${String(i).padStart(2,'0')}</button>`;
    }
  }
  html += `</div>`;

  // 第二區（威力彩）
  if(cfg.secondRange>0){
    html += `<div class="vcard-title" style="margin-top:8px">第二區（1–${cfg.secondRange}）</div>
    <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px">`;
    for(let i=1;i<=cfg.secondRange;i++){
      html += `<button class="verify-second-btn" id="vsb-${i}" onclick="toggleVerifySecond(${i})">${i}</button>`;
    }
    html += `</div>`;
  }

  // 特別號（大樂透）
  if(cfg.specialCol){
    html += `<div class="vcard-title" style="margin-top:8px">特別號（1–${cfg.mainRange}）</div>
    <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px">`;
    for(let i=1;i<=cfg.mainRange;i++){
      html += `<button class="verify-second-btn" id="vsp-${i}" onclick="toggleVerifySpecial(${i})" style="background:#fff;color:#2C2C2A;border:2px solid #ddd">${String(i).padStart(2,'0')}</button>`;
    }
    html += `</div>`;
  }

  html += `<div style="display:flex;gap:8px;align-items:center;margin-top:8px">
    <button onclick="analyzeVerify()" id="verify-go-btn"
      style="padding:10px 24px;background:${color};color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;opacity:.5"
      disabled>📊 分析這組號碼</button>
    <button onclick="clearVerify()"
      style="padding:10px 14px;background:#EDECEA;color:#5F5E5A;border:none;border-radius:8px;font-size:12px;font-family:inherit;cursor:pointer">清除</button>
    <span id="verify-count-hint" style="font-size:11px;color:#aaa">還需選 ${pick} 個號碼</span>
  </div></div>`;

  // 分析結果容器
  html += `<div id="verify-result"></div>`;

  // Google Sheets 歷史紀錄區
  html += `
  <div class="vcard" style="margin-top:8px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div class="vcard-title" style="margin:0">☁️ Google Sheets 歷史紀錄</div>
      <div style="display:flex;gap:5px">
        <button onclick="loadGSHistory('verify_log')"
          style="font-size:11px;padding:4px 10px;border:1px solid #ddd;border-radius:5px;background:none;cursor:pointer;color:#888">開獎驗證</button>
        <button onclick="loadGSHistory('gen_history')"
          style="font-size:11px;padding:4px 10px;border:1px solid #ddd;border-radius:5px;background:none;cursor:pointer;color:#888">選號紀錄</button>
      </div>
    </div>
    <div id="gs-history-cont" style="font-size:12px;color:#aaa">按上方按鈕載入雲端紀錄</div>
  </div>`;

  cont.innerHTML = html;
}

// ── 切換主區號碼 ────────────────────────────────────────
function toggleVerifyNum(n){
  const db  = DB[currentGame];
  const cfg = GAME_CFG[currentGame];
  const pick = cfg.pick;
  const color = gc(currentGame);
  const btn = document.getElementById("vmb-"+n);

  if(verifySelected.indexOf(n)>=0){
    verifySelected = verifySelected.filter(x=>x!==n);
    btn.style.background="#fff";
    btn.style.color="#2C2C2A";
    btn.style.borderColor="#ddd";
  } else {
    if(verifySelected.length>=pick) return; // 已滿
    verifySelected.push(n);
    verifySelected.sort((a,b)=>a-b);
    btn.style.background=color;
    btn.style.color="#fff";
    btn.style.borderColor=color;
  }
  updateVerifyHint();
}

function toggleVerifySecond(n){
  const prev = verifySecond;
  if(prev!==null){
    const pb = document.getElementById("vsb-"+prev);
    if(pb){ pb.style.background=""; pb.style.color=""; pb.classList.remove("selected"); }
  }
  if(prev===n){ verifySecond=null; }
  else {
    verifySecond=n;
    const nb = document.getElementById("vsb-"+n);
    if(nb){ nb.classList.add("selected"); }
  }
  updateVerifyHint();
}

function toggleVerifySpecial(n){
  const prev = verifySpecial;
  if(prev!==null){
    const pb = document.getElementById("vsp-"+prev);
    if(pb){ pb.style.background="#fff"; pb.style.color="#2C2C2A"; pb.style.borderColor="#ddd"; }
  }
  if(prev===n){ verifySpecial=null; }
  else {
    verifySpecial=n;
    const nb = document.getElementById("vsp-"+n);
    if(nb){ nb.style.background="#378ADD"; nb.style.color="#fff"; nb.style.borderColor="#378ADD"; }
  }
  updateVerifyHint();
}

function updateVerifyHint(){
  const cfg = GAME_CFG[currentGame];
  const pick = cfg.pick;
  const remaining = pick - verifySelected.length;
  const hint = document.getElementById("verify-count-hint");
  const btn  = document.getElementById("verify-go-btn");
  if(!hint||!btn) return;
  if(remaining>0){
    hint.textContent = "還需選 "+remaining+" 個號碼";
    btn.disabled = true; btn.style.opacity = ".5";
  } else {
    hint.textContent = "✓ 已選 "+pick+" 個號碼";
    btn.disabled = false; btn.style.opacity = "1";
  }
}

function clearVerify(){
  renderVerify();
}

// ── 貼上文字即時 hint ───────────────────────────────────
function onVerifyPasteInput(el){
  const hint = document.getElementById("verify-paste-hint");
  if(!hint) return;
  const val = el.value.trim();
  if(!val){ hint.textContent=""; return; }
  // 快速預覽抽出的數字
  const nums = val.match(/\d+/g);
  if(!nums){ hint.textContent="⚠️ 找不到數字"; return; }
  hint.textContent = "偵測到數字：" + nums.join("、") + "　← 按 Enter 或「解析」";
}

// ── 解析貼上文字 ────────────────────────────────────────
function parseVerifyPaste(){
  if(!currentGame || !DB[currentGame]) return;
  const cfg   = GAME_CFG[currentGame];
  const color = gc(currentGame);
  const input = document.getElementById("verify-paste-input");
  const hint  = document.getElementById("verify-paste-hint");
  if(!input) return;

  const raw = input.value.trim();
  if(!raw){ if(hint) hint.textContent="⚠️ 請先貼上號碼文字"; return; }

  // ── 解析策略 ──
  // 支援：逗號、頓號、空格、斜線分隔數字
  // 嘗試識別「第二區」「特別號」關鍵字後面的數字
  let mainNums = [];
  let secondNum = null;
  let specialNum = null;

  // 先找第二區
  const secondMatch = raw.match(/第二區[^\d]*(\d+)/);
  if(secondMatch) secondNum = parseInt(secondMatch[1]);

  // 先找特別號
  const specialMatch = raw.match(/特別號[^\d]*(\d+)/);
  if(specialMatch) specialNum = parseInt(specialMatch[1]);

  // 剩餘部分抽主區數字
  // 去掉已識別的第二區/特別號後面的數字段
  let mainText = raw;
  if(secondMatch) mainText = mainText.replace(secondMatch[0], " ");
  if(specialMatch) mainText = mainText.replace(specialMatch[0], " ");

  const allNums = (mainText.match(/\d+/g)||[]).map(Number).filter(n=>{
    if(cfg.isDigit) return n>=0 && n<cfg.mainRange;
    return n>=1 && n<=cfg.mainRange;
  });

  // 去重、取前 pick 個
  const seen = new Set();
  for(const n of allNums){
    if(!seen.has(n)){ seen.add(n); mainNums.push(n); }
    if(mainNums.length>=cfg.pick) break;
  }

  // ── 驗證 ──
  if(mainNums.length !== cfg.pick){
    if(hint) hint.textContent = `⚠️ 主區需要 ${cfg.pick} 個號碼，目前解析出 ${mainNums.length} 個（${mainNums.join("、")}）`;
    return;
  }

  // ── 套用到選號 UI ──
  // 先清空
  verifySelected = [];
  verifySecond   = null;
  verifySpecial  = null;

  // 清除所有按鈕狀態
  const allNums2 = cfg.isDigit
    ? Array.from({length:cfg.mainRange},(_,i)=>i)
    : Array.from({length:cfg.mainRange},(_,i)=>i+1);
  allNums2.forEach(n=>{
    const btn = document.getElementById("vmb-"+n);
    if(btn){ btn.style.background="#fff"; btn.style.color="#2C2C2A"; btn.style.borderColor="#ddd"; }
  });

  // 套用主區
  mainNums.forEach(n=>{
    verifySelected.push(n);
    const btn = document.getElementById("vmb-"+n);
    if(btn){ btn.style.background=color; btn.style.color="#fff"; btn.style.borderColor=color; }
  });

  // 套用第二區
  if(secondNum!==null && cfg.secondRange>0 && secondNum>=1 && secondNum<=cfg.secondRange){
    verifySecond = secondNum;
    const sb = document.getElementById("vsb-"+secondNum);
    if(sb) sb.classList.add("selected");
  }

  // 套用特別號
  if(specialNum!==null && cfg.specialCol && specialNum>=1 && specialNum<=cfg.mainRange){
    verifySpecial = specialNum;
    const sp = document.getElementById("vsp-"+specialNum);
    if(sp){ sp.style.background="#378ADD"; sp.style.color="#fff"; sp.style.borderColor="#378ADD"; }
  }

  // 更新 hint 和按鈕狀態
  let okMsg = `✅ 已選入：${mainNums.map(n=>String(n).padStart(2,'0')).join("、")}`;
  if(secondNum!==null && cfg.secondRange>0) okMsg += `　第二區：${secondNum}`;
  if(specialNum!==null && cfg.specialCol)   okMsg += `　特別號：${specialNum}`;
  if(hint) { hint.textContent=okMsg; hint.style.color="#3B6D11"; }

  updateVerifyHint();

  // 如果齊了直接分析
  if(verifySelected.length === cfg.pick){
    analyzeVerify();
  }
}

// ── 核心：分析選定號碼 ──────────────────────────────────
function analyzeVerify(){
  const db    = DB[currentGame];
  const cfg   = GAME_CFG[currentGame];
  const color = gc(currentGame);
  const nums  = verifySelected.slice();
  if(nums.length !== cfg.pick) return;

  // 確保分佈已建立
  if(!db.isDigit && !patternDistCache[currentGame]){
    patternDistCache[currentGame] = buildPatternDist(currentGame);
  }

  const result = document.getElementById("verify-result");
  if(!result) return;

  // ── 1. 號碼球展示 ──
  const ballsHtml = nums.map(n=>{
    const isD = cfg.isDigit;
    return `<span class="${isD?'ball-digit':'ball'}" style="background:${color}">${String(n).padStart(isD?1:2,'0')}</span>`;
  }).join("");
  let secondHtml = "";
  if(verifySecond!==null) secondHtml += `<span class="plus-sign">+</span><span class="ball-second">${String(verifySecond).padStart(2,'0')}</span>`;
  if(verifySpecial!==null) secondHtml += `<span class="plus-sign">特</span><span class="ball-second" style="background:#3B6D11">${String(verifySpecial).padStart(2,'0')}</span>`;

  // ── 2. 規律指數 ──
  let pScore=null, pPct=null, pRat=null;
  if(!db.isDigit){
    pScore = calcComboPatternScore(nums, db);
    pPct   = getPercentile(pScore, patternDistCache[currentGame]||[]);
    pRat   = patternRating(pPct);
  }

  // ── 3. 共現分數 ──
  const co = coScore(nums);

  // ── 4. 每個號碼的規律狀態 ──
  function numDetail(n){
    if(db.isDigit) return null;
    const iv = db.intervals[n]||{avg:0,std:1,lastGap:0};
    const tr = db.trend[n]||{state:"➡️平穩",score:0,r20:0,rAll:0};
    const st = db.streaks[n]||{curType:"miss",curStreak:0};
    const freq = db.freq[n]||0;
    const total = db.total;
    const avgFreq = total*cfg.pick/cfg.mainRange;

    // 間隔狀態
    const z = iv.std>0?(iv.lastGap-iv.avg)/iv.std:0;
    let gapState, gapColor;
    if(z>=2)      { gapState="🟠 嚴重超期"; gapColor="#BA7517"; }
    else if(z>=1) { gapState="🔶 偏晚出現"; gapColor="#D85A30"; }
    else if(z>=-1){ gapState="✅ 正常範圍"; gapColor="#3B6D11"; }
    else          { gapState="🔵 剛出現過"; gapColor="#185FA5"; }

    // 熱冷
    const heatLabel = tr.state;
    const freqLabel = freq>=avgFreq*1.2?"🔥熱號":freq<=avgFreq*0.8?"❄️冷號":"⚖️中性";

    return { n, iv, tr, st, freq, total, avgFreq, z, gapState, gapColor, heatLabel, freqLabel };
  }

  const details = nums.map(numDetail).filter(Boolean);

  // ── 5. 強配對命中 ──
  const hitPairs = [];
  if(db.topPairs && db.topPairs.length){
    for(const pr of db.topPairs.slice(0,10)){
      if(nums.indexOf(pr.a)>=0 && nums.indexOf(pr.b)>=0){
        hitPairs.push(pr);
      }
    }
  }

  // ── 6. 策略模擬（哪個策略「方向相符」）──
  // 用各策略的特徵判斷中獎號碼落在哪裡
  function stratFit(stratId, numsArr){
    const total=db.total, pick=cfg.pick, range=cfg.mainRange;
    const avgFreq=total*pick/range;
    const topN=Math.ceil(range*0.3);
    const botN=Math.ceil(range*0.3);

    const allNums=db.allNums||Array.from({length:range},(_,i)=>i+1);
    const byFreq=allNums.slice().sort((a,b)=>(db.freq[b]||0)-(db.freq[a]||0));

    const hotPool  = new Set(byFreq.slice(0,topN));
    const coldPool = new Set(byFreq.slice(-botN));
    const risePool = new Set(allNums.filter(n=>{
      const tr=db.trend[n]||{rAll:0,r20:0};
      return tr.rAll>0 && (tr.r20/tr.rAll)>(1.15);
    }));

    let hits=0;
    switch(stratId){
      case "hot":  numsArr.forEach(n=>{ if(hotPool.has(n)) hits++; }); break;
      case "cold": numsArr.forEach(n=>{ if(coldPool.has(n)) hits++; }); break;
      case "bal":  numsArr.forEach(n=>{ if(hotPool.has(n)||coldPool.has(n)) hits++; }); break;
      case "rise": numsArr.forEach(n=>{ if(risePool.has(n)) hits++; }); break;
      case "ai":{
        // 真正用AI候選池比對
        const _all2 = db.allNums||Array.from({length:db.mainRange},(_,i)=>i+1);
        const _aiPool = buildAIPool(
          _all2, db.freq, db.total, db.draws||[],
          db.pairFreq||{}, Math.max(1,...Object.values(db.pairFreq||{}).map(Number)),
          pick, db.mainRange
        );
        hits = numsArr.filter(n=>_aiPool.has(n)).length;
        break;
      }
      case "rnd":  hits = Math.round(pick * pick / range * 2); break; // 期望值
    }
    return Math.min(hits, pick);
  }

  const stratResults = STRATS.map(s=>({
    ...s,
    hits: stratFit(s.id, nums)
  })).sort((a,b)=>b.hits-a.hits);

  // ══ 組合輸出 HTML ══════════════════════════════════════

  let html = ``;

  // 號碼球
  html += `<div class="vcard" style="border-top:3px solid ${color}">
    <div class="vcard-title">分析號碼</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      ${ballsHtml}${secondHtml}
    </div>`;

  // 規律指數橫幅
  if(pRat && pScore!==null){
    html += `<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;background:${pRat.bg};border-left:4px solid ${pRat.color}">
      <div>
        <div style="font-size:13px;font-weight:700;color:${pRat.color}">📊 歷史規律指數 ${pScore.toFixed(1)} — ${pRat.label}</div>
        <div style="font-size:11px;color:#888;margin-top:2px">${pRat.detail}　|　共現強度 ${co}/100</div>
      </div>
    </div>`;
  }
  html += `</div>`;

  // 每個號碼的規律分析
  if(details.length){
    html += `<div class="vcard">
      <div class="vcard-title">每個號碼的當期規律</div>`;

    details.forEach(d=>{
      const numPScore = calcNumScore(d.n, db);
      html += `
      <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f0efed;flex-wrap:wrap">
        <span class="ball" style="background:${color};width:32px;height:32px;font-size:13px;flex-shrink:0">${String(d.n).padStart(2,'0')}</span>
        <div style="min-width:80px">
          <div style="font-size:11px;font-weight:600;color:${d.gapColor}">${d.gapState}</div>
          <div style="font-size:10px;color:#aaa">距今 ${d.iv.lastGap} 期 / 平均間隔 ${d.iv.avg}</div>
        </div>
        <div style="min-width:70px">
          <div style="font-size:11px;font-weight:600;color:#5F5E5A">${d.heatLabel}</div>
          <div style="font-size:10px;color:#aaa">近20期 ${d.tr.r20}% / 全期 ${d.tr.rAll}%</div>
        </div>
        <div style="min-width:60px">
          <div style="font-size:11px;color:#888">${d.freqLabel}</div>
          <div style="font-size:10px;color:#aaa">出現 ${d.freq} 次</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div style="font-size:12px;font-weight:700;color:${color}">單號分 ${numPScore.toFixed(1)}</div>
          <div style="font-size:10px;color:#aaa">${d.st.curType==='hit'?'連中'+d.st.curStreak+'期':'連缺'+d.st.curStreak+'期'}</div>
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  // 強配對命中
  html += `<div class="vcard">
    <div class="vcard-title">強配對命中</div>`;
  if(hitPairs.length){
    html += `<div style="font-size:12px;color:#3B6D11;margin-bottom:6px">✅ 命中 ${hitPairs.length} 組歷史強配對</div>`;
    hitPairs.forEach(pr=>{
      html += `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px">
        <span class="ball" style="background:${color};width:26px;height:26px;font-size:11px">${String(pr.a).padStart(2,'0')}</span>
        <span style="color:#aaa">×</span>
        <span class="ball" style="background:${color};width:26px;height:26px;font-size:11px">${String(pr.b).padStart(2,'0')}</span>
        <span style="color:#888">同期出現 ${pr.count} 次</span>
        <span class="badge" style="background:#EAF3DE;color:#3B6D11">Top ${db.topPairs.indexOf(pr)+1}</span>
      </div>`;
    });
  } else {
    html += `<div style="font-size:12px;color:#aaa">這組號碼沒有命中前10大強配對</div>`;
  }
  html += `</div>`;

  // 策略方向吻合度
  html += `<div class="vcard">
    <div class="vcard-title">各策略方向吻合度</div>
    <div style="font-size:10px;color:#aaa;margin-bottom:8px">若用某策略，這組中獎號碼有幾個落在該策略的候選池？</div>`;

  stratResults.forEach(s=>{
    const pct = Math.round(s.hits / cfg.pick * 100);
    const barColor = pct>=80?color:pct>=50?"#BA7517":"#ccc";
    html += `<div class="strat-match-row">
      <span style="min-width:90px">${s.label}</span>
      <div style="flex:1;margin:0 8px">
        <div style="height:6px;background:#e0dedd;border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px;transition:width .4s"></div>
        </div>
      </div>
      <span style="font-size:12px;font-weight:700;color:${barColor};min-width:40px;text-align:right">${s.hits}/${cfg.pick} 顆</span>
    </div>`;
  });
  html += `</div>`;

  // 免責聲明
  html += `<div style="font-size:10px;color:#bbb;text-align:center;padding:8px 0">
    ⚠️ 以上分析為歷史統計規律回顧，與未來中獎機率完全無關。彩券為真隨機事件。
  </div>`;

  result.innerHTML = html;

  // 自動存入 Google Sheets
  saveVerifyToGS(nums, verifySecond, verifySpecial, pScore, pPct, pRat, co, stratResults);
}

// ══════════════════════════════════════════════════════
// Google Sheets 存檔功能
// ══════════════════════════════════════════════════════

// ── 儲存開獎驗證紀錄 ────────────────────────────────────
async function saveVerifyToGS(nums, second, special, pScore, pPct, pRat, co, stratResults){
  const now = new Date().toLocaleString("zh-TW", {
    year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", hour12:false
  });

  const stratMap = {};
  (stratResults||[]).forEach(s=>{ stratMap["strat_"+s.id] = s.hits; });

  const data = {
    time:      now,
    game:      currentGame,
    nums:      nums.join(","),
    second:    second!==null ? second : "",
    special:   special!==null ? special : "",
    pScore:    pScore!==null ? pScore.toFixed(1) : "",
    pPct:      pPct!==null ? pPct : "",
    pRatLabel: pRat ? pRat.label : "",
    co:        co!==null ? co : "",
    ...stratMap
  };

  const r = await gsPost("save_verify", data);

  // 在頁面底部顯示存檔狀態
  const result = document.getElementById("verify-result");
  if(result){
    const old = result.querySelector(".gs-save-status");
    if(old) old.remove();
    const el = document.createElement("div");
    el.className = "gs-save-status";
    el.style.cssText = "font-size:11px;color:#888;text-align:right;padding:4px 0 8px;";
    el.textContent = r.ok ? "✅ 已存入 Google Sheets" : "⚠️ 存檔失敗（離線模式）";
    result.appendChild(el);
  }
}

// ── 儲存選號產生紀錄 ────────────────────────────────────
async function saveGenToGS(rec){
  const now = new Date().toLocaleString("zh-TW", {
    year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", hour12:false
  });

  const data = {
    time:      now,
    game:      currentGame,
    strat:     rec.strat ? rec.strat.label : "",
    nums:      rec.nums.join(","),
    second:    rec.second!==null ? rec.second : "",
    pScore:    rec.pScore!==null ? rec.pScore.toFixed(1) : "",
    pPct:      rec.pPct!==null ? rec.pPct : "",
    pRatLabel: rec.pRat ? rec.pRat.label : "",
    co:        rec.co!==null ? rec.co : ""
  };

  await gsPost("save_gen", data);
}

// ── 讀取歷史紀錄並顯示 ──────────────────────────────────
async function loadGSHistory(sheet){
  const cont = document.getElementById("gs-history-cont");
  if(!cont) return;
  cont.innerHTML = "<div style='color:#aaa;font-size:12px;padding:8px 0'>載入中...</div>";

  const res = await gsGet(sheet, 50);
  if(!res.ok || !res.rows || !res.rows.length){
    cont.innerHTML = "<div style='color:#aaa;font-size:12px;padding:8px 0'>尚無紀錄</div>";
    return;
  }

  const color = gc(currentGame);
  const isVerify = sheet === "verify_log";

  cont.innerHTML = res.rows.map(row => {
    const nums = (row["主區號碼"]||"").split(",").filter(Boolean);
    const ballsHtml = nums.map(n =>
      `<span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${color};color:#fff;font-size:11px;font-weight:700;margin-right:2px">${String(n).padStart(2,'0')}</span>`
    ).join("");

    const second  = row["第二區"]  ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#378ADD;color:#fff;font-size:10px;font-weight:700;margin-left:4px">${row["第二區"]}</span>` : "";
    const special = row["特別號"] ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#3B6D11;color:#fff;font-size:10px;font-weight:700;margin-left:4px">${row["特別號"]}</span>` : "";

    const _pScoreV = row["規律指數(0-100)"] ?? row["規律指數"] ?? "";
    const _coV     = row["共現強度(0-100)"] ?? row["共現強度"] ?? "";
    const _stratV  = row["使用策略"] || row["策略"] || "";
    const pScore = _pScoreV !== "" ? `<span style="font-size:11px;color:#888">規律 ${_pScoreV}</span>` : "";
    const pRat   = row["規律等級"] ? `<span style="font-size:10px;padding:1px 7px;border-radius:99px;background:#EDECEA;color:#5F5E5A">${row["規律等級"]}</span>` : "";
    const co     = _coV !== "" ? `<span style="font-size:11px;color:#888">共現 ${_coV}/100</span>` : "";
    const strat  = _stratV ? `<span style="font-size:10px;padding:1px 7px;border-radius:99px;background:#EDECEA;color:#5F5E5A">${_stratV}</span>` : "";

    // 對獎結果（check_gen 寫回的欄位）
    let prize = "";
    if(row["中獎結果"]){
      const isWin = row["中獎結果"] !== "未中";
      prize = `<span style="font-size:10px;padding:1px 7px;border-radius:99px;background:${isWin?"#3B6D11":"#EDECEA"};color:${isWin?"#fff":"#999"};font-weight:${isWin?"700":"400"}">${isWin?"🎯 ":""}${row["中獎結果"]} 中${row["命中數"]}碼${row["第二區中"]==="✓"?"+二區":""}</span>`;
    } else if(_stratV){
      prize = `<span style="font-size:10px;color:#bbb">待開獎</span>`;
    }

    return `<div style="background:#fff;border-radius:8px;border:1px solid #e8e7e4;padding:10px 12px;margin-bottom:6px">
      <div style="font-size:10px;color:#aaa;margin-bottom:5px">${fmtTime(row["時間"])} ${row["彩種"]||""}</div>
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px;margin-bottom:5px">
        ${ballsHtml}${second}${special}
      </div>
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
        ${strat}${prize}${pScore}${pRat}${co}
      </div>
    </div>`;
  }).join("");
}

// ═══════════════════════════════════════════════════════════
// ① 自動抓最新開獎 — 從 GitHub CSV 取最後一期
// ═══════════════════════════════════════════════════════════

async function autoFillLatestDraw(){
  const db  = DB[currentGame];
  const btn = document.getElementById("auto-fill-btn");
  if(!db){ alert("請先載入資料"); return; }

  if(btn){ btn.disabled=true; btn.textContent="抓取中..."; }

  try{
    // 從已載入的 rows 取最後一期（已按期別排序）
    const rows = db.rows;
    if(!rows || !rows.length) throw new Error("找不到開獎資料");

    const lastRow = rows[rows.length - 1];
    const cfg     = GAME_CFG[currentGame];

    // 解析主區
    const nums = cfg.cols.map(c => parseInt(lastRow[c])||0).filter(n=>n>0);

    // 第二區
    let second  = null;
    let special = null;
    if(cfg.secondCol)  second  = parseInt(lastRow[cfg.secondCol])  || null;
    if(cfg.specialCol) special = parseInt(lastRow[cfg.specialCol]) || null;

    const period = lastRow["期別"] || "";

    // 填入貼上欄位
    const input = document.getElementById("verify-paste-input");
    if(input){
      let txt = nums.map(n=>String(n).padStart(2,"0")).join("、");
      if(second!==null)  txt += "，第二區 " + second;
      if(special!==null) txt += "，特別號 " + special;
      input.value = txt;

      // 顯示期別
      const hint = document.getElementById("verify-paste-hint");
      if(hint){ hint.textContent = "📅 " + period + " 期　← 按「解析」填入"; hint.style.color="#3B6D11"; }
    }

    if(btn){ btn.disabled=false; btn.textContent="📅 自動填入最新期"; }

  } catch(e){
    if(btn){ btn.disabled=false; btn.textContent="📅 自動填入最新期"; }
    alert("抓取失敗：" + e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// ② 回測引擎
// ═══════════════════════════════════════════════════════════

// 回測單一期（用該期之前的資料建暫時 DB）
function backtestOnePeriod(game, draws, periodIdx){
  if(periodIdx < 50) return null; // 資料太少不回測
  const cfg  = GAME_CFG[game];
  const past = draws.slice(0, periodIdx); // 不含當期
  const actual = draws[periodIdx];

  // 用過去資料快速算出所需統計
  const range   = cfg.mainRange;
  const pick    = cfg.pick;
  const allNums = cfg.isDigit
    ? Array.from({length:range},(_,i)=>i)
    : Array.from({length:range},(_,i)=>i+1);

  const freq = {};
  allNums.forEach(n=>{ freq[n]=0; });
  past.forEach(nums=>nums.forEach(n=>{ freq[n]=(freq[n]||0)+1; }));

  const total  = past.length;
  const w20    = past.slice(-20);
  const w50    = past.slice(-50);
  const fRate  = (arr,n)=>arr.length?arr.filter(nums=>nums.indexOf(n)>=0).length/arr.length:0;
  const rAllMap={}, r20Map={}, r50Map={};
  allNums.forEach(n=>{
    rAllMap[n]=fRate(past,n);
    r20Map[n] =fRate(w20,n);
    r50Map[n] =fRate(w50,n);
  });

  const topN = Math.ceil(range*0.3);
  const botN = Math.ceil(range*0.3);
  const byFreq = allNums.slice().sort((a,b)=>(freq[b]||0)-(freq[a]||0));
  const hotPool  = new Set(byFreq.slice(0,topN));
  const coldPool = new Set(byFreq.slice(-botN));
  const risePool = new Set(allNums.filter(n=>{
    const rAll=rAllMap[n], r20=r20Map[n];
    return rAll>0 && (r20/rAll)>1.15;
  }));

  // 配對頻率（用於 AI）
  const pf={};
  past.forEach(nums=>{
    const s=nums.slice().sort((a,b)=>a-b);
    for(let i=0;i<s.length;i++)for(let j=i+1;j<s.length;j++){
      const k=s[i]+","+s[j]; pf[k]=(pf[k]||0)+1;
    }
  });
  const pmx=Math.max(1,...Object.values(pf));

  // 計算每個候選號碼的 AI 權重
  const aiWeight={};
  allNums.forEach(n=>{
    aiWeight[n] = (freq[n]||0)/Math.max(1,...Object.values(freq));
  });

  function countHits(pool){
    return actual.filter(n=>pool.has(n)).length;
  }

  // 竄升派：近50期出現率 > 全期平均 × 1.15
  const hotHits  = countHits(hotPool);
  const coldHits = countHits(coldPool);
  const balHits  = actual.filter(n=>hotPool.has(n)||coldPool.has(n)).length;
  const riseHits = countHits(risePool);

  // AI加權：用完整5維評分，取前 pick*2 候選池
  const aiPool = buildAIPool(allNums, freq, total, past, pf, pmx, pick, range);
  const aiHits = countHits(aiPool);

  // 隨機期望值
  const rndExp = Math.round(pick*pick/range*10)/10;

  // 各策略候選池大小（平衡=熱∪冷）
  const balSize = new Set([...hotPool, ...coldPool]).size;

  return {
    hot:hotHits, cold:coldHits, bal:balHits, rise:riseHits, ai:aiHits, rnd:rndExp,
    pools:{ hot:hotPool.size, cold:coldPool.size, bal:balSize, rise:risePool.size, ai:aiPool.size, rnd:pick }
  };
}

// 執行完整回測
async function runBacktest(){
  const db  = DB[currentGame];
  const btn = document.getElementById("backtest-run-btn");
  const prog= document.getElementById("backtest-progress");
  const res = document.getElementById("backtest-result");
  if(!db || db.isDigit){ alert("數字型彩券不支援回測"); return; }
  if(!db.draws || db.draws.length < 100){ alert("資料不足，需要至少100期"); return; }

  if(btn){ btn.disabled=true; btn.textContent="回測中..."; }
  if(prog){ prog.style.display="block"; }
  if(res){ res.innerHTML=""; }

  const draws = db.draws;
  const total = draws.length;
  // 最多回測最近 500 期，每隔 1 期
  const startIdx = Math.max(50, total-500);
  const endIdx   = total-1;
  const count    = endIdx - startIdx;

  const sums = {hot:0,cold:0,bal:0,rise:0,ai:0,rnd:0};
  const cnt  = {hot:0,cold:0,bal:0,rise:0,ai:0,rnd:0};
  const poolSums = {hot:0,cold:0,bal:0,rise:0,ai:0,rnd:0};

  // 分批跑，避免 UI 凍結
  const BATCH = 20;
  for(let i=startIdx; i<endIdx; i+=BATCH){
    const end = Math.min(i+BATCH, endIdx);
    for(let j=i; j<end; j++){
      const r = backtestOnePeriod(currentGame, draws, j);
      if(!r) continue;
      for(const k of Object.keys(sums)){
        sums[k]+=r[k]; cnt[k]++;
        if(r.pools) poolSums[k]+=r.pools[k];
      }
    }
    // 進度
    const pct = Math.round((i-startIdx)/count*100);
    if(prog) prog.querySelector(".bt-bar").style.width = pct+"%";
    if(prog) prog.querySelector(".bt-pct").textContent = pct+"%";
    await new Promise(r=>setTimeout(r,0)); // yield to browser
  }

  if(prog) prog.style.display="none";
  if(btn){ btn.disabled=false; btn.textContent="▶ 執行回測"; }

  // 算平均
  const avgs={}, pools={};
  for(const k of Object.keys(sums)){
    avgs[k]=cnt[k]?Math.round(sums[k]/cnt[k]*100)/100:0;
    pools[k]=cnt[k]?Math.round(poolSums[k]/cnt[k]*10)/10:0;
  }
  const pick = db.pick;

  // 存到 Sheets
  const now = new Date().toLocaleString("zh-TW",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
  gsPost("save_backtest", {
    time:now, game:currentGame, periods:count,
    hot:avgs.hot, cold:avgs.cold, bal:avgs.bal,
    rise:avgs.rise, ai:avgs.ai, rnd:avgs.rnd, pick
  });

  // 存到本地快取供圖表用
  if(!btCache) btCache={};
  btCache[currentGame]={avgs,pools,pick,count,ts:Date.now()};

  renderBacktestResult(avgs, pick, count, pools);
}

let btCache = {};

function renderBacktestResult(avgs, pick, count, pools){
  const res = document.getElementById("backtest-result");
  if(!res) return;
  const color = gc(currentGame);
  const db    = DB[currentGame];
  const range = db ? db.mainRange : 1;
  pools = pools || (btCache[currentGame] && btCache[currentGame].pools) || {};

  // 公平比較：實際命中 ÷ 該候選池大小的隨機期望（倍率 1.00 = 與亂選無異）
  const stratOrder = [
    {id:"bal", label:"⚖️ 平衡派"},
    {id:"ai",  label:"🤖 AI加權派"},
    {id:"hot", label:"🔥 熱號派"},
    {id:"rise",label:"📈 竄升派"},
    {id:"rnd", label:"🎲 隨機派"},
    {id:"cold",label:"❄️ 冷號派"}
  ].map(s=>{
    const poolN = pools[s.id] || pick;
    const exp   = pick * poolN / range;             // 該池大小下的隨機期望命中
    const lift  = exp > 0 ? avgs[s.id] / exp : 0;   // 倍率
    return {...s, poolN, exp, lift};
  }).sort((a,b)=>b.lift-a.lift);

  let html = `<div class="vcard" style="border-top:3px solid ${color}">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <div class="vcard-title" style="margin:0">回測結果（近 ${count} 期・公平比較）</div>
      <div style="font-size:10px;color:#aaa">倍率 = 實際命中 ÷ 該池隨機期望</div>
    </div>
    <div style="font-size:10px;color:#888;margin-bottom:10px">
      各策略候選池大小不同，直接比命中數會誤導。倍率 1.00 代表「跟在同樣大小的池子裡亂選一模一樣」。
    </div>`;

  // 倍率刻度：以 1.0 為中線，左右各 25%
  stratOrder.forEach(s=>{
    const lift  = Math.round(s.lift*100)/100;
    const barW  = Math.max(2, Math.min(100, (s.lift - 0.75) / 0.5 * 100)); // 0.75x~1.25x 映射 0~100%
    const diff  = s.lift - 1;
    const tone  = Math.abs(diff) < 0.05 ? "#999" : (diff > 0 ? "#3B6D11" : "#A32D2D");
    html += `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f0efed">
      <span style="min-width:90px;font-size:12px">${s.label}</span>
      <div style="flex:1;height:8px;background:#e0dedd;border-radius:4px;overflow:hidden;position:relative">
        <div style="position:absolute;left:50%;top:-2px;bottom:-2px;width:2px;background:#bbb"></div>
        <div style="height:100%;width:${barW}%;background:${tone};border-radius:4px;opacity:.75;transition:width .5s"></div>
      </div>
      <span style="font-size:13px;font-weight:700;color:${tone};min-width:52px;text-align:right">${lift.toFixed(2)}x</span>
      <span style="font-size:10px;color:#aaa;min-width:150px;text-align:right">命中 ${avgs[s.id]}｜期望 ${Math.round(s.exp*100)/100}｜池 ${s.poolN} 個</span>
    </div>`;
  });

  html += `<div style="font-size:10px;color:#aaa;margin-top:8px;text-align:center">
    中線 = 1.00x（純隨機）。所有策略長期都會貼著中線，這就是「彩券無法預測」的實驗證據。
  </div></div>`;

  res.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════
// ③ 歷史趨勢分頁
// ═══════════════════════════════════════════════════════════

function renderTrend(){
  const cont = document.getElementById("trend-content");
  if(!cont) return;
  const db    = DB[currentGame];
  const color = gc(currentGame);

  if(!db){
    cont.innerHTML = "<div style='color:#aaa;font-size:13px;padding:20px 0;text-align:center'>請先載入彩券資料</div>";
    return;
  }

  let html = `
  <div style="margin-bottom:12px">
    <div style="font-size:14px;font-weight:700;color:${color};margin-bottom:3px">📈 歷史趨勢分析</div>
    <div style="font-size:11px;color:#888">策略回測 + 雲端紀錄視覺化</div>
  </div>

  <!-- 回測區塊 -->
  <div class="vcard">
    <div class="vcard-title">策略回測（歷史命中率）</div>
    <div style="font-size:11px;color:#888;margin-bottom:10px">
      用過去每一期開獎前的資料，模擬各策略的候選池，統計實際中獎號碼有幾顆落在裡面
    </div>
    <div id="backtest-progress" style="display:none;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="font-size:11px;color:#888">回測進度</span>
        <span class="bt-pct" style="font-size:11px;font-weight:700;color:${color}">0%</span>
      </div>
      <div style="height:6px;background:#e0dedd;border-radius:3px;overflow:hidden">
        <div class="bt-bar" style="height:100%;width:0%;background:${color};border-radius:3px;transition:width .2s"></div>
      </div>
    </div>
    <button id="backtest-run-btn" onclick="runBacktest()"
      style="padding:10px 24px;background:${color};color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer">
      ▶ 執行回測
    </button>
    <div id="backtest-result" style="margin-top:12px"></div>
  </div>

  <!-- Sheets 開獎驗證歷史 -->
  <div class="vcard" style="margin-top:8px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div class="vcard-title" style="margin:0">☁️ 雲端開獎驗證紀錄</div>
      <button onclick="loadTrendHistory()"
        style="font-size:11px;padding:4px 12px;border:1px solid #ddd;border-radius:5px;background:none;cursor:pointer;color:#888">
        載入
      </button>
    </div>
    <div id="trend-history-cont" style="font-size:12px;color:#aaa">按「載入」讀取 Google Sheets 紀錄</div>
  </div>`;

  cont.innerHTML = html;

  // 如果有快取的回測結果，直接顯示
  if(btCache[currentGame]){
    const c = btCache[currentGame];
    renderBacktestResult(c.avgs, c.pick, c.count, c.pools);
  }
}

async function loadTrendHistory(){
  const cont  = document.getElementById("trend-history-cont");
  if(!cont) return;
  cont.innerHTML = "<div style='color:#aaa;font-size:12px;padding:8px 0'>載入中...</div>";

  const res = await gsGet("verify_log", 100);
  if(!res.ok || !res.rows || !res.rows.length){
    cont.innerHTML = "<div style='color:#aaa;font-size:12px;padding:8px 0'>尚無雲端紀錄</div>";
    return;
  }

  // 只顯示目前彩種
  const rows = res.rows.filter(r=>r["彩種"]===currentGame);
  if(!rows.length){
    cont.innerHTML = "<div style='color:#aaa;font-size:12px;padding:8px 0'>目前彩種尚無紀錄</div>";
    return;
  }

  const color = gc(currentGame);
  const pick  = DB[currentGame].pick;

  // 簡易折線圖：規律指數 + 策略命中
  const labels   = rows.map((_,i)=>"#"+(rows.length-i));
  const pScores  = rows.map(r=>parseFloat(r["規律指數(0-100)"])||0);
  const balHits  = rows.map(r=>parseInt(r["平衡派命中"])||0);
  const aiHits   = rows.map(r=>parseInt(r["AI加權派命中"])||0);

  // SVG 折線圖
  const W=680, H=140, PAD=36;
  const n=rows.length;
  function toX(i){ return PAD + (W-PAD*2)/(Math.max(n-1,1)) * i; }
  function toY(v,mn,mx){ return H-PAD - (H-PAD*2)*((v-mn)/Math.max(mx-mn,1)); }

  function polyline(vals, mn, mx, clr, dash=""){
    const pts=vals.map((v,i)=>toX(i)+","+toY(v,mn,mx)).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${clr}" stroke-width="2" stroke-dasharray="${dash}" stroke-linejoin="round"/>`;
  }
  function dots(vals, mn, mx, clr){
    return vals.map((v,i)=>`<circle cx="${toX(i)}" cy="${toY(v,mn,mx)}" r="3" fill="${clr}"/>`).join("");
  }

  const allV = [...pScores];
  const mn=0, mx=100;

  const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:680px;display:block;margin-bottom:8px">
    <!-- 背景格線 -->
    ${[0,25,50,75,100].map(v=>`
      <line x1="${PAD}" y1="${toY(v,mn,mx)}" x2="${W-PAD}" y2="${toY(v,mn,mx)}" stroke="#e8e7e4" stroke-width="1"/>
      <text x="${PAD-4}" y="${toY(v,mn,mx)+4}" font-size="9" fill="#bbb" text-anchor="end">${v}</text>
    `).join("")}
    <!-- 規律指數 -->
    ${polyline(pScores,mn,mx,color)}
    ${dots(pScores,mn,mx,color)}
    <!-- 圖例 -->
    <line x1="${PAD}" y1="${H-10}" x2="${PAD+20}" y2="${H-10}" stroke="${color}" stroke-width="2"/>
    <text x="${PAD+24}" y="${H-6}" font-size="10" fill="${color}">規律指數</text>
  </svg>`;

  // 表格
  const tableRows = rows.map((r,i)=>{
    const nums = (r["主區號碼"]||"").split(",").filter(Boolean);
    const ballsHtml = nums.map(n=>`<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${color};color:#fff;font-size:10px;font-weight:700;margin-right:2px">${String(n).padStart(2,"0")}</span>`).join("");
    const second = r["第二區"]&&r["第二區"]!=="—"?`<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#378ADD;color:#fff;font-size:10px;font-weight:700;margin-left:2px">${r["第二區"]}</span>`:"";
    const balV = parseInt(r["平衡派命中"])||0;
    const aiV  = parseInt(r["AI加權派命中"])||0;
    const best = Math.max(balV,aiV,parseInt(r["熱號派命中"])||0);
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f0efed;flex-wrap:wrap">
      <span style="font-size:10px;color:#aaa;min-width:110px">${fmtTime(r["時間"])}</span>
      <div style="display:flex;align-items:center;gap:2px">${ballsHtml}${second}</div>
      <span style="font-size:11px;font-weight:700;color:${color};margin-left:auto">規律 ${r["規律指數(0-100)"]||""}</span>
      <span style="font-size:11px;color:#888">最高命中 ${best}/${pick}</span>
    </div>`;
  }).join("");

  cont.innerHTML = svg + tableRows;
}

// ═══════════════════════════════════════════════════════════
