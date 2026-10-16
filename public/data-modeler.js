// pgkiln builder: the SQL Workshop's Data Modeler (sprint 98, src/builder/data-modeler.ts, src/datamodel.ts).
//
// Progressive enhancement of the server-rendered SVG diagram (the boxes at their saved positions):
//   - drag a box (mouse or touch), or focus it and use the arrow keys (Shift: bigger steps); the foreign key
//     lines follow (fkPath: the same geometry as src/datamodel.ts)
//   - Save (Ctrl+S) posts the positions; Undo (Ctrl+Z) and Redo (Ctrl+Y, Ctrl+Shift+Z); unsaved changes are
//     shown and leaving asks first
//   - Zoom in / out, Fit, Auto layout (the server's automatic positions, data-ax/ay; undoable), a mini-map
//   - Export SVG and PNG of the diagram as it is on the screen, Print
// Strict CSP: no inline styles; geometry goes into SVG attributes, sizes through the CSSOM.
(() => {
  'use strict';
  // the data dictionary's Print button
  for (const b of document.querySelectorAll('.dm-dict-actions [data-dm=print]')) {
    b.hidden = false;
    b.addEventListener('click', () => window.print());
  }
  const stage = document.querySelector('[data-dm-stage]');
  const svg = document.getElementById('dm-svg');
  if (!stage || !svg) return;
  const canvas = stage.querySelector('.dm-canvas');
  const toolbar = document.querySelector('.dm-toolbar');
  const saveForm = toolbar.querySelector('.dm-save-form');
  const status = toolbar.querySelector('.dm-status');
  const btn = (name) => toolbar.querySelector(`[data-dm="${name}"]`);
  for (const b of toolbar.querySelectorAll('[data-dm][hidden]')) b.hidden = false;
  const NS = 'http://www.w3.org/2000/svg';

  const boxes = new Map([...svg.querySelectorAll('.dm-box')].map((g) => [g.dataset.name, {
    g, x: Number(g.dataset.x), y: Number(g.dataset.y), w: Number(g.dataset.w), h: Number(g.dataset.h),
    ax: g.dataset.ax === undefined ? null : Number(g.dataset.ax), ay: g.dataset.ay === undefined ? null : Number(g.dataset.ay),
  }]));
  const fks = [...svg.querySelectorAll('.dm-fk')];
  let W = Number(svg.getAttribute('width'));
  let H = Number(svg.getAttribute('height'));
  let zoom = 1;

  // ------------------------------------------------------------ geometry (as fkPath in src/datamodel.ts)
  function fkPath(a, ay, b, by) {
    const y1 = a.y + ay;
    const y2 = b.y + by;
    let x1, x2, d1, d2, path;
    if (a.x + a.w + 40 <= b.x) {
      [x1, x2, d1, d2] = [a.x + a.w, b.x, 1, -1];
      const mx = Math.round((x1 + x2) / 2);
      path = `M ${x1} ${y1} H ${mx} V ${y2} H ${x2}`;
    } else if (b.x + b.w + 40 <= a.x) {
      [x1, x2, d1, d2] = [a.x, b.x + b.w, -1, 1];
      const mx = Math.round((x1 + x2) / 2);
      path = `M ${x1} ${y1} H ${mx} V ${y2} H ${x2}`;
    } else {
      [x1, x2, d1, d2] = [a.x + a.w, b.x + b.w, 1, 1];
      const lx = Math.max(x1, x2) + (a === b ? 18 : 30);
      const yy = a === b && y1 === y2 ? y2 + 10 : y2;
      path = `M ${x1} ${y1} H ${lx} V ${yy} H ${x2}`;
    }
    const foot = `M ${x1 + d1 * 14} ${y1} L ${x1} ${y1 - 7} M ${x1 + d1 * 14} ${y1} L ${x1} ${y1 + 7} M ${x1 + d1 * 14} ${y1 - 7} V ${y1 + 7}`;
    const bar = `M ${x2 + d2 * 10} ${y2 - 7} V ${y2 + 7}`;
    return { path, ends: `${foot} ${bar}`, circle: { cx: x2 + d2 * 20, cy: y2 } };
  }

  function draw() {
    for (const b of boxes.values()) b.g.setAttribute('transform', `translate(${b.x} ${b.y})`);
    for (const l of fks) {
      const a = boxes.get(l.dataset.from);
      const b = boxes.get(l.dataset.to);
      if (!a || !b) continue;
      const p = fkPath(a, Number(l.dataset.fy), b, Number(l.dataset.ty));
      l.querySelector('.dm-line').setAttribute('d', p.path);
      l.querySelector('.dm-end').setAttribute('d', p.ends);
      const c = l.querySelector('.dm-opt');
      if (c) {
        c.setAttribute('cx', String(p.circle.cx));
        c.setAttribute('cy', String(p.circle.cy));
      }
    }
    const all = [...boxes.values()];
    W = Math.max(400, ...all.map((b) => b.x + b.w + 60));
    H = Math.max(240, ...all.map((b) => b.y + b.h + 40));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    sizeSvg();
  }
  function sizeSvg() {
    svg.setAttribute('width', String(Math.round(W * zoom)));
    svg.setAttribute('height', String(Math.round(H * zoom)));
    updateMinimap();
  }

  // ------------------------------------------------------------ undo, redo, unsaved changes
  const snapshot = () => [...boxes].map(([name, b]) => [name, b.x, b.y]);
  const restore = (snap) => {
    for (const [name, x, y] of snap) {
      const b = boxes.get(name);
      if (b) [b.x, b.y] = [x, y];
    }
    draw();
  };
  const undo = [];
  const redo = [];
  let saved = JSON.stringify(snapshot());
  const dirty = () => JSON.stringify(snapshot()) !== saved;
  function changed() {
    btn('undo').disabled = !undo.length;
    btn('redo').disabled = !redo.length;
    const d = dirty();
    btn('save').classList.toggle('btn-hot', d);
    status.textContent = d ? 'Unsaved changes' : '';
  }
  function remember(before) {
    undo.push(before);
    if (undo.length > 200) undo.shift();
    redo.length = 0;
    changed();
  }
  btn('undo').addEventListener('click', () => {
    if (!undo.length) return;
    redo.push(snapshot());
    restore(undo.pop());
    changed();
  });
  btn('redo').addEventListener('click', () => {
    if (!redo.length) return;
    undo.push(snapshot());
    restore(redo.pop());
    changed();
  });
  window.addEventListener('beforeunload', (e) => {
    if (!dirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  async function save() {
    const body = new URLSearchParams({
      __csrf: saveForm.querySelector('input[name=__csrf]').value,
      format: 'json',
      positions: JSON.stringify([...boxes].map(([name, b]) => ({ name, x: Math.round(b.x), y: Math.round(b.y) }))),
    });
    status.textContent = 'Saving…';
    try {
      const res = await fetch(saveForm.action, { method: 'POST', body, credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      saved = JSON.stringify(snapshot());
      changed();
      status.textContent = 'Saved';
    } catch (e) {
      status.textContent = `Not saved (${e.message}): try again`;
    }
  }
  btn('save').addEventListener('click', save);
  saveForm.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });

  // ------------------------------------------------------------ moving boxes
  const moveBox = (b, x, y) => {
    b.x = Math.max(0, Math.min(20000, Math.round(x)));
    b.y = Math.max(0, Math.min(20000, Math.round(y)));
    draw();
  };
  let dragged = false;
  for (const b of boxes.values()) {
    b.g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const start = { x: e.clientX, y: e.clientY, bx: b.x, by: b.y };
      const before = snapshot();
      let moved = false;
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / zoom;
        const dy = (ev.clientY - start.y) / zoom;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (!moved) {
          moved = true;
          // captured only once it moves: a plain click still reaches the box's name (its link)
          b.g.setPointerCapture(ev.pointerId);
          b.g.classList.add('dm-dragging');
          // on top of the others
          b.g.parentNode.append(b.g);
        }
        moveBox(b, start.bx + dx, start.by + dy);
      };
      const up = () => {
        b.g.removeEventListener('pointermove', move);
        b.g.removeEventListener('pointerup', up);
        b.g.removeEventListener('pointercancel', up);
        b.g.classList.remove('dm-dragging');
        if (moved) {
          dragged = true;
          setTimeout(() => (dragged = false), 0);
          remember(before);
        }
      };
      b.g.addEventListener('pointermove', move);
      b.g.addEventListener('pointerup', up);
      b.g.addEventListener('pointercancel', up);
    });
    b.g.addEventListener('dragstart', (e) => e.preventDefault());
    // a drag that ends over the box's name doesn't open the table
    b.g.addEventListener('click', (e) => {
      if (dragged) e.preventDefault();
    }, true);
    b.g.addEventListener('keydown', (e) => {
      if (e.target !== b.g) return;
      const step = e.shiftKey ? 50 : 10;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      const before = snapshot();
      moveBox(b, b.x + d[0], b.y + d[1]);
      remember(before);
    });
  }

  // ------------------------------------------------------------ auto layout
  const auto = btn('auto');
  auto.closest('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const before = snapshot();
    for (const b of boxes.values()) if (b.ax !== null) [b.x, b.y] = [b.ax, b.ay];
    draw();
    remember(before);
  });

  // ------------------------------------------------------------ zoom
  const setZoom = (z) => {
    zoom = Math.max(0.2, Math.min(3, Math.round(z * 100) / 100));
    sizeSvg();
    status.textContent = `${Math.round(zoom * 100)}%${dirty() ? ' · unsaved changes' : ''}`;
  };
  btn('zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
  btn('zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
  btn('fit').addEventListener('click', () => setZoom(Math.min(2, (canvas.clientWidth - 4) / W, (canvas.clientHeight - 4) / H)));
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // ------------------------------------------------------------ mini-map
  const content = svg.querySelector('.dm-content');
  content.id = 'dm-content';
  let mini = null;
  let view = null;
  function updateMinimap() {
    if (!mini) return;
    mini.setAttribute('viewBox', `0 0 ${W} ${H}`);
    view.setAttribute('x', String(canvas.scrollLeft / zoom));
    view.setAttribute('y', String(canvas.scrollTop / zoom));
    view.setAttribute('width', String(Math.min(W, canvas.clientWidth / zoom)));
    view.setAttribute('height', String(Math.min(H, canvas.clientHeight / zoom)));
  }
  const mm = btn('minimap');
  mm.setAttribute('aria-pressed', 'false');
  mm.addEventListener('click', () => {
    if (mini) {
      mini.remove();
      mini = null;
      mm.setAttribute('aria-pressed', 'false');
      return;
    }
    mini = document.createElementNS(NS, 'svg');
    mini.setAttribute('class', 'dm-minimap');
    mini.setAttribute('aria-hidden', 'true');
    mini.setAttribute('preserveAspectRatio', 'xMinYMin meet');
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('class', 'dm-minimap-bg');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#dm-content');
    view = document.createElementNS(NS, 'rect');
    view.setAttribute('class', 'dm-minimap-view');
    mini.append(bg, use, view);
    stage.append(mini);
    mm.setAttribute('aria-pressed', 'true');
    // click or drag in the mini-map: that part of the diagram in the middle
    const go = (e) => {
      const r = mini.getBoundingClientRect();
      const scale = Math.min(r.width / W, r.height / H);
      const x = (e.clientX - r.left) / scale;
      const y = (e.clientY - r.top) / scale;
      canvas.scrollLeft = x * zoom - canvas.clientWidth / 2;
      canvas.scrollTop = y * zoom - canvas.clientHeight / 2;
    };
    mini.addEventListener('pointerdown', (e) => {
      mini.setPointerCapture(e.pointerId);
      go(e);
      const move = (ev) => go(ev);
      mini.addEventListener('pointermove', move);
      mini.addEventListener('pointerup', () => mini.removeEventListener('pointermove', move), { once: true });
    });
    updateMinimap();
  });
  canvas.addEventListener('scroll', updateMinimap);
  window.addEventListener('resize', updateMinimap);

  // ------------------------------------------------------------ export and print
  const fileName = (stage.dataset.name || 'diagram').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80);
  /** The diagram as a standalone SVG document (its presentation attributes carry the colours). */
  function svgText() {
    const copy = svg.cloneNode(true);
    copy.removeAttribute('id');
    copy.setAttribute('width', String(W));
    copy.setAttribute('height', String(H));
    copy.querySelector('.dm-content').removeAttribute('id');
    for (const a of [...copy.querySelectorAll('a')]) a.replaceWith(...a.childNodes);
    for (const g of copy.querySelectorAll('[tabindex]')) g.removeAttribute('tabindex');
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copy)}\n`;
  }
  const download = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  btn('svg').addEventListener('click', (e) => {
    e.preventDefault();
    download(new Blob([svgText()], { type: 'image/svg+xml' }), `${fileName}.svg`);
  });
  btn('png').addEventListener('click', () => {
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const c = document.createElement('canvas');
      c.width = Math.round(W * scale);
      c.height = Math.round(H * scale);
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, W, H);
      c.toBlob((blob) => blob && download(blob, `${fileName}.png`), 'image/png');
    };
    img.onerror = () => (status.textContent = 'The PNG could not be made: export SVG instead');
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText())}`;
  });
  btn('print').addEventListener('click', () => {
    const z = zoom;
    setZoom(1);
    window.print();
    setZoom(z);
  });

  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (key === 's') {
      e.preventDefault();
      save();
    } else if (/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) {
      return;
    } else if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      btn('undo').click();
    } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
      e.preventDefault();
      btn('redo').click();
    }
  });

  canvas.classList.add('dm-live');
  changed();
  status.textContent = '';
})();
