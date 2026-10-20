// Progressive enhancement only: every page works without this file.
(function () {
  'use strict';
  document.documentElement.classList.add('js');
  var $$ =function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // Screen-reader announcements (the empty status line every page has)
  var live = document.getElementById('live');
  var announce = function (msg) { if (!live) return; live.textContent = ''; setTimeout(function () { live.textContent = msg; }, 50); };

  // After a redirect with a message, move focus to it so it's read out and seen first.
  var flash = document.querySelector('[data-flash]');
  if (flash) flash.focus({ preventScroll: false });

  // Copy buttons
  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      var label = btn.innerHTML;
      var result = function (ok) {
        btn.textContent = ok ? 'Copied' : 'Copy failed';
        announce(ok ? 'Copied to the clipboard.' : "Couldn't copy. Select the text and copy it by hand.");
        setTimeout(function () { btn.innerHTML = label; }, 1400);
      };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { result(true); }, function () { result(fallbackCopy(text)); });
      else result(fallbackCopy(text));
    });
  });
  function fallbackCopy(text) {
    var ta = document.createElement('textarea'), ok = false;
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    return ok;
  }

  // Confirm before destructive actions (on the form, or on the one button that was pressed)
  $$('form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      var msg = (e.submitter && e.submitter.getAttribute('data-confirm')) || form.getAttribute('data-confirm');
      if (msg && !window.confirm(msg)) e.preventDefault();
    });
  });

  // Tie each field's hint and error text to its input, so screen readers read them with the field.
  $$('.field').forEach(function (field) {
    var input = field.querySelector('input:not([type="hidden"]), select, textarea');
    if (!input) return;
    var ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    $$('.hint, .error', field).forEach(function (p, i) {
      if (!p.id) p.id = (input.id || input.name || 'f') + '-note-' + i;
      if (ids.indexOf(p.id) < 0) ids.push(p.id);
      if (p.classList.contains('error')) input.setAttribute('aria-invalid', 'true');
    });
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
  });

  // Busy state for slow actions (AI drafts, Google sync)
  $$('form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (e.defaultPrevented) return;
      var btn = form.querySelector('[data-busy]');
      if (btn) { btn.setAttribute('aria-busy', 'true'); btn.textContent = btn.getAttribute('data-busy'); setTimeout(function () { btn.disabled = true; }, 0); }
    });
  });

  // Count a tag visit only once the page is actually on someone's screen (not when a browser preloads it
  // or a link scanner fetches it). A preloaded page reports when the customer really opens it.
  $$('form[data-visit]').forEach(function (form) {
    var report = function () {
      var body = new URLSearchParams({ t: form.elements.t.value, s: form.elements.s.value });
      try { fetch(form.getAttribute('data-visit'), { method: 'POST', body: body, credentials: 'same-origin', keepalive: true }); } catch (e) { /* the rating still saves the visit */ }
    };
    if (document.prerendering) document.addEventListener('prerenderingchange', report, { once: true });
    else if (document.visibilityState === 'hidden') {
      document.addEventListener('visibilitychange', function once() {
        if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', once); report(); }
      });
    } else report();
  });

  // Star rating word ("Excellent") under the stars
  $$('[data-rate-form]').forEach(function (form) {
    var word = form.querySelector('[data-rate-word]');
    $$('input[name="rating"]', form).forEach(function (input) {
      input.addEventListener('change', function () {
        var label = form.querySelector('label[for="' + input.id + '"]');
        if (word && label) word.textContent = label.getAttribute('data-word');
      });
    });
  });

  // Time zone on first-run setup
  $$('[data-tz]').forEach(function (el) {
    try { el.value = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* ignore */ }
  });

  // Print
  $$('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });

  // New tech: suggest the tag link from the name
  $$('[data-slug-source]').forEach(function (src) {
    var form = src.form; if (!form) return;
    var slug = form.querySelector('[data-slug]');
    var first = form.querySelector('#first_name');
    var touched = !!(slug && slug.value);
    if (slug) slug.addEventListener('input', function () { touched = true; });
    src.addEventListener('input', function () {
      var f = (src.value.trim().split(/\s+/)[0] || '');
      if (first && !first.dataset.touched) first.value = f;
      if (slug && !touched) slug.value = f.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    });
    if (first) first.addEventListener('input', function () { first.dataset.touched = '1'; });
  });

  // Photo: crop to a square and shrink to 320px before upload
  $$('[data-photo-input]').forEach(function (input) {
    var form = input.form; if (!form) return;
    var hidden = form.querySelector('[data-photo-value]');
    var avatar = input.parentNode.querySelector('.avatar');
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var size = 320, s = Math.min(img.naturalWidth, img.naturalHeight);
        var sx = (img.naturalWidth - s) / 2, sy = Math.max(0, (img.naturalHeight - s) / 3);
        var canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        canvas.getContext('2d').drawImage(img, sx, sy, s, s, 0, 0, size, size);
        var data = canvas.toDataURL('image/jpeg', 0.85);
        hidden.value = data;
        if (avatar) avatar.innerHTML = '<img src="' + data + '" alt="">';
        URL.revokeObjectURL(url);
      };
      img.src = url;
      input.removeAttribute('name');
    });
  });

  // Chart tooltips (hover + keyboard focus)
  $$('.chart').forEach(function (chart) {
    var plot = chart.querySelector('.chart__plot');
    var tip = chart.querySelector('.chart__tip');
    if (!plot || !tip) return;
    var show = function (col) {
      var bar = col.querySelector('.chart__bar') || col.querySelector('.chart__hit');
      var p = plot.getBoundingClientRect();
      var b = bar.getBoundingClientRect();
      tip.textContent = col.getAttribute('data-tip');
      tip.hidden = false;
      var x = b.left + b.width / 2 - p.left;
      var half = tip.offsetWidth / 2;
      tip.style.left = Math.min(Math.max(x, half), p.width - half) + 'px';
      tip.style.top = (bar.classList.contains('chart__hit') ? b.bottom - 30 : b.top) - p.top + 'px';
    };
    var hide = function () { tip.hidden = true; };
    $$('.chart__col', chart).forEach(function (col) {
      col.addEventListener('mouseenter', function () { show(col); });
      col.addEventListener('mouseleave', hide);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  });

  // "Who helped you today?": search box with a dropdown of names (ARIA combobox + listbox)
  $$('[data-combo]').forEach(function (form) {
    var input = form.querySelector('[data-combo-input]');
    var list = form.querySelector('[data-combo-list]');
    var status = form.querySelector('[data-combo-status]');
    var empty = list.querySelector('.combo__empty');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Technicians');
    empty.setAttribute('role', 'presentation');
    $$('[data-combo-option]', list).forEach(function (o) {
      o.setAttribute('role', 'option');
      o.setAttribute('aria-selected', 'false');
      var a = o.querySelector('a');
      if (a) a.tabIndex = -1;
    });
    var options = $$('[role="option"]', list);
    var active = -1;
    // In on-screen order (filter() re-sorts the list so the best matches come first).
    var visible = function () { return $$('[role="option"]', list).filter(function (o) { return !o.hidden; }); };

    options.forEach(function (o) {
      o.nameEl = o.querySelector('.combo__name');
      o.fullName = o.getAttribute('data-name');
      o.order = options.indexOf(o);
      // Keep focus in the box when an option is pressed, so the list doesn't close before the tap lands.
      o.addEventListener('mousedown', function (e) { e.preventDefault(); });
    });

    function setOpen(open) {
      list.hidden = !open;
      input.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) setActive(-1);
    }

    function setActive(i) {
      var vis = visible();
      options.forEach(function (o) { o.setAttribute('aria-selected', 'false'); });
      active = i;
      if (i >= 0 && vis[i]) {
        vis[i].setAttribute('aria-selected', 'true');
        input.setAttribute('aria-activedescendant', vis[i].id);
        vis[i].scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function filter() {
      var q = input.value;
      var scored = options.map(function (o) { return { o: o, m: matchName(o.fullName, q) }; });
      scored.sort(function (a, b) { return ((b.m ? b.m.score : -1) - (a.m ? a.m.score : -1)) || (a.o.order - b.o.order); });
      var shown = 0;
      scored.forEach(function (x) {
        list.insertBefore(x.o, empty);
        x.o.hidden = !x.m;
        if (x.m) shown++;
        paint(x.o.nameEl, x.o.fullName, x.m && q.trim() ? x.m.ranges : []);
      });
      empty.hidden = shown > 0;
      status.textContent = q.trim() ? shown + (shown === 1 ? ' technician found' : ' technicians found') : '';
      setActive(q.trim() && shown ? 0 : -1);
    }

    function paint(el, text, ranges) {
      while (el.firstChild) el.removeChild(el.firstChild);
      var at = 0;
      ranges.forEach(function (r) {
        if (r[0] > at) el.appendChild(document.createTextNode(text.slice(at, r[0])));
        var mark = document.createElement('mark');
        mark.textContent = text.slice(r[0], r[1]);
        el.appendChild(mark);
        at = r[1];
      });
      if (at < text.length) el.appendChild(document.createTextNode(text.slice(at)));
    }

    function go(option) {
      var link = option && option.querySelector('a');
      if (link) window.location.href = link.href;
    }

    input.addEventListener('focus', function () { filter(); setOpen(true); });
    input.addEventListener('click', function () { if (list.hidden) { filter(); setOpen(true); } });
    input.addEventListener('input', function () { filter(); setOpen(true); });
    input.addEventListener('keydown', function (e) {
      var vis = visible();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (list.hidden) { filter(); setOpen(true); }
        setActive(Math.min(active + 1, vis.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(Math.max(active - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (active >= 0 && vis[active]) go(vis[active]);
        else if (vis.length === 1) go(vis[0]);
      } else if (e.key === 'Escape') {
        if (!list.hidden) { e.preventDefault(); setOpen(false); }
      }
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var vis = visible();
      if (vis.length === 1) go(vis[0]);
    });
    document.addEventListener('click', function (e) {
      if (!form.contains(e.target)) setOpen(false);
    });
    // Tabbing away closes the list too.
    form.addEventListener('focusout', function (e) {
      if (e.relatedTarget && !form.contains(e.relatedTarget)) setOpen(false);
    });

    // Same rules as matchName() in src/lib/util.ts.
    function norm(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
    function matchName(name, query) {
      var n = '', map = [];
      for (var i = 0; i < name.length; i++) {
        var c = norm(name[i]);
        for (var k = 0; k < c.length; k++) { n += c[k]; map.push(i); }
      }
      var tokens = norm(query).replace(/['’`-]/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
      if (!tokens.length) return { score: 0, ranges: [] };
      var words = [], re = /[a-z0-9]+/g, m;
      while ((m = re.exec(n))) words.push({ start: m.index, text: m[0] });
      var orig = function (s, e) { return [map[s], map[e - 1] + 1]; };
      var used = {}, ranges = [], score = 0;
      for (var t = 0; t < tokens.length; t++) {
        var wi = -1;
        for (var w = 0; w < words.length; w++) if (!used[w] && words[w].text.indexOf(tokens[t]) === 0) { wi = w; break; }
        if (wi < 0) { score = -1; break; }
        used[wi] = true;
        ranges.push(orig(words[wi].start, words[wi].start + tokens[t].length));
        score += wi === 0 ? 3 : 2;
      }
      if (score > 0) return { score: score, ranges: ranges.sort(function (a, b) { return a[0] - b[0]; }) };
      var flat = tokens.join(' '), at = flat.length >= 3 ? n.indexOf(flat) : -1;
      return at >= 0 ? { score: 1, ranges: [orig(at, at + flat.length)] } : null;
    }
  });

  // Branding → colors: keep each color picker and its hex box in step, fill fields from a preset,
  // and redraw the preview with the server's full set of derived colors.
  $$('[data-theme-form]').forEach(function (form) {
    var preview = document.querySelector('[data-theme-preview]');
    var warnBox = document.querySelector('[data-theme-warnings]');
    var custom = form.querySelector('input[name="preset"][value="custom"]');
    var timer = null, seq = 0;
    var hexFor = function (key) { return form.querySelector('[data-hex-for="' + key + '"]'); };
    var markCustom = function () { if (custom) custom.checked = true; };

    function update() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var mine = ++seq;
        var qs = new URLSearchParams(new FormData(form)).toString();
        fetch('/admin/branding/tokens?' + qs, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || mine !== seq) return;
            if (preview) preview.setAttribute('style', d.style);
            if (warnBox) showWarnings(d.warnings || []);
          })
          .catch(function () { /* the saved preview stays */ });
      }, 120);
    }

    function showWarnings(list) {
      while (warnBox.firstChild) warnBox.removeChild(warnBox.firstChild);
      if (!list.length) {
        var ok = document.createElement('p');
        ok.className = 'small pos';
        ok.textContent = 'These colors pass the readability check.';
        warnBox.appendChild(ok);
        return;
      }
      var ul = document.createElement('ul');
      ul.className = 'plain stack-xs';
      list.forEach(function (w) {
        var li = document.createElement('li');
        li.className = 'small';
        li.textContent = w;
        ul.appendChild(li);
      });
      warnBox.appendChild(ul);
    }

    $$('input[type="color"][data-theme-input]', form).forEach(function (picker) {
      var hex = hexFor(picker.name);
      picker.addEventListener('input', function () { if (hex) hex.value = picker.value; markCustom(); update(); });
      if (hex) hex.addEventListener('input', function () {
        var v = hex.value.trim().toLowerCase();
        if (v && v[0] !== '#') v = '#' + v;
        if (/^#[0-9a-f]{6}$/.test(v)) { picker.value = v; markCustom(); update(); }
      });
    });
    $$('select[data-theme-input], input[type="radio"][data-theme-input]', form).forEach(function (el) {
      el.addEventListener('change', function () { markCustom(); update(); });
    });
    $$('input[name="preset"][data-preset]', form).forEach(function (radio) {
      radio.addEventListener('change', function () {
        var p;
        try { p = JSON.parse(radio.getAttribute('data-preset')); } catch (e) { return; }
        ['bg', 'surface', 'text', 'action', 'proof'].forEach(function (k) {
          var picker = form.querySelector('input[type="color"][name="' + k + '"]');
          if (picker && p[k]) { picker.value = p[k]; var h = hexFor(k); if (h) h.value = p[k]; }
        });
        ['mode', 'corners'].forEach(function (k) { $$('input[name="' + k + '"]', form).forEach(function (x) { x.checked = x.value === p[k]; }); });
        ['heading_font', 'body_font'].forEach(function (k) { var sel = form.querySelector('select[name="' + k + '"]'); if (sel && p[k]) sel.value = p[k]; });
        update();
      });
    });
  });

  // Branding → logo and icon: resized here, so the upload is small and the server only has to check it.
  // The logo keeps its shape (up to 800 × 240); the icon becomes square PNGs at the sizes browsers and phones use.
  $$('[data-brand-form]').forEach(function (form) {
    var bgInput = form.querySelector('[data-icon-bg]');
    var padInput = form.querySelector('[data-icon-pad]');
    var iconImg = null;
    var LIMIT = { logo: 400000, 'icon-512': 400000, 'icon-192': 150000, 'icon-180': 150000, 'icon-32': 30000 };
    var bytes = function (d) { return Math.floor(((d.length - d.indexOf(',') - 1) * 3) / 4); };

    function load(file, done) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { done(img); URL.revokeObjectURL(url); };
      img.onerror = function () { URL.revokeObjectURL(url); window.alert('That file could not be opened as an image. Try a PNG or JPEG.'); };
      img.src = url;
    }
    function size(img) {
      // Some SVGs have no width or height of their own.
      return { w: img.naturalWidth || 600, h: img.naturalHeight || 200 };
    }
    function encode(canvas, types, max) {
      for (var i = 0; i < types.length; i++) {
        var qs = types[i] === 'image/png' ? [1] : [0.92, 0.85, 0.75, 0.6];
        for (var k = 0; k < qs.length; k++) {
          var d = canvas.toDataURL(types[i], qs[k]);
          // Browsers that can't write WebP quietly return PNG instead; the prefix check catches that.
          if (d.indexOf('data:' + types[i] + ';') === 0 && bytes(d) <= max) return d;
        }
      }
      return null;
    }
    function setValue(name, data) {
      var input = form.querySelector('[data-brand-value="' + name + '"]');
      if (input) input.value = data;
    }

    var logoFile = form.querySelector('[data-brand-file="logo"]');
    if (logoFile) logoFile.addEventListener('change', function () {
      var file = logoFile.files && logoFile.files[0];
      if (!file) return;
      load(file, function (img) {
        var s = size(img);
        var scale = Math.min(1, 800 / s.w, 240 / s.h);
        if (s.w * scale < 120) scale = Math.min(800 / s.w, 240 / s.h); // tiny files (and most SVGs) scale up
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(s.w * scale));
        c.height = Math.max(1, Math.round(s.h * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var data = encode(c, ['image/webp', 'image/png'], LIMIT.logo);
        if (!data) { window.alert('That logo is still too large after resizing. Try a simpler image.'); return; }
        setValue('logo', data);
        var prev = form.querySelector('[data-brand-preview="logo"]');
        var empty = form.querySelector('[data-brand-empty="logo"]');
        if (prev) { prev.src = data; prev.hidden = false; }
        if (empty) empty.hidden = true;
      });
    });

    function renderIcons() {
      if (!iconImg) return;
      var s = size(iconImg);
      var out = {};
      [512, 192, 180, 32].forEach(function (px) {
        var c = document.createElement('canvas');
        c.width = c.height = px;
        var ctx = c.getContext('2d');
        // Phones show transparent icons on black or white, so the icon gets a solid background.
        ctx.fillStyle = (bgInput && bgInput.value) || '#ffffff';
        ctx.fillRect(0, 0, px, px);
        var room = px * (padInput && padInput.checked && px > 32 ? 0.78 : 1);
        var scale = Math.min(room / s.w, room / s.h);
        var w = s.w * scale, h = s.h * scale;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(iconImg, (px - w) / 2, (px - h) / 2, w, h);
        out['icon-' + px] = c.toDataURL('image/png');
      });
      for (var name in out) {
        if (bytes(out[name]) > LIMIT[name]) { window.alert('That icon is too detailed to save. Try a simpler image.'); return; }
      }
      for (var n in out) setValue(n, out[n]);
      var prev = form.querySelector('[data-brand-preview="icon"]');
      if (prev) prev.src = out['icon-192'];
    }
    var iconFile = form.querySelector('[data-brand-file="icon"]');
    if (iconFile) iconFile.addEventListener('change', function () {
      var file = iconFile.files && iconFile.files[0];
      if (file) load(file, function (img) { iconImg = img; renderIcons(); });
    });
    if (bgInput) bgInput.addEventListener('input', renderIcons);
    if (padInput) padInput.addEventListener('change', renderIcons);
  });

  // Tech app: installable on the home screen
  if ('serviceWorker' in navigator && document.querySelector('link[rel="manifest"]')) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { /* optional */ });
  }
})();
