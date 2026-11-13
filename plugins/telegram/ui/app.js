// Màn hình dùng chung của plugin kênh chat. Chỉ dùng window.nsa (call / on); mọi chữ hiển thị đều
// đi qua textContent — dữ liệu từ nhóm chat là của người lạ, không bao giờ chèn thành HTML.
(function () {
  var $ = function (id) {
    return document.getElementById(id);
  };
  var state = null;
  var tab = 'groups';
  var selected = null;
  var busy = false;

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') node.className = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), props[k]);
        else if (props[k] !== undefined && props[k] !== null) node.setAttribute(k, props[k]);
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
  function time(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString('vi-VN');
  }
  var MODE_LABEL = {
    off: 'Tắt (chưa làm gì)',
    watch: 'Canh (không gửi)',
    reply: 'Trả lời đúng nội quy',
  };

  function refresh() {
    return nsa.call('overview').then(function (s) {
      state = s;
      draw();
    }, fail);
  }

  function draw() {
    if (!state) return;
    document.title = state.label;
    $('title').textContent = state.label;
    $('logo').setAttribute('src', '../' + (state.icon || 'icon.svg'));
    var conn = $('conn');
    if (state.missingSecrets.length) {
      conn.textContent = 'Chưa nhập khoá';
      conn.className = 'pill bad';
    } else if (state.lastError) {
      conn.textContent = 'Lỗi kết nối';
      conn.className = 'pill bad';
    } else if (state.me) {
      conn.textContent = 'Đã kết nối: ' + (state.me.name || state.me.id);
      conn.className = 'pill ok';
    } else {
      conn.textContent = 'Đang kết nối…';
      conn.className = 'pill';
    }
    $('tick').textContent = 'Lần kiểm tra cuối: ' + time(state.lastTick);

    var b = $('banners');
    b.textContent = '';
    if (state.warning)
      b.appendChild(el('div', { class: 'banner warn', text: '⚠ ' + state.warning }));
    if (state.missingSecrets.length) {
      b.appendChild(
        el('div', { class: 'banner err' }, [
          el('strong', { text: 'Chưa nhập khoá (token). ' }),
          'Mở App Store → Quản lý → ' +
            state.label +
            ' → mục "Bí mật" để nhập. Plugin không bao giờ đọc được khoá — NSA cất trong kho khoá của hệ điều hành.',
          el(
            'ol',
            null,
            state.setup.map(function (s) {
              return el('li', { text: s });
            }),
          ),
        ]),
      );
    } else if (state.lastError) {
      b.appendChild(el('div', { class: 'banner err', text: state.lastError }));
    }
    if (!state.hasModel) {
      b.appendChild(
        el('div', {
          class: 'banner warn',
          text: 'Plugin chưa được cấp quyền dùng model — bot chỉ gom tin, chưa trả lời được. Bật ở Quản lý → Quyền.',
        }),
      );
    }

    var tabs = $('tabs');
    tabs.textContent = '';
    [
      ['groups', 'Nhóm'],
      ['rules', 'Nội quy chung'],
      ['recent', 'Tin gần đây'],
      ['log', 'Nhật ký'],
      ['settings', 'Cài đặt'],
    ].forEach(function (t) {
      tabs.appendChild(
        el('button', {
          class: tab === t[0] ? 'on' : '',
          type: 'button',
          text: t[1],
          onclick: function () {
            tab = t[0];
            say('');
            draw();
          },
        }),
      );
    });
    ({
      groups: drawGroups,
      rules: drawGeneralRules,
      recent: drawRecent,
      log: drawLog,
      settings: drawSettings,
    })[tab]();
  }

  // ---------------------------------------------------------------- Nhóm + nội quy từng nhóm
  function drawGroups() {
    var v = $('view');
    v.textContent = '';
    if (!state.groups.length) {
      v.appendChild(
        el('p', {
          class: 'muted',
          text: 'Chưa thấy nhóm nào. Thêm bot vào nhóm rồi nhắn một tin ở đó; sau đó bấm "Kiểm tra ngay". Nhóm mới luôn ở chế độ Tắt cho tới khi bạn bật.',
        }),
      );
      return;
    }
    var rows = state.groups.map(function (g) {
      var sel = el('select', {
        onchange: function (e) {
          e.stopPropagation();
          nsa.call('setMode', { id: g.id, mode: e.target.value }).then(function (s) {
            state = Object.assign({}, state, s);
            draw();
          }, fail);
        },
        onclick: function (e) {
          e.stopPropagation();
        },
      });
      ['off', 'watch', 'reply'].forEach(function (m) {
        var o = el('option', { value: m, text: MODE_LABEL[m] });
        if (g.mode === m) o.selected = true;
        sel.appendChild(o);
      });
      return el(
        'tr',
        {
          class: 'pick' + (selected === g.id ? ' sel' : ''),
          onclick: function () {
            selected = g.id;
            draw();
          },
        },
        [
          el('td', null, [g.name, el('div', { class: 'muted', text: g.id })]),
          el('td', { text: g.kind === 'private' ? 'Riêng' : 'Nhóm' }),
          el('td', null, [sel]),
          el('td', { text: String(g.seen || 0) }),
          el('td', { text: String(g.queued || 0) }),
        ],
      );
    });
    var table = el('table', null, [
      el('thead', null, [
        el(
          'tr',
          null,
          ['Tên', 'Loại', 'Chế độ', 'Tin đã thấy', 'Chờ xử lý'].map(function (h) {
            return el('th', { text: h });
          }),
        ),
      ]),
      el('tbody', null, rows),
    ]);
    var left = el('div', null, [table]);
    var right = el('div', { id: 'detail' });
    v.appendChild(el('div', { class: 'grid2' }, [left, right]));
    if (selected) drawGroupDetail(right);
    else
      right.appendChild(
        el('p', { class: 'muted', text: 'Chọn một nhóm để xem và sửa nội quy của nó.' }),
      );
  }

  function drawGroupDetail(box) {
    var g = state.groups.filter(function (x) {
      return x.id === selected;
    })[0];
    if (!g) return;
    box.appendChild(el('h2', { text: 'Nội quy của "' + g.name + '"' }));
    var saved = el('div', { text: 'Đang tải…', class: 'muted' });
    box.appendChild(saved);
    nsa.call('rules', { scope: 'group', id: g.id }).then(
      function (r) {
        saved.textContent = '';
        saved.className = '';
        if (!r.notes.length) {
          saved.appendChild(
            el('p', {
              class: 'muted',
              text: 'Chưa có nội quy đã duyệt cho nhóm này (chỉ áp dụng nội quy chung).',
            }),
          );
        }
        r.notes.forEach(function (n) {
          saved.appendChild(
            el('div', { class: 'card' }, [el('strong', { text: n.title }), '\n' + n.body]),
          );
        });
      },
      function (e) {
        saved.textContent = String(e.message || e);
      },
    );
    var area = el('textarea', {
      placeholder: 'Ví dụ: Không quảng cáo. Luôn trả lời tiếng Việt. Không bàn chính trị…',
    });
    box.appendChild(area);
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          class: 'primary',
          type: 'button',
          text: 'Đề xuất nội quy này',
          onclick: function () {
            nsa.call('saveRule', { scope: 'group', id: g.id, body: area.value }).then(function (r) {
              say(
                r.status === 'accepted'
                  ? 'Đã lưu nội quy.'
                  : 'Đã đưa vào Hộp duyệt (Bộ nhớ). Bot chỉ theo nội quy sau khi bạn duyệt.',
              );
              area.value = '';
              draw();
            }, fail);
          },
        }),
      ]),
    );
    box.appendChild(el('h2', { text: 'Thử trả lời (không gửi gì)' }));
    var probe = el('input', {
      placeholder: 'Dán một tin nhắn mẫu, ví dụ: "ai bán hàng giá rẻ ib mình"',
      style: 'width:100%',
    });
    var out = el('div', { class: 'card muted', text: 'Kết quả hiện ở đây.' });
    box.appendChild(probe);
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          class: 'ghost',
          type: 'button',
          text: 'Bot sẽ nói gì?',
          onclick: function () {
            out.textContent = 'Đang hỏi model…';
            nsa.call('dryRun', { id: g.id, text: probe.value }).then(
              function (r) {
                out.className = 'card';
                var lines = [
                  'Nội quy dùng: ' + (r.rules.length ? r.rules.join('; ') : '(chưa có)'),
                ];
                if (!r.replies.length) lines.push('→ Bot im lặng.');
                r.replies.forEach(function (x) {
                  lines.push('→ Bot trả lời: ' + x.text);
                });
                r.violations.forEach(function (x) {
                  lines.push('⚑ ' + x.user + ' vi phạm: ' + x.rule + ' (' + x.action + ')');
                });
                if (r.error) lines.push('Lưu ý: ' + r.error);
                out.textContent = lines.join('\n');
              },
              function (e) {
                out.textContent = String(e.message || e);
              },
            );
          },
        }),
      ]),
    );
    box.appendChild(out);
  }

  // ---------------------------------------------------------------- Nội quy chung / theo nick
  function ruleEditor(title, scope, hint) {
    var box = el('div', null, [el('h2', { text: title })]);
    var saved = el('div', { class: 'muted', text: 'Đang tải…' });
    box.appendChild(saved);
    nsa.call('rules', { scope: scope }).then(
      function (r) {
        saved.textContent = '';
        saved.className = '';
        if (!r.notes.length)
          saved.appendChild(el('p', { class: 'muted', text: 'Chưa có mục đã duyệt.' }));
        r.notes.forEach(function (n) {
          saved.appendChild(
            el('div', { class: 'card' }, [el('strong', { text: n.title }), '\n' + n.body]),
          );
        });
      },
      function (e) {
        saved.textContent = String(e.message || e);
      },
    );
    var area = el('textarea', { placeholder: hint });
    box.appendChild(area);
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          class: 'primary',
          type: 'button',
          text: 'Đề xuất',
          onclick: function () {
            nsa.call('saveRule', { scope: scope, body: area.value }).then(function (r) {
              say(
                r.status === 'accepted'
                  ? 'Đã lưu.'
                  : 'Đã đưa vào Hộp duyệt (Bộ nhớ) — duyệt xong bot mới theo.',
              );
              area.value = '';
              draw();
            }, fail);
          },
        }),
      ]),
    );
    return box;
  }
  function drawGeneralRules() {
    var v = $('view');
    v.textContent = '';
    v.appendChild(
      el('p', {
        class: 'muted',
        text: 'Nội quy là mục nhớ trong NSA Mem (nhánh riêng của plugin). Điều bạn đề xuất ở đây nằm trong Hộp duyệt cho tới khi bạn duyệt — để người lạ trong nhóm không thể tự dạy bot.',
      }),
    );
    v.appendChild(
      ruleEditor(
        'Quy tắc chung (mọi nhóm)',
        'general',
        'Ví dụ: Xưng "mình", giọng thân thiện, không hứa hẹn giá…',
      ),
    );
    v.appendChild(
      ruleEditor(
        'Quy tắc theo tài khoản (nick) ' +
          (state.me ? '"' + (state.me.name || state.me.id) + '"' : ''),
        'nick',
        'Quy tắc chỉ áp dụng cho tài khoản này…',
      ),
    );
  }

  // ---------------------------------------------------------------- Tin gần đây / nhật ký / cài đặt
  function drawRecent() {
    var v = $('view');
    v.textContent = '';
    v.appendChild(
      el('p', {
        class: 'muted',
        text: 'Chỉ lưu tin của nhóm đang ở chế độ Canh hoặc Trả lời; nhóm Tắt thì không lưu gì. Dữ liệu nằm trên máy bạn.',
      }),
    );
    var holder = el('div');
    v.appendChild(holder);
    nsa.call('recent', selected ? { id: selected } : {}).then(function (items) {
      if (!items.length) holder.appendChild(el('p', { class: 'muted', text: 'Chưa có tin nào.' }));
      items.forEach(function (m) {
        holder.appendChild(
          el('div', { class: 'card' }, [
            el('span', {
              class: 'muted',
              text: time(m.at) + ' · ' + m.groupName + ' · ' + m.from + '\n',
            }),
            m.text,
          ]),
        );
      });
    }, fail);
  }
  function drawLog() {
    var v = $('view');
    v.textContent = '';
    var holder = el('div');
    v.appendChild(holder);
    nsa.call('log', { limit: 100 }).then(function (items) {
      if (!items.length) holder.appendChild(el('p', { class: 'muted', text: 'Chưa có gì.' }));
      items.forEach(function (e) {
        holder.appendChild(
          el('div', { class: 'card lv-' + e.level }, [
            el('span', {
              class: 'muted',
              text: time(e.at) + ' · ' + e.kind + (e.group ? ' · ' + e.group : '') + '\n',
            }),
            e.text,
          ]),
        );
      });
    }, fail);
  }
  function drawSettings() {
    var v = $('view');
    v.textContent = '';
    var s = state.settings;
    var fields = [
      ['batchSeconds', 'Gom tin tối thiểu (giây) trước khi gọi model cho một nhóm'],
      ['batchMax', 'Đủ bấy nhiêu tin thì xử lý ngay'],
      ['urgentSeconds', 'Tin nhắc tên bot / nhắn riêng: chờ (giây)'],
      ['maxCallsPerGroupHour', 'Trần số lần gọi model mỗi nhóm mỗi giờ'],
    ];
    var inputs = {};
    fields.forEach(function (f) {
      inputs[f[0]] = el('input', { type: 'number', value: String(s[f[0]]), style: 'width:90px' });
      v.appendChild(el('div', { class: 'row' }, [inputs[f[0]], el('span', { text: f[1] })]));
    });
    v.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          class: 'primary',
          type: 'button',
          text: 'Lưu cài đặt',
          onclick: function () {
            var p = {};
            fields.forEach(function (f) {
              p[f[0]] = inputs[f[0]].value;
            });
            nsa.call('saveSettings', p).then(function (r) {
              state = Object.assign({}, state, r);
              say('Đã lưu.');
            }, fail);
          },
        }),
      ]),
    );
    var dm = el('select');
    [
      ['off', 'Hội thoại riêng mới: Tắt (khuyên dùng)'],
      ['watch', 'Hội thoại riêng mới: Canh (không gửi)'],
      ['reply', 'Hội thoại riêng mới: Tự trả lời'],
    ].forEach(function (o) {
      var op = el('option', { value: o[0], text: o[1] });
      if ((s.defaultModePrivate || 'off') === o[0]) op.selected = true;
      dm.appendChild(op);
    });
    dm.addEventListener('change', function () {
      nsa.call('saveSettings', { defaultModePrivate: dm.value }).then(function () {
        say('Đã lưu.');
      }, fail);
    });
    v.appendChild(el('div', { class: 'row' }, [dm]));
    (state.configFields || []).forEach(function (f) {
      var input = el('input', {
        value: state.configValues[f.id] || '',
        placeholder: f.placeholder || '',
        style: 'width:260px',
      });
      v.appendChild(el('h2', { text: f.label }));
      if (f.help) v.appendChild(el('p', { class: 'muted', text: f.help }));
      v.appendChild(
        el('div', { class: 'row' }, [
          input,
          el('button', {
            class: 'ghost',
            type: 'button',
            text: 'Lưu',
            onclick: function () {
              nsa.call('saveConfig', { id: f.id, value: input.value }).then(function () {
                say('Đã lưu. Bấm "Kiểm tra ngay" để kết nối lại.');
              }, fail);
            },
          }),
        ]),
      );
    });
    v.appendChild(
      el('p', {
        class: 'muted',
        text: 'Bot gom tin theo lô: mỗi nhóm mỗi lượt chỉ gọi model MỘT lần cho cả lô, không gọi từng tin.',
      }),
    );
  }

  $('refresh').addEventListener('click', function () {
    if (busy) return;
    busy = true;
    say('Đang kiểm tra…');
    nsa
      .call('runNow')
      .then(function (s) {
        state = Object.assign({}, state, s);
        say('Xong.');
        return refresh();
      }, fail)
      .then(function () {
        busy = false;
      });
  });
  nsa.on('state', function (s) {
    if (!state) return;
    state = Object.assign({}, state, s);
    if (tab === 'groups') draw();
  });
  refresh();
})();
