// Màn hình Knowledge Base. Chỉ dùng window.nsa (call / on). Mọi chữ hiển thị đi qua textContent —
// nội dung tài liệu là dữ liệu của người khác, không bao giờ chèn thành HTML.
(function () {
  'use strict';
  var $ = function (id) {
    return document.getElementById(id);
  };
  var state = null;
  var pending = [];
  var tab = 'sources';
  var selected = {};
  var open = {}; // thẻ đang mở phần đối chiếu / sửa
  var uploading = null;
  var KIND = { doc: '📄', image: '🖼️', video: '🎬', audio: '🎧' };
  var STATUS = {
    estimating: 'Đang ước tính…',
    awaiting: 'Chờ bạn duyệt chạy',
    queued: 'Trong hàng đợi',
    running: 'Đang học',
    paused: 'Tạm dừng',
    ingested: 'Đã học xong',
    failed: 'Lỗi',
    cancelled: 'Đã huỷ',
  };
  var EXT =
    /\.(pdf|docx|xlsx|csv|tsv|txt|md|markdown|log|json|html?|png|jpe?g|webp|gif|mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a|ogg|flac|aac)$/i;

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function say(text, bad) {
    var m = $('msg');
    m.textContent = text || '';
    m.style.color = bad ? 'var(--red)' : '';
  }
  function fail(err) {
    say(String((err && err.message) || err), true);
  }
  function bytes(n) {
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }
  function money(usd) {
    return usd === null || usd === undefined
      ? 'chưa biết giá'
      : '≈ $' + usd.toFixed(usd < 0.1 ? 4 : 2);
  }
  // Khung plugin chạy với sandbox="allow-scripts": confirm() / alert() bị chặn, nên hỏi ngay trong trang.
  function ask(text, yesLabel, noLabel) {
    return new Promise(function (resolve) {
      var box = $('ask');
      clear(box);
      function close(v) {
        box.classList.add('hidden');
        resolve(v);
      }
      box.appendChild(el('div', { text: text }));
      box.appendChild(
        el('div', { class: 'row' }, [
          el('button', {
            class: 'primary small',
            text: yesLabel,
            onclick: function () {
              close(true);
            },
          }),
          el('button', {
            class: 'small',
            text: noLabel,
            onclick: function () {
              close(false);
            },
          }),
        ]),
      );
      box.classList.remove('hidden');
      box.scrollIntoView({ block: 'center' });
    });
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---------------------------------------------------------------- tải dữ liệu

  function refresh() {
    return Promise.all([nsa.call('overview'), nsa.call('pending')]).then(
      function (r) {
        state = r[0];
        pending = r[1];
        draw();
      },
      function (err) {
        // Plugin vừa bật / khởi động lại: thử lại sau ít giây thay vì báo lỗi ngay.
        if (!state) {
          say('Plugin đang khởi động…');
          setTimeout(refresh, 1500);
        } else fail(err);
      },
    );
  }
  var timer = null;
  function soon() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  }
  nsa.on('changed', soon);
  nsa.on('download', function (d) {
    $('dl').textContent =
      'Đang tải model ' +
      d.name +
      ': ' +
      bytes(d.done) +
      ' / ' +
      bytes(d.total) +
      ' (' +
      Math.round((d.done * 100) / d.total) +
      '%)';
  });

  // ---------------------------------------------------------------- vẽ

  function draw() {
    if (!state) return;
    $('pPending').textContent = state.pendingTotal + ' chờ duyệt';
    $('pPending').className = 'pill' + (state.pendingTotal ? ' warn' : '');
    $('pAccepted').textContent = state.acceptedTotal + ' đã nhớ';
    var running = state.sources.filter(function (s) {
      return s.status === 'running';
    }).length;
    var queued = state.sources.filter(function (s) {
      return s.status === 'queued';
    }).length;
    var q = $('pQueue');
    q.textContent = state.queuePaused
      ? 'Hàng đợi đang tạm dừng'
      : running || queued
        ? 'Đang chạy ' + running + ' · chờ ' + queued
        : 'Hàng đợi rảnh';
    q.className = 'pill' + (state.queuePaused ? ' warn' : running ? ' ok' : '');
    $('btnPauseAll').textContent = state.queuePaused ? 'Tiếp tục hàng đợi' : 'Tạm dừng hàng đợi';
    $('tabCount').textContent = state.pendingTotal ? '(' + state.pendingTotal + ')' : '';
    drawSources();
    drawEstimate();
    drawTrash();
    if (tab === 'review') drawReview();
  }

  function drawEstimate() {
    var box = $('estimate');
    clear(box);
    var waiting = state.sources.filter(function (s) {
      return s.status === 'awaiting';
    });
    if (!waiting.length) return;
    var calls = 0;
    var tokens = 0;
    var usd = 0;
    var unknown = false;
    var label = '';
    waiting.forEach(function (s) {
      var e = s.estimate || {};
      calls += e.calls || 0;
      tokens += (e.inputTokens || 0) + (e.outputTokens || 0);
      if (e.usd === null || e.usd === undefined) unknown = true;
      else usd += e.usd;
      label = e.label || label;
      if (e.budget && e.budget.level === 'over') unknown = true;
    });
    var lines = [
      el('strong', { text: 'Cần bạn đồng ý trước khi chạy ' + waiting.length + ' nguồn: ' }),
      document.createTextNode(
        calls +
          ' lượt gọi model nhìn ảnh' +
          (label ? ' (' + label + ')' : '') +
          ', khoảng ' +
          tokens.toLocaleString('vi-VN') +
          ' token, ' +
          (unknown ? 'chưa biết giá' : money(usd)) +
          '. ',
      ),
      el('button', {
        class: 'primary small',
        text: 'Chạy',
        onclick: function () {
          nsa
            .call('approve', {
              ids: waiting.map(function (s) {
                return s.id;
              }),
            })
            .then(refresh, fail);
        },
      }),
      document.createTextNode(' '),
      el('button', {
        class: 'small',
        text: 'Bỏ',
        onclick: function () {
          waiting.forEach(function (s) {
            nsa.call('cancel', { id: s.id }).then(refresh, fail);
          });
        },
      }),
    ];
    box.appendChild(el('div', { class: 'banner info' }, lines));
  }

  function drawTrash() {
    var box = $('trash');
    clear(box);
    var t = state.trash[0];
    if (!t) return;
    box.appendChild(
      el('div', { class: 'banner warn' }, [
        document.createTextNode('Vừa xoá “' + t.name + '” (' + t.entries + ' mục nhớ đã gỡ). '),
        el('button', {
          class: 'small',
          text: 'Hoàn tác',
          onclick: function () {
            nsa.call('undoRemove').then(function (r) {
              say('Đã khôi phục “' + r.name + '” và ' + r.restored + ' mục nhớ.');
              refresh();
            }, fail);
          },
        }),
      ]),
    );
  }

  function btn(text, cls, fn, title) {
    return el('button', { class: 'small ' + (cls || ''), text: text, title: title, onclick: fn });
  }

  function drawSources() {
    var body = document.querySelector('#sources tbody');
    clear(body);
    $('empty').classList.toggle('hidden', state.sources.length > 0);
    state.sources.forEach(function (s) {
      var prog = s.progress || { done: 0, total: 0, label: '' };
      var pct = prog.total ? Math.min(100, Math.round((prog.done * 100) / prog.total)) : 0;
      var status = el('td', {}, [
        el('span', {
          class:
            'pill' +
            (s.status === 'failed'
              ? ' bad'
              : s.status === 'ingested'
                ? ' ok'
                : s.status === 'awaiting'
                  ? ' warn'
                  : ''),
          text: STATUS[s.status] || s.status,
        }),
        s.status === 'running' || s.status === 'paused'
          ? el('div', { class: 'bar' }, [el('i', { style: 'width:' + pct + '%' })])
          : null,
        s.status === 'running' || s.status === 'paused'
          ? el('div', { class: 'hint', text: prog.label || '' })
          : null,
      ]);
      var info = el(
        'td',
        {},
        [
          el('div', {}, [
            el('span', { text: (KIND[s.kind] || '•') + ' ' }),
            el('strong', { text: s.name }),
          ]),
          el('div', {
            class: 'hint',
            text: [
              bytes(s.size),
              s.duration ? Math.round(s.duration) + ' giây' : '',
              s.note ? '“' + s.note + '”' : '',
            ]
              .filter(Boolean)
              .join(' · '),
          }),
          s.error ? el('div', { class: 'err-line', text: s.error }) : null,
        ].concat(
          (s.warnings || []).map(function (w) {
            return el('div', { class: 'warn-line', text: '⚠ ' + w });
          }),
        ),
      );
      var counts = el('td', {}, [
        el('div', { text: s.accepted + ' đã nhớ' }),
        s.pending
          ? el('div', {}, [
              el('a', {
                href: '#',
                text: s.pending + ' chờ duyệt',
                onclick: function (e) {
                  e.preventDefault();
                  $('reviewFilter').dataset.want = s.id;
                  setTab('review');
                },
              }),
            ])
          : null,
      ]);
      var actions = [];
      if (s.status === 'running' || s.status === 'queued')
        actions.push(
          btn(
            '⏸',
            '',
            function () {
              nsa.call('pause', { id: s.id }).then(refresh, fail);
            },
            'Tạm dừng',
          ),
        );
      if (s.status === 'paused')
        actions.push(
          btn(
            '▶',
            '',
            function () {
              nsa.call('resume', { id: s.id }).then(refresh, fail);
            },
            'Tiếp tục',
          ),
        );
      if (s.status === 'failed')
        actions.push(
          btn('Thử lại', '', function () {
            nsa.call('resume', { id: s.id }).then(refresh, fail);
          }),
        );
      if (['running', 'queued', 'paused', 'awaiting'].indexOf(s.status) >= 0)
        actions.push(
          btn(
            '✕',
            '',
            function () {
              nsa.call('cancel', { id: s.id }).then(refresh, fail);
            },
            'Huỷ',
          ),
        );
      if (s.canUndoStale)
        actions.push(
          btn('Hoàn tác gỡ', '', function () {
            nsa.call('undoStale', { id: s.id }).then(function () {
              say('Đã khôi phục các mục đã gỡ.');
              refresh();
            }, fail);
          }),
        );
      actions.push(
        btn(
          '🗑',
          'danger',
          function () {
            ask(
              'Xoá “' +
                s.name +
                '”? Các mục nhớ sinh ra từ nguồn này cũng bị gỡ (hoàn tác được ngay sau đó).',
              'Xoá nguồn',
              'Giữ lại',
            ).then(function (yes) {
              if (!yes) return;
              nsa.call('remove', { id: s.id }).then(function (r) {
                say('Đã xoá nguồn và gỡ ' + r.removed + ' mục nhớ.');
                refresh();
              }, fail);
            });
          },
          'Xoá nguồn và các mục nhớ của nó',
        ),
      );
      body.appendChild(
        el('tr', {}, [
          info,
          el('td', { text: s.collection }),
          status,
          counts,
          el('td', {}, actions),
        ]),
      );
    });
  }

  // ---------------------------------------------------------------- duyệt

  function drawReview() {
    var filter = $('reviewFilter');
    var want = filter.dataset.want || filter.value || '';
    delete filter.dataset.want;
    clear(filter);
    filter.appendChild(el('option', { value: '', text: 'Tất cả nguồn (' + pending.length + ')' }));
    var seen = {};
    pending.forEach(function (p) {
      if (seen[p.sourceId]) return;
      seen[p.sourceId] = true;
      var n = pending.filter(function (x) {
        return x.sourceId === p.sourceId;
      }).length;
      filter.appendChild(el('option', { value: p.sourceId, text: p.sourceName + ' (' + n + ')' }));
    });
    filter.value = want && seen[want] ? want : '';
    var list = pending.filter(function (p) {
      return !filter.value || p.sourceId === filter.value;
    });
    $('noCards').classList.toggle('hidden', list.length > 0);
    var cards = $('cards');
    clear(cards);
    list.forEach(function (p) {
      cards.appendChild(card(p));
    });
    var n = Object.keys(selected).filter(function (k) {
      return selected[k];
    }).length;
    $('selCount').textContent = n ? n + ' mục đã chọn' : '';
  }

  function done(msg) {
    say(msg);
    return refresh();
  }

  function card(p) {
    var st = open[p.id] || {};
    var head = el('div', { class: 'head' }, [
      el('input', {
        type: 'checkbox',
        checked: selected[p.id] ? 'checked' : null,
        onchange: function (e) {
          selected[p.id] = e.target.checked;
          drawReview();
        },
      }),
      el('strong', { text: p.sourceName }),
      el('span', { class: 'pill', text: p.loc || '—' }),
      el('span', { class: 'pill', text: 'tin cậy ' + Math.round(p.confidence * 100) + '%' }),
      p.sensitive
        ? el('span', {
            class: 'pill bad',
            text: '⚠ nhạy cảm: ' + (p.sensitiveWhat.join(', ') || 'đã đánh dấu'),
          })
        : null,
      p.previous !== undefined ? el('span', { class: 'pill warn', text: 'sửa mục đã có' }) : null,
      p.conflicts.length
        ? el('span', {
            class: 'pill warn',
            text:
              'mâu thuẫn với: ' +
              p.conflicts
                .map(function (c) {
                  return c.title;
                })
                .join('; '),
          })
        : null,
    ]);
    var body;
    if (st.edit) {
      var ta = el('textarea', {});
      ta.value = st.text !== undefined ? st.text : p.body;
      ta.addEventListener('input', function () {
        st.text = ta.value;
      });
      body = ta;
    } else {
      body = el('div', { class: 'body', text: p.body });
    }
    var prev =
      p.previous !== undefined
        ? el('div', { class: 'body old', text: 'Bản cũ: ' + p.previous })
        : null;
    var why = p.reasons.length
      ? el('div', { class: 'hint', text: 'Vì sao chờ duyệt: ' + p.reasons.join('; ') })
      : null;
    var acts = el('div', { class: 'row' }, [
      btn('Nhận', 'primary', function () {
        var edits = { id: p.id };
        if (st.edit && st.text !== undefined) edits.body = st.text;
        nsa.call('accept', edits).then(function () {
          done('Đã nhận.');
        }, fail);
      }),
      btn(st.edit ? 'Bỏ sửa' : 'Sửa rồi nhận', '', function () {
        open[p.id] = Object.assign({}, st, { edit: !st.edit, text: st.edit ? undefined : p.body });
        drawReview();
      }),
      p.sensitive
        ? btn('Che số nhạy cảm', '', function () {
            nsa
              .call('mask', { text: st.edit && st.text !== undefined ? st.text : p.body })
              .then(function (m) {
                open[p.id] = Object.assign({}, st, { edit: true, text: m });
                drawReview();
              }, fail);
          })
        : null,
      btn('Từ chối', 'danger', function () {
        nsa.call('reject', { id: p.id }).then(function () {
          done('Đã từ chối.');
        }, fail);
      }),
      btn(st.cmp ? 'Ẩn đối chiếu' : 'Đối chiếu nguồn', '', function () {
        if (st.cmp) {
          open[p.id] = Object.assign({}, st, { cmp: null });
          drawReview();
          return;
        }
        nsa.call('context', { sourceId: p.sourceId, loc: p.loc }).then(function (c) {
          open[p.id] = Object.assign({}, st, { cmp: c });
          drawReview();
        }, fail);
      }),
    ]);
    var cmp = null;
    if (st.cmp) {
      var c = st.cmp;
      var imgs = (c.images || [])
        .filter(function (i) {
          return i.dataUrl;
        })
        .map(function (i) {
          return el('figure', {}, [
            el('img', { src: i.dataUrl, alt: i.label }),
            el('figcaption', { text: i.label }),
          ]);
        });
      cmp = el('div', { class: 'cmp' }, [
        el('div', { class: 'hint', text: 'Đoạn gốc' + (c.range ? ' — ' + c.range : '') }),
        imgs.length ? el('div', { class: 'imgs' }, imgs) : null,
        el('pre', { text: c.text || '' }),
      ]);
    }
    return el('div', { class: 'card' + (p.sensitive ? ' sens' : '') }, [
      head,
      prev,
      body,
      why,
      acts,
      cmp,
    ]);
  }

  // ---------------------------------------------------------------- tải lên

  function readSlice(file, start, end) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        var url = String(r.result);
        resolve(url.slice(url.indexOf(',') + 1));
      };
      r.onerror = function () {
        reject(new Error('Không đọc được file ' + file.name));
      };
      r.readAsDataURL(file.slice(start, end));
    });
  }

  function uploadOne(item) {
    var file = item.file;
    var opts = {
      name: file.name,
      relPath: item.path,
      collection: $('collection').value,
      note: $('note').value,
    };
    return nsa.call('uploadStart', { name: file.name, size: file.size }).then(function (r) {
      var offset = 0;
      var CH = 384 * 1024;
      function next() {
        if (offset >= file.size) {
          return nsa.call('uploadFinish', Object.assign({ uploadId: r.uploadId }, opts));
        }
        var end = Math.min(offset + CH, file.size);
        return readSlice(file, offset, end)
          .then(function (b64) {
            return nsa.call('uploadChunk', { uploadId: r.uploadId, b64: b64 });
          })
          .then(function () {
            offset = end;
            $('upload').textContent =
              'Đang tải “' +
              file.name +
              '” lên: ' +
              Math.round((offset * 100) / file.size) +
              '% (' +
              uploading.done +
              '/' +
              uploading.total +
              ')';
            return next();
          });
      }
      return next();
    });
  }

  function uploadAll(items) {
    var ok = items.filter(function (i) {
      return EXT.test(i.file.name);
    });
    var skipped = items.length - ok.length;
    if (!ok.length) return say('Không có file nào thuộc loại hỗ trợ.', true);
    if (uploading) return say('Đang tải lên, đợi xong rồi thả tiếp.', true);
    uploading = { done: 0, total: ok.length };
    var results = [];
    var chain = Promise.resolve();
    ok.forEach(function (item) {
      chain = chain.then(function () {
        return uploadOne(item)
          .then(
            function (r) {
              results.push(r.status === 'duplicate' ? 'unchanged' : r.status);
            },
            function (err) {
              results.push('lỗi: ' + (err.message || err));
            },
          )
          .then(function () {
            uploading.done++;
            refresh();
          });
      });
    });
    chain.then(function () {
      var unchanged = results.filter(function (r) {
        return r === 'unchanged';
      }).length;
      var errors = results.filter(function (r) {
        return r.indexOf('lỗi') === 0;
      });
      uploading = null;
      $('upload').textContent = '';
      say(
        'Đã thêm ' +
          (results.length - unchanged - errors.length) +
          ' nguồn' +
          (unchanged ? ', ' + unchanged + ' file không đổi (bỏ qua)' : '') +
          (skipped ? ', ' + skipped + ' file loại không hỗ trợ bị bỏ' : '') +
          (errors.length ? '. Lỗi: ' + errors[0] : '') +
          '.',
        errors.length > 0,
      );
      refresh();
    });
  }

  function walkEntry(entry, prefix, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(
          function (f) {
            out.push({ file: f, path: prefix + f.name });
            resolve();
          },
          function () {
            resolve();
          },
        );
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        (function readMore() {
          reader.readEntries(
            function (batch) {
              if (!batch.length) {
                Promise.all(
                  all.map(function (e) {
                    return walkEntry(e, prefix + entry.name + '/', out);
                  }),
                ).then(resolve);
              } else {
                all = all.concat(Array.prototype.slice.call(batch));
                readMore();
              }
            },
            function () {
              resolve();
            },
          );
        })();
      } else resolve();
    });
  }

  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
      e.preventDefault();
      drop.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
      e.preventDefault();
      drop.classList.remove('over');
    });
  });
  drop.addEventListener('drop', function (e) {
    var items = e.dataTransfer && e.dataTransfer.items;
    var out = [];
    if (items && items.length && items[0].webkitGetAsEntry) {
      var entries = Array.prototype.map
        .call(items, function (i) {
          return i.webkitGetAsEntry();
        })
        .filter(Boolean);
      Promise.all(
        entries.map(function (en) {
          return walkEntry(en, '', out);
        }),
      ).then(function () {
        uploadAll(out);
      });
    } else {
      uploadAll(
        Array.prototype.map.call(e.dataTransfer.files, function (f) {
          return { file: f, path: f.name };
        }),
      );
    }
  });
  $('btnFiles').addEventListener('click', function () {
    $('fileInput').click();
  });
  $('btnFolder').addEventListener('click', function () {
    $('folderInput').click();
  });
  $('fileInput').addEventListener('change', function (e) {
    uploadAll(
      Array.prototype.map.call(e.target.files, function (f) {
        return { file: f, path: f.name };
      }),
    );
    e.target.value = '';
  });
  $('folderInput').addEventListener('change', function (e) {
    uploadAll(
      Array.prototype.map.call(e.target.files, function (f) {
        return { file: f, path: f.webkitRelativePath || f.name };
      }),
    );
    e.target.value = '';
  });
  $('btnScan').addEventListener('click', function () {
    say('Đang quét…');
    nsa
      .call('addFolder', {
        folder: 'kho',
        collection: $('collection').value,
        note: $('note').value,
      })
      .then(
        function (r) {
          var err = r.filter(function (x) {
            return x.status === 'error';
          });
          say(
            'Quét xong: ' +
              r.length +
              ' file' +
              (err.length ? ', ' + err.length + ' lỗi (' + err[0].error + ')' : '') +
              '.',
            err.length > 0,
          );
          refresh();
        },
        function (err) {
          fail(
            new Error(
              String(err.message || err) +
                ' — cấp quyền thư mục ở App Store → Quản lý → Knowledge Base → Quyền.',
            ),
          );
        },
      );
  });
  $('btnUrl').addEventListener('click', function () {
    var url = $('url').value.trim();
    if (!url) return;
    say('Đang tải trang…');
    nsa
      .call('addUrl', { url: url, collection: $('collection').value, note: $('note').value })
      .then(function (r) {
        $('url').value = '';
        say(
          r.status === 'unchanged' ? 'Trang này không đổi so với lần nạp trước.' : 'Đã thêm trang.',
        );
        refresh();
      }, fail);
  });

  // ---------------------------------------------------------------- tab, tìm, công cụ

  function setTab(name) {
    tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.classList.toggle('on', b.dataset.tab === name);
    });
    ['sources', 'review', 'find', 'tools'].forEach(function (t) {
      $('tab-' + t).classList.toggle('hidden', t !== name);
    });
    if (name === 'review') drawReview();
    if (name === 'tools') loadTools(true);
  }
  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
    b.addEventListener('click', function () {
      setTab(b.dataset.tab);
    });
  });
  $('reviewFilter').addEventListener('change', drawReview);
  $('btnPauseAll').addEventListener('click', function () {
    nsa.call(state && state.queuePaused ? 'resumeAll' : 'pauseAll').then(refresh, fail);
  });

  function ids(onlyUnsensitive) {
    return pending
      .filter(function (p) {
        return selected[p.id] && (!onlyUnsensitive || !p.sensitive);
      })
      .map(function (p) {
        return p.id;
      });
  }
  $('btnSelAll').addEventListener('click', function () {
    var f = $('reviewFilter').value;
    pending.forEach(function (p) {
      if ((!f || p.sourceId === f) && !p.sensitive) selected[p.id] = true;
    });
    drawReview();
  });
  $('btnAcceptSel').addEventListener('click', function () {
    var chosen = ids(false);
    if (!chosen.length) return say('Chưa chọn mục nào.', true);
    var sens = pending.filter(function (p) {
      return selected[p.id] && p.sensitive;
    }).length;
    var decide = sens
      ? ask(
          sens +
            ' mục đã chọn có thể chứa thông tin nhạy cảm (số thẻ, CCCD, mật khẩu, khoá…). Nhận cả những mục này?',
          'Nhận cả mục nhạy cảm',
          'Chỉ nhận các mục còn lại',
        )
      : Promise.resolve(false);
    decide.then(function (include) {
      nsa.call('acceptMany', { ids: chosen, includeSensitive: include }).then(function (r) {
        selected = {};
        done(
          'Đã nhận ' +
            r.accepted +
            ' mục' +
            (r.skipped ? ', bỏ qua ' + r.skipped + ' mục nhạy cảm' : '') +
            (r.duplicates ? ', ' + r.duplicates + ' mục trùng nội dung đã tự bỏ' : '') +
            '.',
        );
      }, fail);
    });
  });
  $('btnRejectSel').addEventListener('click', function () {
    var chosen = ids(false);
    if (!chosen.length) return say('Chưa chọn mục nào.', true);
    nsa.call('rejectMany', { ids: chosen }).then(function (r) {
      selected = {};
      done('Đã từ chối ' + r.rejected + ' mục.');
    }, fail);
  });

  $('btnFind').addEventListener('click', function () {
    var q = $('q').value.trim();
    if (!q) return;
    $('found').textContent = 'Đang tìm…';
    nsa.call('search', { query: q }).then(
      function (t) {
        $('found').textContent = t;
      },
      function (e) {
        $('found').textContent = String(e.message || e);
      },
    );
  });
  $('q').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btnFind').click();
  });

  function loadTools(force) {
    nsa.call('tools', { force: force }).then(function (t) {
      var box = $('toolStatus');
      clear(box);
      function row(ok, title, detail) {
        box.appendChild(
          el('div', { class: 'banner ' + (ok ? 'info' : 'warn') }, [
            el('strong', { text: (ok ? '✓ ' : '✗ ') + title + '. ' }),
            document.createTextNode(detail || ''),
          ]),
        );
      }
      row(
        t.ffmpeg.ok,
        'ffmpeg (tách khung hình và tiếng từ video)',
        t.ffmpeg.ok ? 'Sẵn sàng.' : t.ffmpeg.hint,
      );
      row(
        t.whisper.ok && !!t.whisperModel,
        'Nhận dạng giọng nói (whisper.cpp)',
        t.whisper.ok
          ? t.whisperModel
            ? 'Sẵn sàng, model: ' + t.whisperModel
            : 'Đã có whisper-cli nhưng chưa tải model — bấm tải bên dưới.'
          : t.whisper.hint,
      );
      row(
        !!t.vision.available,
        'Model nhìn ảnh / video',
        t.vision.available
          ? t.vision.label
          : 'Chưa có. Mở Nhà cung cấp, dán key của hãng có model nhìn ảnh (ví dụ Google AI Studio). Không có thì ảnh không đọc được và video chỉ học từ lời nói.',
      );
      row(
        !!t.embedding.available,
        'Tìm theo nghĩa (embedding)',
        t.embedding.available
          ? t.embedding.label
          : 'Chưa có model embedding — đang tìm theo từ khoá (vẫn dùng được).',
      );
    }, fail);
  }
  Array.prototype.forEach.call(document.querySelectorAll('#models button'), function (b) {
    b.addEventListener('click', function () {
      $('dl').textContent = 'Bắt đầu tải…';
      nsa.call('downloadModel', { name: b.dataset.model }).then(
        function (r) {
          $('dl').textContent = 'Đã tải ' + r.file + '.';
          loadTools(true);
        },
        function (e) {
          $('dl').textContent = '';
          fail(e);
        },
      );
    });
  });
  function loadSettings() {
    nsa.call('settings').then(function (s) {
      $('setAsk').value = s.askAboveUsd;
      $('setFrames').value = s.maxFrames;
      $('setLang').value = s.language;
      $('setAuto').checked = s.autoApprove;
      $('setSemantic').checked = s.semantic === true;
      $('setMin').value = s.minConfidence;
    }, fail);
  }
  $('btnSave').addEventListener('click', function () {
    nsa
      .call('settings', {
        askAboveUsd: Number($('setAsk').value),
        maxFrames: Number($('setFrames').value),
        language: $('setLang').value.trim(),
        autoApprove: $('setAuto').checked,
        semantic: $('setSemantic').checked,
        minConfidence: Number($('setMin').value),
      })
      .then(function () {
        say('Đã lưu cài đặt.');
      }, fail);
  });

  loadSettings();
  refresh();
  setInterval(function () {
    if (
      state &&
      state.sources.some(function (s) {
        return s.status === 'running';
      })
    )
      refresh();
  }, 2500);
})();
