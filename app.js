// メモ帳ペイント 本体スクリプト
(function(){
  const wrap = document.getElementById('wrap');
  const sheet = document.getElementById('sheet');
  const textEl = document.getElementById('text');
  const canvas = document.getElementById('ink');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('status');
  // show=true のときだけ表示（エラー・読み込み中）。それ以外は非表示
  function setStatus(text, show){
    statusEl.textContent = text;
    statusEl.classList.toggle('show', !!show);
  }
  const toggleBtn = document.getElementById('toggleDraw');
  const inkbar = document.getElementById('inkbar');
  const textbar = document.getElementById('textbar');
  const fontSizeInput = document.getElementById('fontSize');
  const fontSizeLabel = document.getElementById('fontSizeLabel');
  const boldToggle = document.getElementById('boldToggle');
  const gridRowsInput = document.getElementById('gridRows');
  const gridColsInput = document.getElementById('gridCols');
  const tabbarEl = document.getElementById('tabbar');
  const imagesLayerEl = document.getElementById('imagesLayer');

  let drawMode = false;
  let tool = 'pen';
  let currentColor = '#1a1a1a';
  // 太さは3段階。ペンと消しゴムで別々に覚える（直線・グリッドはペンの太さ）
  const PEN_SIZES = [2, 4, 8];
  const ERASER_SIZES = [10, 24, 48];
  let penSizeIdx = 1, eraserSizeIdx = 1;
  try{
    const p = parseInt(localStorage.getItem('notepad-pen-size'), 10);
    const e = parseInt(localStorage.getItem('notepad-eraser-size'), 10);
    if(p >= 0 && p <= 2) penSizeIdx = p;
    if(e >= 0 && e <= 2) eraserSizeIdx = e;
  }catch(err){ /* 無視 */ }
  function penWidth(){ return PEN_SIZES[penSizeIdx]; }
  function eraserWidth(){ return ERASER_SIZES[eraserSizeIdx]; }
  let isDrawing = false;
  let lastX = 0, lastY = 0;
  const undoStack = [];
  const redoStack = [];
  const DPR = window.devicePixelRatio || 1;

  // ---------- 複数メモ（タブ）の状態 ----------
  // 各メモは { id, title, text, ink(Blob), inkW, inkH, inkDPR, fontSize, bold, images:[{id,x,y,w,h,src}] }
  let notes = [];
  let activeIndex = 0;
  // タブ切り替え・追加・削除の途中（キャンバスが読み込み途中）かどうか。この間は自動保存しない
  let busy = false;

  function genId(){
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function makeEmptyNote(){
    return {
      id: genId(),
      title: null,
      text: '',
      ink: null, inkW: 0, inkH: 0, inkDPR: DPR,
      fontSize: 19,
      bold: true,
      images: [],
      layersV2: true // 画像ごとの手書きレイヤー方式
    };
  }

  // 「紙」の現在の高さ（論理px）。手書き・文字・画像がこの1枚の中で共存し、
  // wrap全体がスクロールすることで、すべてが常に連動して動く。
  let currentSheetHeight = 0;

  // ---------- キャンバス全体のコピー・消去 ----------
  // 拡大縮小で絵がずれないよう、変換を外して「実ピクセル同士で1:1」でコピーする。
  // （以前は wrap.clientWidth を描画先の幅にしていたため、キャンバスの実際の幅と
  //   少しでも違うと、そのたびに絵が横に引き伸ばされていた）
  function clearInkCanvas(){
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
  function blitToInk(src){
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }
  function setCanvasPhysicalSize(pw, ph){
    canvas.width = pw;
    canvas.height = ph;
    canvas.style.width = (pw / DPR) + 'px';
    canvas.style.height = (ph / DPR) + 'px';
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(DPR, DPR);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    currentSheetHeight = ph / DPR;
    sheet.style.height = currentSheetHeight + 'px';
  }

  // ---------- キャンバスの高さ上限 ----------
  // ブラウザのキャンバスには大きさの上限があり（Chrome等は一辺約32,000px、iPhoneのSafariは面積で約1,600万px）、
  // 超えるとキャンバスが壊れて手書きが保存できなくなる。実際に小さなキャンバスで試して上限を調べ、それ以上は伸ばさない。
  const HARD_MAX_PX = 32000;
  const maxPhysHCache = {};
  function probeCanvas(w, h){
    try{
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      if(!x){ c.width = c.height = 0; return false; }
      x.fillStyle = '#000';
      x.fillRect(w - 1, h - 1, 1, 1);
      const ok = x.getImageData(w - 1, h - 1, 1, 1).data[3] === 255;
      c.width = c.height = 0; // メモリをすぐ解放
      return ok;
    }catch(e){
      return false;
    }
  }
  function getMaxPhysH(pw){
    pw = Math.max(1, Math.round(pw));
    if(maxPhysHCache[pw]) return maxPhysHCache[pw];
    let result = HARD_MAX_PX;
    if(!probeCanvas(pw, HARD_MAX_PX)){
      // 上限より小さい環境（主にiPhone）では二分探索で使える高さを探す
      let lo = 1000, hi = HARD_MAX_PX;
      while(hi - lo > 64){
        const mid = Math.floor((lo + hi) / 2);
        if(probeCanvas(pw, mid)) lo = mid; else hi = mid;
      }
      result = lo;
    }
    maxPhysHCache[pw] = result;
    return result;
  }
  // 小さいうちはどのブラウザでも安全なので調べない（調べるときに一時的に大きなメモリを使うため）
  function maxPhysHFor(pw, ph){
    return (ph > 8000 || pw * ph > 16000000) ? getMaxPhysH(pw) : Infinity;
  }
  // 紙として使える最大の高さ（論理px）
  function maxSheetHeight(){
    return Math.floor(getMaxPhysH(Math.max(canvas.width, Math.round(wrap.clientWidth * DPR))) / DPR);
  }
  const heightWarned = new Set();
  function warnHeightLimit(){
    const note = notes[activeIndex];
    const key = note ? note.id : '_';
    if(heightWarned.has(key)) return;
    heightWarned.add(key);
    setTimeout(()=> alert('このメモは長さの上限に達しました。これより下には手書きできません。\n続きは新しいタブを使ってください。'), 0);
  }

  // ---------- キャンバス（＝紙）のサイズ変更。既存の絵は伸縮させず、そのままの位置で保持 ----------
  // 幅は狭めない（ウィンドウを狭めたときに右側の手書きが切り取られて消えるのを防ぐ）。
  function resizeCanvasTo(newW, newH){
    const pw = Math.max(Math.round(newW * DPR), canvas.width);
    let ph = Math.round(newH * DPR);
    const maxH = maxPhysHFor(pw, ph);
    if(ph > maxH){
      ph = maxH;
      if(notes.length) warnHeightLimit();
    }
    if(pw === canvas.width && ph === canvas.height) return;

    let backup = null;
    if(canvas.width > 0 && canvas.height > 0){
      backup = document.createElement('canvas');
      backup.width = canvas.width;
      backup.height = canvas.height;
      backup.getContext('2d').drawImage(canvas, 0, 0);
    }

    setCanvasPhysicalSize(pw, ph);
    if(backup) blitToInk(backup);
  }

  function growCanvasTo(newHeightLogical){
    if(newHeightLogical <= currentSheetHeight) return;
    resizeCanvasTo(wrap.clientWidth, newHeightLogical);
  }

  // タブ切り替え専用：前のメモの絵を引き継がず、まっさらな状態からそのメモのinkを読み込む
  function resetCanvasForNote(note){
    const inkDPR = note.inkDPR || DPR;
    const targetW = Math.max(note.inkW || 0, wrap.clientWidth);
    const targetH = Math.max(note.inkH || 0, wrap.clientHeight);
    const pw = Math.round(targetW * DPR);
    const ph = Math.round(targetH * DPR);
    setCanvasPhysicalSize(pw, Math.min(ph, maxPhysHFor(pw, ph)));
    clearInkCanvas();

    if(note.ink){
      return new Promise((resolve)=>{
        const url = URL.createObjectURL(note.ink);
        const img = new Image();
        img.onload = ()=>{
          if(inkDPR === DPR){
            blitToInk(img); // 保存時と同じ倍率なら実ピクセルのままコピー
          } else {
            // 別の倍率のモニターで保存したものは論理サイズを合わせて描く
            ctx.globalCompositeOperation = 'source-over';
            ctx.drawImage(img, 0, 0, img.naturalWidth / inkDPR, img.naturalHeight / inkDPR);
          }
          URL.revokeObjectURL(url);
          resolve();
        };
        img.onerror = ()=>{ URL.revokeObjectURL(url); resolve(); };
        img.src = url;
      });
    }
    return Promise.resolve();
  }

  // テキスト・画像の内容量から必要な高さを測り、足りなければ紙を伸ばす（縮めることはしない）
  function measureAndGrow(){
    const prevHeight = textEl.style.height;
    textEl.style.height = 'auto';
    const contentH = textEl.scrollHeight;
    textEl.style.height = prevHeight || '100%';
    let desired = Math.max(contentH + 20, wrap.clientHeight, currentSheetHeight);
    const note = notes[activeIndex];
    if(note){
      note.images.forEach(im=>{ desired = Math.max(desired, im.y + im.h + 40); });
    }
    growCanvasTo(desired);
    textEl.style.height = '100%';
  }

  function initCanvasSize(){
    resizeCanvasTo(wrap.clientWidth, wrap.clientHeight);
  }
  initCanvasSize();

  let resizeTimer;
  window.addEventListener('resize', ()=>{
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(()=>{
      resizeCanvasTo(wrap.clientWidth, Math.max(currentSheetHeight, wrap.clientHeight));
      measureAndGrow();
    }, 150);
  });

  // ---------- 手書きモードの切り替え ----------
  function setDrawMode(on){
    drawMode = on;
    toggleBtn.classList.toggle('active', on);
    inkbar.classList.toggle('hidden', !on);
    textbar.classList.toggle('hidden', on);
    canvas.classList.toggle('draw-pen', on && tool==='pen');
    canvas.classList.toggle('draw-eraser', on && tool==='eraser');
    canvas.classList.toggle('draw-line', on && tool==='line');
    canvas.classList.toggle('draw-grid', on && tool==='grid');
    textEl.readOnly = on;
    if(on) deselectAllImages();
    if(!on) textEl.focus();
  }
  toggleBtn.addEventListener('click', ()=>setDrawMode(!drawMode));

  document.querySelectorAll('.inkbar button.tool').forEach(b=>{
    b.addEventListener('click', ()=>{
      tool = b.dataset.tool;
      document.querySelectorAll('.inkbar button.tool').forEach(x=>x.classList.toggle('active', x===b));
      canvas.classList.toggle('draw-pen', drawMode && tool==='pen');
      canvas.classList.toggle('draw-eraser', drawMode && tool==='eraser');
      canvas.classList.toggle('draw-line', drawMode && tool==='line');
      canvas.classList.toggle('draw-grid', drawMode && tool==='grid');
      showSizeButtons();
    });
  });
  document.querySelectorAll('.swatch').forEach(s=>{
    s.addEventListener('click', ()=>{
      currentColor = s.dataset.color;
      document.querySelectorAll('.swatch').forEach(x=>x.classList.remove('selected'));
      s.classList.add('selected');
    });
  });
  // 太さボタン：消しゴム選択中は消しゴムの太さ、それ以外はペンの太さを表示・変更する
  const sizeBtns = Array.from(document.querySelectorAll('.inkbar button.size'));
  function showSizeButtons(){
    const idx = (tool === 'eraser') ? eraserSizeIdx : penSizeIdx;
    sizeBtns.forEach(b => b.classList.toggle('active', parseInt(b.dataset.i, 10) === idx));
    // ラベルの長さを変えるとボタンの位置がずれるので、文言は固定でツールチップだけ変える
    document.getElementById('sizeLabel').title = (tool === 'eraser') ? '消しゴムの太さ' : 'ペンの太さ';
  }
  sizeBtns.forEach(b=>{
    b.addEventListener('click', ()=>{
      const i = parseInt(b.dataset.i, 10);
      try{
        if(tool === 'eraser'){ eraserSizeIdx = i; localStorage.setItem('notepad-eraser-size', String(i)); }
        else { penSizeIdx = i; localStorage.setItem('notepad-pen-size', String(i)); }
      }catch(err){ /* 保存できなくても動作はする */ }
      showSizeButtons();
    });
  });
  showSizeButtons();

  // ---------- 文字サイズ・太字 ----------
  function applyFontSize(px){
    textEl.style.fontSize = px + 'px';
    fontSizeLabel.textContent = px + 'px';
  }
  function applyBold(on){
    textEl.style.fontWeight = on ? '700' : '400';
  }
  fontSizeInput.addEventListener('input', ()=>{
    applyFontSize(fontSizeInput.value);
    measureAndGrow();
    scheduleSave();
  });
  boldToggle.addEventListener('change', ()=>{
    applyBold(boldToggle.checked);
    measureAndGrow();
    scheduleSave();
  });

  // ---------- タブ（複数メモ）のUI ----------
  function tabTitle(note, idx){
    if(note.title) return note.title;
    const firstLine = (note.text || '').split('\n')[0].trim();
    if(!firstLine) return `メモ${idx+1}`;
    return firstLine.length > 10 ? firstLine.slice(0,10) + '…' : firstLine;
  }

  function renderTabs(){
    tabbarEl.innerHTML = '';
    notes.forEach((note, i)=>{
      const tab = document.createElement('div');
      tab.className = 'tab' + (i===activeIndex ? ' active' : '');
      tab.dataset.index = i;

      const label = document.createElement('span');
      label.className = 'tab-title';
      label.textContent = tabTitle(note, i);
      tab.appendChild(label);

      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'このタブを削除';
      close.addEventListener('click', (e)=>{ e.stopPropagation(); deleteTab(i); });
      tab.appendChild(close);

      tab.addEventListener('click', ()=> switchTab(i));
      tab.addEventListener('dblclick', ()=> renameTab(i));

      tabbarEl.appendChild(tab);
    });

    const addBtn = document.createElement('div');
    addBtn.className = 'tab-add';
    addBtn.textContent = '＋';
    addBtn.title = '新しいメモ';
    addBtn.addEventListener('click', addTab);
    tabbarEl.appendChild(addBtn);
  }

  function updateActiveTabLabel(){
    const el = tabbarEl.querySelector(`.tab[data-index="${activeIndex}"] .tab-title`);
    if(el) el.textContent = tabTitle(notes[activeIndex], activeIndex);
  }

  function renameTab(i){
    const note = notes[i];
    const current = note.title || tabTitle(note, i);
    const name = prompt('タブの名前', current);
    if(name === null) return;
    note.title = name.trim() || null;
    renderTabs();
    scheduleSave();
  }

  function canvasToBlob(){
    return new Promise((resolve)=>{
      canvas.toBlob((blob)=> resolve(blob), 'image/png');
    });
  }

  async function saveActiveNoteState(){
    const note = notes[activeIndex];
    if(!note) return;
    note.text = textEl.value;
    note.fontSize = parseInt(fontSizeInput.value, 10);
    note.bold = boldToggle.checked;
    // 画像ごとの手書きレイヤー（変更があったものだけ）
    for(const box of Array.from(imagesLayerEl.querySelectorAll('.img-box'))){
      if(!box._inkDirty || !box._layer) continue;
      const im = (note.images || []).find(x => x.id === box.dataset.id);
      if(!im) continue;
      box._inkDirty = false;
      const b = await new Promise(r => box._layer.toBlob(r, 'image/png'));
      if(b) im.ink = b; else box._inkDirty = true; // 失敗したら次回また保存
    }
    const inkBlob = await canvasToBlob(); // Blobとして保存（base64にしないぶん軽い）
    // 画像化に失敗したとき（キャンバスが大きすぎる等）は、前回保存した手書きを空で上書きしない
    if(!inkBlob){
      console.warn('ink toBlob failed; keeping previous ink');
      return;
    }
    note.ink = inkBlob;
    note.inkW = canvas.width / DPR;
    note.inkH = canvas.height / DPR;
    note.inkDPR = DPR;
    // note.images はドラッグ・リサイズのたびに直接更新されているのでここでは不要
  }

  async function loadNoteIntoUI(index){
    const note = notes[index];
    textEl.value = note.text || '';
    fontSizeInput.value = note.fontSize || 19;
    applyFontSize(fontSizeInput.value);
    boldToggle.checked = (note.bold !== false);
    applyBold(boldToggle.checked);
    undoStack.length = 0;
    redoStack.length = 0;

    await resetCanvasForNote(note);
    renderImagesLayer(note);
    if(!note.layersV2){
      note.layersV2 = true;
      if(migrateInkToLayers(note)) setTimeout(scheduleSave, 0);
    }
    measureAndGrow();
    wrap.scrollTop = 0;
  }

  // タブ操作中は自動保存を止め、終わってから保存し直す
  async function runTabOp(fn){
    if(busy) return;
    busy = true;
    clearTimeout(saveTimer);
    try{
      await fn();
    } finally {
      busy = false;
    }
    scheduleSave();
  }

  function switchTab(i){
    if(i === activeIndex) return;
    return runTabOp(async ()=>{
      await saveActiveNoteState();
      activeIndex = i;
      await loadNoteIntoUI(activeIndex);
      renderTabs();
    });
  }

  function addTab(){
    return runTabOp(async ()=>{
      await saveActiveNoteState();
      notes.push(makeEmptyNote());
      activeIndex = notes.length - 1;
      await loadNoteIntoUI(activeIndex);
      renderTabs();
      textEl.focus();
    });
  }

  function deleteTab(i){
    if(notes.length <= 1){
      if(!confirm('最後のタブです。内容をすべて消去しますか？')) return;
      return runTabOp(async ()=>{
        notes[0] = makeEmptyNote();
        activeIndex = 0;
        await loadNoteIntoUI(0);
        renderTabs();
      });
    }
    if(!confirm('このタブを削除しますか？')) return;
    return runTabOp(async ()=>{
      const deletingActive = (i === activeIndex);
      notes.splice(i, 1);
      if(deletingActive){
        activeIndex = Math.min(i, notes.length - 1);
        await loadNoteIntoUI(activeIndex);
      } else if(i < activeIndex){
        activeIndex -= 1;
      }
      renderTabs();
    });
  }

  // ---------- 貼り付け画像（サイズ調整可能） ----------
  // note.images[].src は Blob として保持する（base64より約27%軽い＆IndexedDB向き）。
  // 表示するときだけ URL.createObjectURL() で一時URLを作り、使い終わったら revoke する。
  function dataURLtoBlob(dataUrl){
    return fetch(dataUrl).then(r=> r.blob());
  }
  async function getImageDimsFromBlob(blob){
    if('createImageBitmap' in window){
      try{
        const bmp = await createImageBitmap(blob);
        const dims = { w: bmp.width, h: bmp.height };
        if(bmp.close) bmp.close();
        return dims;
      }catch(e){ /* フォールバックへ */ }
    }
    return new Promise((resolve)=>{
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = ()=>{ URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = ()=>{ URL.revokeObjectURL(url); resolve({ w: 300, h: 200 }); };
      img.src = url;
    });
  }

  function renderImagesLayer(note){
    imagesLayerEl.querySelectorAll('img').forEach(img=>{
      if(img._objectUrl) URL.revokeObjectURL(img._objectUrl);
    });
    imagesLayerEl.innerHTML = '';
    selOrder = [];
    (note.images || []).forEach(im => createImageBoxEl(im));
  }

  function createImageBoxEl(imgData){
    const box = document.createElement('div');
    box.className = 'img-box';
    box.dataset.id = imgData.id;
    box.style.left = imgData.x + 'px';
    box.style.top = imgData.y + 'px';
    box.style.width = imgData.w + 'px';
    box.style.height = imgData.h + 'px';

    const imgEl = document.createElement('img');
    const objectUrl = URL.createObjectURL(imgData.src);
    imgEl.src = objectUrl;
    imgEl._objectUrl = objectUrl;
    imgEl.draggable = false;
    box.appendChild(imgEl);

    // PDFのページ（以前のバージョンでは locked として保存）は見た目だけ区別する
    if(imgData.pdf || imgData.locked) box.classList.add('pdf-page');
    if(imgData.lock) box.classList.add('lock');

    // 画像の上のテキストボックス
    const textsEl = document.createElement('div');
    textsEl.className = 'img-texts';
    box.appendChild(textsEl);
    (imgData.texts || []).forEach(t => createTextBoxEl(box, imgData, t));
    if(imgData.ink) loadLayerInk(box, imgData);

    // 右クリック：標準メニューの代わりに、その位置にテキストボックスを作る
    box.addEventListener('contextmenu', (e)=>{
      e.preventDefault();
      if(e.target.closest('.img-text')) return; // テキストボックスの上では何もしない
      const r = box.getBoundingClientRect();
      addTextBox(box, imgData, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    });

    const delBtn = document.createElement('div');
    delBtn.className = 'img-del';
    delBtn.textContent = '×';
    delBtn.title = '画像を削除';
    delBtn.addEventListener('pointerdown', e=> e.stopPropagation());
    delBtn.addEventListener('click', (e)=>{ e.stopPropagation(); removeImage(imgData.id); });
    box.appendChild(delBtn);

    const handle = document.createElement('div');
    handle.className = 'img-handle';
    box.appendChild(handle);

    box.addEventListener('pointerdown', (e)=>{
      if(e.button === 1 || e.button === 2 || e.target === delBtn) return;
      if(e.target.closest('.img-text')) return; // テキストボックスの操作は別で扱う
      // 画像を触っている間は文字入力から外す（W・Deleteキーが文字として入らないように）
      const ae = document.activeElement;
      if(ae && (ae === textEl || ae.isContentEditable)) ae.blur();
      if(e.target === handle){
        if(!box.classList.contains('selected')) selectImageBox(box);
        if(!imgData.lock) startResize(e, box, imgData);
        return;
      }
      // Ctrl / Shift + クリック：複数選択に追加・解除
      if(e.ctrlKey || e.metaKey || e.shiftKey){
        e.preventDefault();
        toggleImageSelection(box);
        return;
      }
      if(!box.classList.contains('selected')) selectImageBox(box);
      if(imgData.lock){ e.preventDefault(); return; } // ロック中は動かさない
      startMove(e, box); // 選択中の画像（ロック中のものを除く）をまとめて動かす
    });

    imagesLayerEl.appendChild(box);
    return box;
  }

  // ---------- テキストボックスの文字色 ----------
  // 選んでいるテキストボックスがあればその色を変える。新しく作るテキストボックスもこの色になる。
  let textColor = '#1a1a1a';
  const tswatchEls = Array.from(document.querySelectorAll('.tswatch'));
  function showTextColor(color){
    textColor = color;
    tswatchEls.forEach(s => s.classList.toggle('selected', s.dataset.color === color));
  }
  tswatchEls.forEach(s=>{
    // 押してもテキストボックスの入力状態が外れないようにする
    s.addEventListener('pointerdown', e=> e.preventDefault());
    s.addEventListener('mousedown', e=> e.preventDefault());
    s.addEventListener('click', ()=>{
      showTextColor(s.dataset.color);
      const ae = document.activeElement;
      const el = ae && ae.classList && ae.classList.contains('tb-body') ? ae.closest('.img-text') : null;
      if(el){
        el._data.color = textColor;
        ae.style.color = textColor;
        scheduleSave();
      }
    });
  });

  // ---------- 画像の上のテキストボックス ----------
  // 位置・幅・文字サイズは「画像に対する割合」で持つので、画像を動かしたり拡大縮小しても一緒についていく。
  // imgData.texts = [{ id, rx, ry, rw, fsr, text }]  （fsr = 文字サイズ ÷ 画像の幅）
  function layoutTextBoxes(box, im){
    box.querySelectorAll('.img-text').forEach(el=>{
      const t = el._data;
      el.style.left = (t.rx * 100) + '%';
      el.style.top = (t.ry * 100) + '%';
      el.style.width = (t.rw * 100) + '%';
      el.querySelector('.tb-body').style.fontSize = (t.fsr * im.w) + 'px';
    });
  }

  function createTextBoxEl(box, im, t){
    const el = document.createElement('div');
    el.className = 'img-text';
    el.dataset.id = t.id;
    el._data = t;

    const body = document.createElement('div');
    body.className = 'tb-body';
    body.spellcheck = false;
    try{ body.contentEditable = 'plaintext-only'; }catch(err){ body.contentEditable = 'true'; }
    if(body.contentEditable !== 'plaintext-only') body.contentEditable = 'true';
    body.textContent = t.text || '';
    body.style.color = t.color || '#1a1a1a';
    el.appendChild(body);
    // テキストボックスを選んだら、文字色ボタンもその色を表示する
    body.addEventListener('focus', ()=> showTextColor(t.color || '#1a1a1a'));

    const mv = document.createElement('div');
    mv.className = 'tb-move';
    mv.title = 'ドラッグで移動';
    el.appendChild(mv);
    const wd = document.createElement('div');
    wd.className = 'tb-width';
    wd.title = 'ドラッグで幅を変更';
    el.appendChild(wd);

    body.addEventListener('input', ()=>{
      t.text = body.innerText.replace(/\n$/, '');
      measureAndGrow();
      scheduleSave();
    });
    // 貼り付けは文字だけにする（書式付きの貼り付けで見た目が崩れないように）
    body.addEventListener('paste', (e)=>{
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if(!text) return; // 画像などは通常の貼り付け処理へ
      e.preventDefault();
      e.stopPropagation();
      document.execCommand('insertText', false, text);
    });
    // 空のまま離れたら消す
    body.addEventListener('blur', ()=>{
      if(!(t.text || '').trim()) removeTextBox(box, im, t.id);
    });
    body.addEventListener('keydown', (e)=>{
      if(e.key === 'Escape') body.blur();
    });

    mv.addEventListener('pointerdown', (e)=> dragTextBox(e, el, box, im, 'move'));
    wd.addEventListener('pointerdown', (e)=> dragTextBox(e, el, box, im, 'width'));

    box.querySelector('.img-texts').appendChild(el);
    layoutTextBoxes(box, im);
    return el;
  }

  function addTextBox(box, im, rx, ry){
    const fontPx = parseInt(fontSizeInput.value, 10) || 19;
    const wPx = Math.min(220, Math.max(60, im.w * (1 - rx)));
    const t = {
      id: genId(),
      rx: Math.max(0, Math.min(rx, 0.98)),
      ry: Math.max(0, Math.min(ry, 0.98)),
      rw: wPx / im.w,
      fsr: fontPx / im.w,
      color: textColor,
      text: ''
    };
    if(!im.texts) im.texts = [];
    im.texts.push(t);
    const el = createTextBoxEl(box, im, t);
    deselectAllImages();
    el.querySelector('.tb-body').focus();
  }

  function removeTextBox(box, im, id){
    if(im.texts) im.texts = im.texts.filter(t => t.id !== id);
    const el = box.querySelector(`.img-text[data-id="${id}"]`);
    if(el) el.remove();
    scheduleSave();
  }

  function dragTextBox(e, el, box, im, mode){
    if(e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const t = el._data;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const orig = { rx: t.rx, ry: t.ry, rw: t.rw };
    function onMove(ev){
      const dx = (ev.clientX - startX) / im.w;
      const dy = (ev.clientY - startY) / im.h;
      if(mode === 'move'){
        t.rx = Math.max(-0.5, Math.min(orig.rx + dx, 0.98));
        t.ry = Math.max(-0.5, Math.min(orig.ry + dy, 0.98));
      } else {
        t.rw = Math.max(30 / im.w, orig.rw + dx);
      }
      layoutTextBoxes(box, im);
    }
    function onUp(){
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      scheduleSave();
    }
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  // ---------- 画像の選択（複数選択可） ----------
  // selOrder は選んだ順番。横幅そろえ(W)は最初に選んだ画像の幅に合わせる
  let selOrder = [];
  function boxById(id){ return imagesLayerEl.querySelector(`.img-box[data-id="${id}"]`); }
  function imgDataById(id){ return (notes[activeIndex].images || []).find(im => im.id === id); }
  function selectImageBox(box){
    deselectAllImages();
    box.classList.add('selected');
    selOrder = [box.dataset.id];
  }
  function toggleImageSelection(box){
    const id = box.dataset.id;
    if(box.classList.toggle('selected')){
      selOrder.push(id);
    } else {
      selOrder = selOrder.filter(x => x !== id);
    }
  }
  function deselectAllImages(){
    imagesLayerEl.querySelectorAll('.img-box.selected').forEach(b=> b.classList.remove('selected'));
    selOrder = [];
  }
  document.addEventListener('pointerdown', (e)=>{
    if(!e.target.closest || !e.target.closest('.img-box')){
      deselectAllImages();
    }
  }, true);

  // ---------- 画像ごとの手書きレイヤー ----------
  // 画像の上で書き始めた手書きは、その画像専用のキャンバス（画像の中に重ねる）に描く。
  // なので画像を動かしたり拡大縮小しても、その画像に書いたものだけが一緒についていき、
  // 画像を貼る前からその場所にあった書き込み（全体の手書きレイヤー）は動かない。
  // im.ink に Blob として保存。キャンバスは手書きがある画像にだけ作る（画像が多くてもメモリを食わない）。
  function ensureLayer(box, im){
    if(box._layer) return box._layer;
    const c = document.createElement('canvas');
    c.className = 'img-ink-layer';
    c.width = Math.max(1, Math.round(im.w * DPR));
    c.height = Math.max(1, Math.round(im.h * DPR));
    box.insertBefore(c, box.querySelector('.img-del'));
    box._layer = c;
    return c;
  }
  // 紙の座標（論理px）でそのまま描けるように変換を合わせた、画像レイヤーの描画コンテキスト
  function layerCtx(box, im){
    const c = ensureLayer(box, im);
    const x = c.getContext('2d');
    const sx = c.width / im.w, sy = c.height / im.h;
    x.setTransform(sx, 0, 0, sy, -im.x * sx, -im.y * sy);
    x.lineCap = 'round';
    x.lineJoin = 'round';
    return x;
  }
  async function loadLayerInk(box, im){
    if(!im.ink) return;
    const c = ensureLayer(box, im);
    try{
      let src;
      if('createImageBitmap' in window){
        src = await createImageBitmap(im.ink);
      } else {
        src = await new Promise((resolve, reject)=>{
          const url = URL.createObjectURL(im.ink);
          const img = new Image();
          img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
          img.onerror = (e)=>{ URL.revokeObjectURL(url); reject(e); };
          img.src = url;
        });
      }
      const x = c.getContext('2d');
      x.save();
      x.setTransform(1,0,0,1,0,0);
      x.drawImage(src, 0, 0, c.width, c.height);
      x.restore();
      if(src.close) src.close();
    }catch(err){
      console.warn('layer ink load failed', err);
    }
  }
  // 画像の大きさが変わったら、レイヤーの解像度も合わせ直す（描いた内容は伸縮して保つ）
  function resampleLayer(box, im){
    const c = box._layer;
    if(!c) return;
    const nw = Math.max(1, Math.round(im.w * DPR));
    const nh = Math.max(1, Math.round(im.h * DPR));
    if(nw === c.width && nh === c.height) return;
    const tmp = document.createElement('canvas');
    tmp.width = c.width; tmp.height = c.height;
    tmp.getContext('2d').drawImage(c, 0, 0);
    c.width = nw; c.height = nh;
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(tmp, 0, 0, nw, nh);
    tmp.width = tmp.height = 0;
    box._inkDirty = true;
  }
  function markLayerDirty(box){ if(box) box._inkDirty = true; }
  // (x, y) にある一番上の画像
  function imageHitAt(x, y){
    const ims = (notes[activeIndex] && notes[activeIndex].images) || [];
    for(let i = ims.length - 1; i >= 0; i--){
      const im = ims[i];
      if(x >= im.x && x <= im.x + im.w && y >= im.y && y <= im.y + im.h){
        const box = boxById(im.id);
        if(box) return { im, box };
      }
    }
    return null;
  }
  // 以前のバージョンのメモ：画像の範囲にあった手書きを、その画像のレイヤーへ一度だけ移す
  function migrateInkToLayers(note){
    const ims = note.images || [];
    let moved = false;
    for(let i = ims.length - 1; i >= 0; i--){ // 重なっている所は上の画像が受け取る
      const im = ims[i];
      const box = boxById(im.id);
      if(!box) continue;
      const px = Math.max(0, Math.floor(im.x * DPR));
      const py = Math.max(0, Math.floor(im.y * DPR));
      const pw = Math.min(canvas.width, Math.ceil((im.x + im.w) * DPR)) - px;
      const ph = Math.min(canvas.height, Math.ceil((im.y + im.h) * DPR)) - py;
      if(pw <= 0 || ph <= 0) continue;
      const data = ctx.getImageData(px, py, pw, ph).data;
      let has = false;
      for(let k = 3; k < data.length; k += 4){ if(data[k]){ has = true; break; } }
      if(!has) continue;
      const c = ensureLayer(box, im);
      const sx = c.width / (im.w * DPR), sy = c.height / (im.h * DPR);
      const x = c.getContext('2d');
      x.save();
      x.setTransform(1,0,0,1,0,0);
      x.drawImage(canvas, px, py, pw, ph, (px - im.x * DPR) * sx, (py - im.y * DPR) * sy, pw * sx, ph * sy);
      x.restore();
      ctx.save();
      ctx.setTransform(1,0,0,1,0,0);
      ctx.clearRect(px, py, pw, ph);
      ctx.restore();
      box._inkDirty = true;
      moved = true;
    }
    return moved;
  }
  // 画像の大きさを変えた後は、それ以前の手書きUndo履歴は大きさが合わなくなるので捨てる
  function afterImageTransform(resized){
    if(resized){
      undoStack.length = 0;
      redoStack.length = 0;
    }
    scheduleSave();
  }

  function startMove(e, box){
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    const items = selOrder.map(id => ({ box: boxById(id), im: imgDataById(id) }))
                          .filter(it => it.box && it.im && !it.im.lock);
    items.forEach(it=>{ it.ox = it.im.x; it.oy = it.im.y; });
    // まとめて動かしても、どの画像も紙からはみ出さない範囲に移動量を制限する
    const wrapW = wrap.clientWidth;
    const minDx = Math.max(...items.map(it => -it.ox));
    const maxDx = Math.min(...items.map(it => Math.max(0, wrapW - it.im.w) - it.ox));
    const minDy = Math.max(...items.map(it => -it.oy));
    const startX = e.clientX, startY = e.clientY;
    function onMove(ev){
      const dx = Math.max(minDx, Math.min(maxDx, ev.clientX - startX));
      const dy = Math.max(minDy, ev.clientY - startY);
      items.forEach(it=>{
        it.im.x = it.ox + dx; it.im.y = it.oy + dy;
        it.box.style.left = it.im.x + 'px';
        it.box.style.top = it.im.y + 'px';
      });
      measureAndGrow();
    }
    function onUp(){
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('pointercancel', onUp);
      measureAndGrow();
      afterImageTransform(false); // 手書きは画像の中にあるので一緒に動いている
    }
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onUp);
  }

  function startResize(e, box, imgData){
    e.preventDefault();
    e.stopPropagation();
    box.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const origW = imgData.w, origH = imgData.h;
    const aspect = origW / (origH || 1);
    function onMove(ev){
      const dx = ev.clientX - startX;
      let newW = Math.max(30, origW + dx);
      newW = Math.min(newW, Math.max(30, wrap.clientWidth - imgData.x));
      let newH;
      if(ev.shiftKey){
        const dy = ev.clientY - startY;
        newH = Math.max(30, origH + dy);
      } else {
        newH = newW / aspect;
      }
      imgData.w = newW; imgData.h = newH;
      box.style.width = newW + 'px';
      box.style.height = newH + 'px';
      layoutTextBoxes(box, imgData);
      measureAndGrow();
    }
    function onUp(){
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('pointercancel', onUp);
      measureAndGrow();
      resampleLayer(box, imgData);
      afterImageTransform(true);
    }
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onUp);
  }

  // 選んだ画像の横幅を、最初に選んだ画像の幅にそろえる（縦横比は保つ。上の手書きも一緒に伸縮）
  function alignSelectedWidths(){
    if(selOrder.length < 2) return;
    const base = imgDataById(selOrder[0]);
    if(!base) return;
    const wrapW = wrap.clientWidth;
    selOrder.slice(1).forEach(id=>{
      const im = imgDataById(id), box = boxById(id);
      if(!im || !box || im.lock) return; // ロック中の画像は大きさを変えない
      const aspect = im.w / (im.h || 1);
      im.w = base.w;
      im.h = base.w / aspect;
      if(im.x + im.w > wrapW) im.x = Math.max(0, wrapW - im.w);
      box.style.left = im.x + 'px';
      box.style.width = im.w + 'px';
      box.style.height = im.h + 'px';
      layoutTextBoxes(box, im);
      measureAndGrow();
      resampleLayer(box, im);
    });
    afterImageTransform(true);
  }

  function removeImage(id){
    const note = notes[activeIndex];
    const idx = note.images.findIndex(im => im.id === id);
    const box = boxById(id);
    if(idx >= 0){
      note.images.splice(idx, 1); // 画像の上の手書き・テキストも一緒に消える
    }
    if(box){
      const img = box.querySelector('img');
      if(img && img._objectUrl) URL.revokeObjectURL(img._objectUrl);
      box.remove();
    }
    selOrder = selOrder.filter(x => x !== id);
    afterImageTransform(false);
  }

  // pos を渡すとその位置（紙の座標）に置く。省略時は今見えている範囲の左上
  async function addImageToNote(blob, dims, pos){
    const wrapW = wrap.clientWidth;
    const maxW = Math.min(wrapW - 40, 480);
    let w = dims.w, h = dims.h;
    if(w > maxW){
      h = h * (maxW / w);
      w = maxW;
    }
    let x = 20, y = wrap.scrollTop + 20;
    if(pos){
      x = Math.max(0, Math.min(pos.x, wrapW - w));
      y = Math.max(0, pos.y);
    }
    const note = notes[activeIndex];
    const imgData = { id: genId(), x, y, w, h, src: blob };
    note.images.push(imgData);
    createImageBoxEl(imgData);
    measureAndGrow();
    selectImageBox(boxById(imgData.id));
    scheduleSave();
  }

  window.addEventListener('paste', async (e)=>{
    if(!e.clipboardData) return;
    const items = e.clipboardData.items;
    let imageFile = null;
    for(const item of items){
      if(item.kind === 'file' && item.type && item.type.startsWith('image/')){
        imageFile = item.getAsFile();
        break;
      }
    }
    if(!imageFile) return; // 画像でなければ通常のテキスト貼り付けに任せる
    e.preventDefault();
    try{
      const dims = await getImageDimsFromBlob(imageFile);
      await addImageToNote(imageFile, dims); // File(Blob)のまま保存
    }catch(err){
      console.error('image paste failed', err);
    }
  });

  // ---------- PDFの読み込み ----------
  // 各ページを画像にして新しいタブに縦に並べる（位置固定）。その上の手書きレイヤーにそのまま書き込める。
  // pdf.js (v3.11.174, lib/pdfjs に同梱＝オフラインでも動く) は初めて使うときだけ読み込む。
  const PDFJS_BASE = 'lib/pdfjs/';
  const PAGE_GAP = 16;
  const PAGE_MARGIN = 20;
  let pdfjsPromise = null;
  function loadPdfJs(){
    if(window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if(!pdfjsPromise){
      pdfjsPromise = new Promise((resolve, reject)=>{
        const s = document.createElement('script');
        s.src = PDFJS_BASE + 'pdf.min.js';
        s.onload = ()=>{
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
          resolve(window.pdfjsLib);
        };
        s.onerror = ()=>{ pdfjsPromise = null; reject(new Error('PDF読み込み機能（lib/pdfjs）が見つかりません')); };
        document.head.appendChild(s);
      });
    }
    return pdfjsPromise;
  }

  function renderPageToBlob(page, scale){
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    const cctx = c.getContext('2d');
    cctx.fillStyle = '#fff';
    cctx.fillRect(0, 0, c.width, c.height);
    return page.render({ canvasContext: cctx, viewport: vp }).promise.then(()=> new Promise((resolve)=>{
      c.toBlob((blob)=>{ c.width = c.height = 0; resolve(blob); }, 'image/jpeg', 0.92);
    }));
  }

  let pdfLoading = false;

  async function importPdf(file){
    if(pdfLoading || busy) return;
    pdfLoading = true;
    let pdf = null;
    try{
      setStatus('PDF準備中…', true);
      const pdfjs = await loadPdfJs();
      const data = new Uint8Array(await file.arrayBuffer());
      pdf = await pdfjs.getDocument({ data }).promise;

      // 表示サイズを決める：画面幅に合わせつつ、全ページの合計が紙の上限に収まるようにする
      const sizes = [];
      for(let i=1; i<=pdf.numPages; i++){
        const p = await pdf.getPage(i);
        const vp = p.getViewport({ scale: 1 });
        sizes.push({ w: vp.width, h: vp.height });
      }
      const maxSheet = maxSheetHeight() - PAGE_MARGIN * 2;
      let pageW = Math.min(wrap.clientWidth - PAGE_MARGIN * 2, 900);
      const totalAt = (w)=> sizes.reduce((s, sz)=> s + w * sz.h / sz.w + PAGE_GAP, 0);
      if(totalAt(pageW) > maxSheet){
        pageW = Math.max(400, pageW * maxSheet / totalAt(pageW));
      }
      let pageCount = 0, acc = 0;
      for(const sz of sizes){
        acc += pageW * sz.h / sz.w + PAGE_GAP;
        if(acc > maxSheet) break;
        pageCount++;
      }

      const images = [];
      let y = PAGE_MARGIN;
      for(let i=1; i<=pageCount; i++){
        setStatus(`PDF読み込み中 ${i}/${pageCount}`, true);
        const page = await pdf.getPage(i);
        const sz = sizes[i-1];
        const h = pageW * sz.h / sz.w;
        // 画面の実ピクセルより少し高めの解像度で描いておく（拡大しても文字がにじみにくい）
        const scale = Math.min(pageW * DPR * 1.5, 2400) / sz.w;
        const blob = await renderPageToBlob(page, scale);
        images.push({ id: genId(), x: PAGE_MARGIN, y, w: pageW, h, src: blob, pdf: true });
        y += h + PAGE_GAP;
        page.cleanup();
      }

      await runTabOp(async ()=>{
        await saveActiveNoteState();
        const note = makeEmptyNote();
        note.title = file.name.replace(/\.pdf$/i, '');
        note.images = images;
        notes.push(note);
        activeIndex = notes.length - 1;
        await loadNoteIntoUI(activeIndex);
        renderTabs();
      });
      setDrawMode(false);

      setStatus('保存中…', false);
      if(pageCount < pdf.numPages){
        alert(`ページ数が多いため、最初の ${pageCount} ページだけを読み込みました（全 ${pdf.numPages} ページ）。`);
      }
    }catch(err){
      console.error('pdf import failed', err);
      setStatus('', false);
      alert('PDFを開けませんでした：' + (err && err.message ? err.message : err));
    }finally{
      if(pdf) pdf.destroy();
      pdfLoading = false;
    }
  }


  // PDFファイルを画面にドラッグ＆ドロップしても開ける
  function isPdfFile(f){ return f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)); }
  wrap.addEventListener('dragover', (e)=>{
    if(!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    wrap.classList.add('drag-over');
  });
  wrap.addEventListener('dragleave', (e)=>{
    if(e.target === wrap || !wrap.contains(e.relatedTarget)) wrap.classList.remove('drag-over');
  });
  wrap.addEventListener('drop', async (e)=>{
    wrap.classList.remove('drag-over');
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
    if(!files.length) return;
    e.preventDefault(); // 対応外のファイルでもブラウザがそのファイルを開いてしまわないように

    // 画像はドロップした位置に置く（貼り付けと同じく、大きすぎるものは縮小）。複数なら少しずつずらす
    const images = files.filter(f => f.type && f.type.startsWith('image/'));
    const r = sheet.getBoundingClientRect();
    let pos = { x: e.clientX - r.left, y: e.clientY - r.top };
    for(const f of images){
      try{
        const dims = await getImageDimsFromBlob(f);
        await addImageToNote(f, dims, pos);
        pos = { x: pos.x + 24, y: pos.y + 24 };
      }catch(err){
        console.error('image drop failed', err);
      }
    }

    const pdfFile = files.find(isPdfFile);
    if(pdfFile) importPdf(pdfFile);

    const memoFile = files.find(isMemoFile);
    if(memoFile) importMemoFile(memoFile);
  });

  // ---------- メモのダウンロード（保存）・インポート（開く） ----------
  // 1つのファイルに、文字・手書き・画像/PDF（位置・大きさ・ロック）・テキストボックス（位置・幅・色）を全部入れる。
  //
  // ファイル形式（.npmemo）：
  //   [8バイト "NPMEMO02"][4バイト 目次(JSON)のバイト数][目次(JSON)][画像・手書きのデータをそのまま連結]
  // 画像は文字(base64)に変換せずそのまま詰めるので、何百枚・数GBあってもメモリをほとんど使わずに保存・読み込みできる。
  // 以前の形式（画像をbase64で埋め込んだ .json）も読み込める。
  const MEMO_FORMAT = 'notepad-paint-memo';
  const MEMO_MAGIC = 'NPMEMO02';
  const MEMO_HEAD = 12;
  function isMemoFile(f){ return f && (/\.(npmemo|json)$/i.test(f.name) || f.type === 'application/json'); }
  function safeFileName(name){
    return (name || 'memo').replace(/[\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 60) || 'memo';
  }

  // メモ → 目次（画像・手書きは addBlob で番号に置き換える）
  function noteToManifest(note, addBlob){
    return {
      title: note.title || null,
      text: note.text || '',
      fontSize: note.fontSize || 19,
      bold: note.bold !== false,
      ink: note.ink ? addBlob(note.ink) : null,
      inkW: note.inkW, inkH: note.inkH, inkDPR: note.inkDPR || DPR,
      layersV2: !!note.layersV2,
      images: (note.images || []).map(im => ({
        x: im.x, y: im.y, w: im.w, h: im.h,
        pdf: !!(im.pdf || im.locked),
        lock: !!im.lock,
        texts: (im.texts || []).map(t => ({ rx: t.rx, ry: t.ry, rw: t.rw, fsr: t.fsr, color: t.color || null, text: t.text || '' })),
        ink: im.ink ? addBlob(im.ink) : null, // 画像に書いた手書き
        src: addBlob(im.src)
      }))
    };
  }
  // 目次 → メモ（getBlob は番号または以前のdata URLからBlobを返す）
  async function manifestToNote(n, getBlob){
    return {
      id: genId(),
      title: n.title || null,
      text: n.text || '',
      fontSize: n.fontSize || 19,
      bold: n.bold !== false,
      ink: n.ink != null ? await getBlob(n.ink) : null,
      inkW: n.inkW || 0, inkH: n.inkH || 0, inkDPR: n.inkDPR || DPR,
      layersV2: !!n.layersV2, // 古いファイルは開いたときに画像レイヤーへ移し替える
      images: await Promise.all((n.images || []).map(async im => ({
        id: genId(),
        x: im.x, y: im.y, w: im.w, h: im.h,
        pdf: !!im.pdf,
        lock: !!im.lock,
        texts: (im.texts || []).map(t => ({
          id: genId(), rx: t.rx, ry: t.ry, rw: t.rw, fsr: t.fsr,
          color: t.color || '#1a1a1a', text: t.text || ''
        })),
        ink: im.ink != null ? await getBlob(im.ink) : null,
        src: await getBlob(im.src)
      })))
    };
  }

  async function exportActiveNote(){
    if(busy) return;
    try{
      setStatus('保存ファイル作成中…', true);
      await saveActiveNoteState(); // 今の手書きを確実に反映
      const note = notes[activeIndex];
      const blobs = [], table = [];
      let off = 0;
      const addBlob = (b)=>{
        table.push({ off, len: b.size, type: b.type || '' });
        blobs.push(b);
        off += b.size;
        return table.length - 1;
      };
      const manifest = {
        format: MEMO_FORMAT, version: 2, exportedAt: new Date().toISOString(),
        notes: [noteToManifest(note, addBlob)],
        blobs: table
      };
      const json = new TextEncoder().encode(JSON.stringify(manifest));
      const head = new Uint8Array(MEMO_HEAD);
      head.set(new TextEncoder().encode(MEMO_MAGIC), 0);
      new DataView(head.buffer).setUint32(8, json.length, true);
      // Blob を並べるだけなので、画像の中身はコピーされない（大きくてもメモリを食わない）
      const file = new Blob([head, json, ...blobs], { type: 'application/octet-stream' });

      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = `${safeFileName(tabTitle(note, activeIndex))}_${stamp}.npmemo`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=> URL.revokeObjectURL(a.href), 60000);
      setStatus('保存済み', false);
    }catch(err){
      console.error('export failed', err);
      setStatus('ファイル保存に失敗しました', true);
    }
  }

  async function importMemoFile(file){
    if(busy) return;
    const notMemo = ()=> alert('このファイルは読み込めません（メモ帳で保存したファイルではないようです）');
    let manifestNotes, getBlob;
    try{
      setStatus('読み込み中…', true);
      const head = new Uint8Array(await file.slice(0, MEMO_HEAD).arrayBuffer());
      const magic = new TextDecoder().decode(head.slice(0, 8));
      if(magic === MEMO_MAGIC){
        // 新しい形式：目次だけ読み、画像はファイルの該当部分を切り出して使う（全体は読み込まない）
        const jsonLen = new DataView(head.buffer).getUint32(8, true);
        const manifest = JSON.parse(await file.slice(MEMO_HEAD, MEMO_HEAD + jsonLen).text());
        if(!manifest || manifest.format !== MEMO_FORMAT || !Array.isArray(manifest.notes)){ setStatus('', false); notMemo(); return; }
        const base = MEMO_HEAD + jsonLen;
        manifestNotes = manifest.notes;
        getBlob = async (ref)=>{
          const e = manifest.blobs[ref];
          if(!e) return null;
          return file.slice(base + e.off, base + e.off + e.len, e.type);
        };
      } else {
        // 以前の形式（JSON・画像はdata URL）
        let data;
        try{ data = JSON.parse(await file.text()); }catch(err){ data = null; }
        if(!data || data.format !== MEMO_FORMAT || !Array.isArray(data.notes)){ setStatus('', false); notMemo(); return; }
        manifestNotes = data.notes;
        getBlob = async (s)=> (typeof s === 'string' ? dataURLtoBlob(s) : null);
      }
      if(!manifestNotes.length){ setStatus('', false); notMemo(); return; }

      const imported = await Promise.all(manifestNotes.map(n => manifestToNote(n, getBlob)));
      // 画像データが欠けているもの（壊れたファイル）は除く
      imported.forEach(n=>{ n.images = n.images.filter(im => im.src); });
      await runTabOp(async ()=>{
        await saveActiveNoteState();
        notes.push(...imported);
        activeIndex = notes.length - 1;
        await loadNoteIntoUI(activeIndex);
        renderTabs();
      });
      setStatus('保存中…', false);
    }catch(err){
      console.error('import failed', err);
      setStatus('', false);
      alert('ファイルの読み込みに失敗しました：' + (err && err.message ? err.message : err));
    }
  }

  const importInput = document.getElementById('importInput');
  document.getElementById('exportBtn').addEventListener('click', exportActiveNote);
  document.getElementById('importBtn').addEventListener('click', ()=> importInput.click());
  importInput.addEventListener('change', ()=>{
    const f = importInput.files && importInput.files[0];
    importInput.value = '';
    if(f) importMemoFile(f);
  });
  // Ctrl+S で保存、Ctrl+O で開く（ブラウザ標準の「ページを保存」「ファイルを開く」の代わり）
  window.addEventListener('keydown', (e)=>{
    if(!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if(key === 's'){ e.preventDefault(); exportActiveNote(); }
    else if(key === 'o'){ e.preventDefault(); importInput.click(); }
  });

  window.addEventListener('keydown', (e)=>{
    const ae = document.activeElement;
    if(ae === textEl || (ae && ae.isContentEditable)) return; // 文字入力中は普通のキー操作
    if(e.key === 'Delete' || e.key === 'Backspace'){
      if(selOrder.length){
        e.preventDefault();
        [...selOrder].filter(id => { const im = imgDataById(id); return im && !im.lock; })
                     .forEach(id => removeImage(id));
      }
    } else if((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey) && !e.altKey){
      // Ctrl+L：選んだ画像のロック／解除（1枚でもロックされていなければ全部ロック、全部ロック済みなら解除）
      if(selOrder.length){
        e.preventDefault();
        const ims = selOrder.map(imgDataById).filter(Boolean);
        const lockIt = ims.some(im => !im.lock);
        ims.forEach(im=>{
          im.lock = lockIt;
          const b = boxById(im.id);
          if(b) b.classList.toggle('lock', lockIt);
        });
        scheduleSave();
      }
    } else if((e.key === 'w' || e.key === 'W') && !e.ctrlKey && !e.metaKey && !e.altKey){
      if(selOrder.length >= 2){
        e.preventDefault();
        alignSelectedWidths();
      }
    }
  });

  // ---------- 保存・読み込み（IndexedDB） ----------
  // localStorageよりずっと大きい容量（ブラウザの空き容量次第で数百MB〜）が使え、
  // 画像もbase64にせずBlobのまま保存できるので容量効率も良い。
  const DB_NAME = 'notepad-paint-db';
  const DB_VERSION = 1;
  const STORE_NAME = 'appState';
  const STATE_KEY = 'main';
  const idbAvailable = ('indexedDB' in window);

  let dbPromise = null;
  function openDB(){
    if(!dbPromise){
      dbPromise = new Promise((resolve, reject)=>{
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e)=>{
          const db = e.target.result;
          if(!db.objectStoreNames.contains(STORE_NAME)){
            db.createObjectStore(STORE_NAME);
          }
        };
        req.onsuccess = ()=> resolve(req.result);
        req.onerror = ()=> reject(req.error);
      });
    }
    return dbPromise;
  }
  async function idbGet(key){
    const db = await openDB();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> reject(req.error);
    });
  }
  async function idbSet(key, value){
    const db = await openDB();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> reject(tx.error);
    });
  }

  let saveTimer = null;
  function scheduleSave(){
    if(!idbAvailable){ setStatus('保存非対応のブラウザです', true); return; }
    if(!statusEl.classList.contains('show')) setStatus('保存中…', false);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSaveAll, 700);
  }
  async function doSaveAll(){
    if(busy){ scheduleSave(); return; } // タブ操作中は待ってから保存
    try{
      await saveActiveNoteState();
      await idbSet(STATE_KEY, { notes, activeIndex, updatedAt: Date.now() });
      setStatus('保存済み', false);
      updateUsageLabel();
    }catch(e){
      console.error('save failed', e);
      setStatus('保存エラー（容量不足の可能性）', true);
    }
  }
  textEl.addEventListener('input', ()=>{
    measureAndGrow();
    updateActiveTabLabel();
    scheduleSave();
  });

  // 使用容量の目安をstatusのツールチップに表示（対応ブラウザのみ）
  async function updateUsageLabel(){
    try{
      if(navigator.storage && navigator.storage.estimate){
        const est = await navigator.storage.estimate();
        const usedMB = (est.usage / 1024 / 1024).toFixed(1);
        const quotaMB = est.quota ? (est.quota / 1024 / 1024).toFixed(0) : '?';
        statusEl.title = `使用容量: 約${usedMB}MB / 上限目安 約${quotaMB}MB`;
      }
    }catch(e){ /* 非対応ブラウザは無視 */ }
  }

  // 旧バージョン（localStorage保存）のデータが残っていればIndexedDBへ一度だけ引き継ぐ
  async function migrateFromLocalStorageIfNeeded(){
    let migratedNotes = null;
    let migratedActive = 0;
    try{
      const raw = localStorage.getItem('notepad-data-v2');
      if(raw){
        const data = JSON.parse(raw);
        if(data && Array.isArray(data.notes) && data.notes.length){
          migratedNotes = await Promise.all(data.notes.map(async n=>({
            id: n.id || genId(),
            title: n.title || null,
            text: n.text || '',
            ink: n.ink ? await dataURLtoBlob(n.ink) : null,
            inkW: n.inkW || 0,
            inkH: n.inkH || 0,
            fontSize: n.fontSize || 19,
            bold: n.bold !== false,
            images: n.images ? await Promise.all(n.images.map(async im=>({
              id: im.id || genId(), x: im.x, y: im.y, w: im.w, h: im.h,
              src: await dataURLtoBlob(im.src)
            }))) : []
          })));
          migratedActive = Math.min(Math.max(data.activeIndex || 0, 0), migratedNotes.length - 1);
        }
      } else {
        const oldRaw = localStorage.getItem('notepad-data');
        if(oldRaw){
          const old = JSON.parse(oldRaw);
          migratedNotes = [{
            id: genId(), title: null,
            text: old.text || '',
            ink: old.ink ? await dataURLtoBlob(old.ink) : null,
            inkW: old.inkW || 0,
            inkH: old.inkH || 0,
            fontSize: old.fontSize || 19,
            bold: old.bold !== false,
            images: []
          }];
          migratedActive = 0;
        }
      }
    }catch(e){ console.warn('migration failed', e); }

    if(migratedNotes){
      const state = { notes: migratedNotes, activeIndex: migratedActive, updatedAt: Date.now() };
      await idbSet(STATE_KEY, state);
      try{
        localStorage.removeItem('notepad-data-v2');
        localStorage.removeItem('notepad-data');
      }catch(e){ /* 無視 */ }
      return state;
    }
    return null;
  }

  async function loadAll(){
    if(!idbAvailable){
      notes = [makeEmptyNote()];
      activeIndex = 0;
      renderTabs();
      await loadNoteIntoUI(activeIndex);
      setStatus('保存非対応のブラウザです', true);
      return;
    }

    try{
      if(navigator.storage && navigator.storage.persist){
        navigator.storage.persist().catch(()=>{});
      }
    }catch(e){ /* 無視 */ }

    let state = null;
    try{
      state = await idbGet(STATE_KEY);
      if(!state){
        state = await migrateFromLocalStorageIfNeeded();
      }
    }catch(e){
      console.warn('load failed, starting fresh', e);
    }

    if(state && Array.isArray(state.notes) && state.notes.length){
      notes = state.notes;
      activeIndex = Math.min(Math.max(state.activeIndex || 0, 0), notes.length - 1);
    } else {
      notes = [makeEmptyNote()];
      activeIndex = 0;
    }

    renderTabs();
    await loadNoteIntoUI(activeIndex);
    setStatus('保存済み', false);
    updateUsageLabel();
  }

  // ---------- 手書きの undo / redo ----------
  // 1回の操作で変わったキャンバス（全体の手書き／画像ごとのレイヤー）を、触る直前に記録しておく。
  let curEntry = null;
  function pushUndo(){
    curEntry = { items: [] };
    undoStack.push(curEntry);
    if(undoStack.length > 30) undoStack.shift();
    redoStack.length = 0; // 新しい操作をしたらやり直し履歴は破棄
  }
  // このキャンバスを今回の操作で初めて触るなら、触る前の状態を記録
  function touch(c){
    if(!curEntry || curEntry.items.some(it => it.c === c)) return;
    curEntry.items.push(snapshotItem(c));
  }
  function snapshotItem(c){
    return { c, data: c.toDataURL('image/png'), h: (c === canvas) ? currentSheetHeight : null };
  }
  function snapshotOf(entry){ return { items: entry.items.map(it => snapshotItem(it.c)) }; }
  function restoreEntry(entry, onDone){
    const jobs = entry.items.map(it => new Promise((resolve)=>{
      if(it.c !== canvas && !it.c.isConnected){ resolve(); return; } // 削除された画像
      if(it.c === canvas && it.h > currentSheetHeight) resizeCanvasTo(wrap.clientWidth, it.h);
      const img = new Image();
      img.onload = ()=>{
        if(it.c === canvas){
          clearInkCanvas();
          blitToInk(img); // 記録時のピクセルをそのまま戻す（伸縮させない）
        } else {
          const x = it.c.getContext('2d');
          x.save();
          x.setTransform(1,0,0,1,0,0);
          x.globalCompositeOperation = 'source-over';
          x.clearRect(0, 0, it.c.width, it.c.height);
          x.drawImage(img, 0, 0);
          x.restore();
          markLayerDirty(it.c.parentElement);
        }
        resolve();
      };
      img.onerror = ()=> resolve();
      img.src = it.data;
    }));
    Promise.all(jobs).then(()=>{ if(onDone) onDone(); });
  }
  function doInkUndo(){
    if(undoStack.length===0) return;
    const prev = undoStack.pop();
    redoStack.push(snapshotOf(prev));
    restoreEntry(prev, ()=>{ scheduleSave(); });
  }
  function doInkRedo(){
    if(redoStack.length===0) return;
    const next = redoStack.pop();
    undoStack.push(snapshotOf(next));
    restoreEntry(next, ()=>{ scheduleSave(); });
  }

  function allLayerBoxes(){
    return Array.from(imagesLayerEl.querySelectorAll('.img-box')).filter(b => b._layer);
  }
  document.getElementById('clearInk').addEventListener('click', ()=>{
    if(!confirm('手書き部分だけを消去します。よろしいですか？（文字・画像は消えません）')) return;
    pushUndo();
    touch(canvas);
    clearInkCanvas();
    allLayerBoxes().forEach(b=>{
      touch(b._layer);
      const x = b._layer.getContext('2d');
      x.save(); x.setTransform(1,0,0,1,0,0); x.clearRect(0, 0, b._layer.width, b._layer.height); x.restore();
      markLayerDirty(b);
    });
    curEntry = null;
    scheduleSave();
  });

  // ---------- キーボードショートカット：Ctrl+Z / Ctrl+Y ----------
  // 手書きモード中だけ手書きのUndo/Redoを横取りする。
  // 通常のタイピング中はブラウザ標準のテキストUndo/Redoに任せる（何もしない）。
  window.addEventListener('keydown', (e)=>{
    const ctrlOrCmd = e.ctrlKey || e.metaKey;
    if(!ctrlOrCmd || !drawMode) return;
    const key = e.key.toLowerCase();
    if(key === 'z' && !e.shiftKey){
      e.preventDefault();
      doInkUndo();
    }else if(key === 'y' || (key === 'z' && e.shiftKey)){
      e.preventDefault();
      doInkRedo();
    }
  });

  // ---------- 描画 ----------
  function getPos(e){ return { x: e.offsetX, y: e.offsetY }; }

  // 描く先：画像の上で書き始めたらその画像のレイヤー、それ以外は全体の手書きレイヤー
  // { c: キャンバス, x: 描画コンテキスト（紙の座標で描ける）, box: 画像（全体なら null） }
  let target = null;
  function targetAt(x, y){
    const hit = imageHitAt(x, y);
    if(!hit) return { c: canvas, x: ctx, box: null };
    const g = layerCtx(hit.box, hit.im);
    return { c: hit.box._layer, x: g, box: hit.box };
  }

  // 直線・グリッドツール用：ドラッグ中のプレビュー表示に使う退避キャンバス
  const previewCanvas = document.createElement('canvas');
  const previewCtx = previewCanvas.getContext('2d');
  let dragStartX = 0, dragStartY = 0;

  function snapshotForPreview(c){
    previewCanvas.width = c.width;
    previewCanvas.height = c.height;
    previewCtx.clearRect(0,0,previewCanvas.width,previewCanvas.height);
    previewCtx.drawImage(c, 0, 0);
  }
  function restorePreviewBase(t){
    t.x.save();
    t.x.setTransform(1,0,0,1,0,0);
    t.x.globalCompositeOperation = 'source-over';
    t.x.clearRect(0, 0, t.c.width, t.c.height);
    t.x.drawImage(previewCanvas, 0, 0);
    t.x.restore();
  }
  // Shiftキー押下時：水平・垂直・45度に吸着
  function applyAngleSnap(x0, y0, x, y, snap){
    if(!snap) return {x, y};
    const dx = x - x0, dy = y - y0;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI/4)) * (Math.PI/4);
    return { x: x0 + Math.cos(angle) * dist, y: y0 + Math.sin(angle) * dist };
  }
  // ドラッグした対角線を「1マスの対角線」として、指定した行×列数の正方形グリッドを描く
  function drawGrid(g, x0, y0, x1, y1){
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if(dist < 3) return; // 小さすぎるドラッグは無視

    const rows = Math.max(1, Math.min(200, parseInt(gridRowsInput.value,10) || 1));
    const cols = Math.max(1, Math.min(200, parseInt(gridColsInput.value,10) || 1));
    const side = dist / Math.SQRT2; // 対角線→正方形の一辺
    const dirX = (x1 >= x0) ? 1 : -1;
    const dirY = (y1 >= y0) ? 1 : -1;

    const left = (dirX > 0) ? x0 : x0 - cols*side;
    const top = (dirY > 0) ? y0 : y0 - rows*side;
    const right = left + cols*side;
    const bottom = top + rows*side;

    g.strokeStyle = currentColor;
    g.lineWidth = penWidth();
    g.beginPath();
    for(let r=0; r<=rows; r++){
      const y = top + side*r;
      g.moveTo(left, y); g.lineTo(right, y);
    }
    for(let c=0; c<=cols; c++){
      const x = left + side*c;
      g.moveTo(x, top); g.lineTo(x, bottom);
    }
    g.stroke();
  }

  // 消しゴム：全体の手書きと、通り道にある画像のレイヤーの両方から消す
  function eraseSegment(x0, y0, x1, y1){
    const w = eraserWidth();
    const seg = (g)=>{
      g.save();
      g.globalCompositeOperation = 'destination-out';
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      g.restore();
    };
    touch(canvas);
    seg(ctx);
    const pad = w / 2;
    const minX = Math.min(x0, x1) - pad, maxX = Math.max(x0, x1) + pad;
    const minY = Math.min(y0, y1) - pad, maxY = Math.max(y0, y1) + pad;
    allLayerBoxes().forEach(b=>{
      const im = imgDataById(b.dataset.id);
      if(!im) return;
      if(maxX < im.x || minX > im.x + im.w || maxY < im.y || minY > im.y + im.h) return;
      touch(b._layer);
      seg(layerCtx(b, im));
      markLayerDirty(b);
    });
  }

  // 今のストロークで使っている道具（右ボタン・ペンのお尻のときだけ一時的に消しゴムになる）
  let strokeTool = 'pen';

  canvas.addEventListener('pointerdown', (e)=>{
    if(!drawMode) return;
    if(e.button === 1) return; // 中ボタンはモード切り替え用
    // 右ボタン(2)・ペンタブの消しゴム側(5)でなぞったときは一時的に消しゴム
    strokeTool = (e.button === 2 || e.button === 5) ? 'eraser' : tool;
    pushUndo();
    isDrawing = true;
    canvas.setPointerCapture(e.pointerId);
    const {x,y} = getPos(e);
    lastX = x; lastY = y;
    if(strokeTool === 'eraser'){
      target = null;
      eraseSegment(x, y, x, y);
      return;
    }
    target = targetAt(x, y);
    touch(target.c);
    if(strokeTool === 'line' || strokeTool === 'grid'){
      dragStartX = x; dragStartY = y;
      snapshotForPreview(target.c);
    }
  });
  function onDrawMove(e){
    if(!isDrawing) return;
    let {x,y} = getPos(e);

    if(strokeTool === 'eraser'){
      eraseSegment(lastX, lastY, x, y);
      lastX = x; lastY = y;
      return;
    }

    const g = target.x;
    if(strokeTool === 'line'){
      ({x, y} = applyAngleSnap(dragStartX, dragStartY, x, y, e.shiftKey));
      restorePreviewBase(target);
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = currentColor;
      g.lineWidth = penWidth();
      g.beginPath();
      g.moveTo(dragStartX, dragStartY);
      g.lineTo(x, y);
      g.stroke();
      return;
    }

    if(strokeTool === 'grid'){
      restorePreviewBase(target);
      g.globalCompositeOperation = 'source-over';
      drawGrid(g, dragStartX, dragStartY, x, y);
      return;
    }

    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = currentColor;
    g.lineWidth = penWidth();
    g.beginPath();
    g.moveTo(lastX, lastY);
    g.lineTo(x, y);
    g.stroke();
    lastX = x; lastY = y;
  }
  canvas.addEventListener('pointermove', onDrawMove);
  function endStroke(){
    if(!isDrawing) return;
    isDrawing = false;
    ctx.globalCompositeOperation = 'source-over'; // 消しゴムモードを引きずらない
    if(target && target.box) markLayerDirty(target.box);
    target = null;
    // 何も変わらなかった操作は履歴に残さない
    if(curEntry && !curEntry.items.length){
      const i = undoStack.indexOf(curEntry);
      if(i >= 0) undoStack.splice(i, 1);
    }
    curEntry = null;
    scheduleSave();
  }
  // 離した位置までちゃんと描く（最後の移動イベントが離す直前に来ないことがあるため）
  canvas.addEventListener('pointerup', (e)=>{ onDrawMove(e); endStroke(); });
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', ()=>{ if(isDrawing) endStroke(); });

  // 手書きモード中は右クリックメニューを出さない（右ドラッグ＝消しゴムのため）
  canvas.addEventListener('contextmenu', (e)=>{ if(drawMode) e.preventDefault(); });

  // ---------- 中ボタン：手書き ⇔ 入力 の切り替え ----------
  // mousedownで止めないと、Windowsではオートスクロール、Linuxでは中クリック貼り付けが動いてしまう
  wrap.addEventListener('mousedown', (e)=>{
    if(e.button !== 1) return;
    e.preventDefault();
    if(isDrawing) return;
    setDrawMode(!drawMode);
  });
  wrap.addEventListener('auxclick', (e)=>{ if(e.button === 1) e.preventDefault(); });

  // ホイールは手書きモード中も普通にスクロール（特別な処理はしない）

  loadAll();
})();

// ---------- Service Worker登録（オフライン対応） ----------
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(err=>{
      console.warn('Service Worker登録に失敗:', err);
    });
  });
}
