// Runs in the PAGE's own JavaScript world (manifest "world": "MAIN") so it can reach NetSuite's code editor object.
// It only talks to content.js through window.postMessage, and only does two things:
//   - read / replace the editor text when content.js asks
//   - when a "Save" button is clicked on a File page, send the editor text to content.js (version capture)
(() => {
  if (window.__ssvgBridge) return;
  window.__ssvgBridge = true;

  const isFilePage = /\/(edittextmediaitem|mediaitem)\.nl$/.test(location.pathname);

  // Tries the common editor libraries, then falls back to the biggest textarea.
  function findEditor() {
    const cms = Array.from(document.querySelectorAll('.CodeMirror')).filter((el) => el.CodeMirror);
    if (cms.length) {
      const cm = cms.sort((a, b) => b.CodeMirror.getValue().length - a.CodeMirror.getValue().length)[0].CodeMirror;
      return { kind: 'CodeMirror', get: () => cm.getValue(), set: (v) => cm.setValue(v) };
    }
    const aceEl = document.querySelector('.ace_editor');
    if (aceEl) {
      let ed = aceEl.env && aceEl.env.editor;
      if (!ed && window.ace && window.ace.edit) { try { ed = window.ace.edit(aceEl); } catch { /* ignore */ } }
      if (ed) return { kind: 'Ace', get: () => ed.getValue(), set: (v) => ed.setValue(v, -1) };
    }
    if (window.monaco && window.monaco.editor && window.monaco.editor.getEditors) {
      const eds = window.monaco.editor.getEditors();
      if (eds.length) return { kind: 'Monaco', get: () => eds[0].getValue(), set: (v) => eds[0].setValue(v) };
    }
    const ta = Array.from(document.querySelectorAll('textarea')).sort((a, b) => b.value.length - a.value.length)[0];
    if (ta && ta.value) {
      return {
        kind: 'textarea', get: () => ta.value,
        set: (v) => { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true })); },
      };
    }
    return null;
  }

  window.addEventListener('message', (e) => {
    if (e.source && e.source !== window) return;
    const d = e.data;
    if (!d || d.tag !== 'ssvg-req') return;
    const res = { tag: 'ssvg-res', id: d.id, ok: false };
    try {
      const ed = findEditor();
      if (!ed) res.error = 'No code editor found on this page';
      else {
        res.kind = ed.kind;
        if (d.op === 'get') { res.value = ed.get(); res.ok = true; }
        else if (d.op === 'set' && typeof d.value === 'string') { ed.set(d.value); res.ok = true; }
      }
    } catch (err) {
      res.error = String((err && err.message) || err);
    }
    window.postMessage(res, location.origin);
  });

  // Capture phase: runs before NetSuite submits the form, so we see the text that is being saved.
  if (isFilePage) {
    document.addEventListener('click', (ev) => {
      const el = ev.target && ev.target.closest && ev.target.closest('input[type=submit],input[type=button],button');
      if (!el) return;
      if (!/^save$/i.test(String(el.value || el.textContent || '').trim())) return;
      try {
        const ed = findEditor();
        if (ed) window.postMessage({ tag: 'ssvg-save', value: ed.get() }, location.origin);
      } catch { /* never block NetSuite's Save */ }
    }, true);
  }
})();
