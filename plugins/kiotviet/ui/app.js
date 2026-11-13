// Màn hình KiotViet. Chỉ dùng window.nsa; chữ hiển thị đều qua textContent (dữ liệu hàng / khách là của người khác).
(function () {
  var $ = function (id) {
    return document.getElementById(id);
  };
  function el(tag, props, children) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else n.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) {
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  var TOOLS = [
    'Đọc: chi nhánh, nhóm hàng, hàng hóa (kèm tồn kho), đơn đặt hàng, hóa đơn, khách hàng và nhóm khách, phiếu nhập hàng, sổ quỹ.',
    'Ghi (không hỏi): thêm khách hàng mới.',
    'LUÔN HỎI BẠN TRƯỚC: tạo đơn đặt hàng (có thể tạo luôn hóa đơn), xoá đơn đặt hàng.',
  ];
  function money(n) {
    return typeof n === 'number' ? n.toLocaleString('vi-VN') + ' ₫' : '';
  }
  function draw(s) {
    var conn = $('conn');
    var b = $('banners');
    b.textContent = '';
    $('cid').value = s.clientId || '';
    $('ret').value = s.retailer || '';
    if (!s.configured || !s.hasSecret) {
      conn.textContent = 'Chưa cấu hình';
      conn.className = 'pill bad';
      b.appendChild(
        el('div', { class: 'banner err' }, [
          el('strong', { text: 'Chưa kết nối KiotViet. ' }),
          'Cần ba thứ:',
          el('ol', {}, [
            el('li', {
              text: 'KiotViet → Thiết lập cửa hàng (tài khoản admin) → Thiết lập kết nối API: lấy Client ID và Mã bảo mật (Client Secret).',
            }),
            el('li', {
              text: 'Nhập Client ID và tên gian hàng (Retailer) ở khung "Kết nối" bên dưới.',
            }),
            el('li', {
              text: 'App Store → Quản lý → KiotViet → mục "Bí mật" → dán Client Secret. NSA cất trong kho khoá của hệ điều hành; plugin không đọc được.',
            }),
          ]),
        ]),
      );
    } else if (s.connected === false) {
      conn.textContent = 'Lỗi kết nối';
      conn.className = 'pill bad';
      b.appendChild(el('div', { class: 'banner err', text: s.error || 'Không kết nối được.' }));
    } else {
      conn.textContent = 'Đã kết nối: ' + s.retailer;
      conn.className = 'pill ok';
    }
    b.appendChild(
      el('div', {
        class: 'banner warn',
        text: '⚠ Plugin chưa được thử với gian hàng KiotViet thật. Tên hàng, ghi chú, tên khách do người khác nhập có thể dụ agent làm điều có hại; tạo / xoá đơn luôn hỏi bạn.',
      }),
    );
    var br = $('branches');
    br.textContent =
      s.branches && s.branches.length
        ? s.branches
            .map(function (x) {
              return x.name + ' (#' + x.id + ')';
            })
            .join(' · ')
        : '—';
    var inv = $('invoices');
    inv.textContent = '';
    if (!s.invoices || !s.invoices.length)
      inv.appendChild(el('div', { class: 'muted', text: 'Chưa có dữ liệu.' }));
    (s.invoices || []).forEach(function (i) {
      inv.appendChild(
        el('div', { class: 'card' }, [
          el('strong', { text: i.code }),
          el('span', {
            class: 'muted',
            text:
              ' · ' +
              (i.at ? new Date(i.at).toLocaleString('vi-VN') : '') +
              ' · ' +
              (i.customer || 'Khách lẻ') +
              ' · ',
          }),
          money(i.total),
        ]),
      );
    });
  }
  function drawLog(items) {
    var box = $('log');
    box.textContent = '';
    if (!items.length) box.appendChild(el('div', { class: 'muted', text: 'Chưa có lần gọi nào.' }));
    items.forEach(function (e) {
      box.appendChild(
        el('div', { class: 'card' }, [
          el('span', { class: 'muted', text: new Date(e.at).toLocaleString('vi-VN') + ' · ' }),
          el('strong', { text: e.tool }),
          el('span', {
            class: e.ok ? 'muted' : 'bad',
            text: ' — ' + (e.ok ? 'xong' : 'lỗi: ' + e.detail),
          }),
        ]),
      );
    });
  }
  function load() {
    nsa.call('overview').then(draw, function (e) {
      $('conn').textContent = String(e.message || e);
    });
    nsa.call('log').then(drawLog, function () {});
  }
  function save(id, input) {
    nsa.call('saveConfig', { id: id, value: input.value }).then(load, function (e) {
      $('conn').textContent = String(e.message || e);
    });
  }
  var tools = $('tools');
  TOOLS.forEach(function (t) {
    tools.appendChild(el('div', { text: t }));
  });
  $('save-cid').addEventListener('click', function () {
    save('client_id', $('cid'));
  });
  $('save-ret').addEventListener('click', function () {
    save('retailer', $('ret'));
  });
  $('refresh').addEventListener('click', load);
  $('clear').addEventListener('click', function () {
    nsa.call('clearLog').then(load);
  });
  load();
})();
